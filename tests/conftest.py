"""Shared test fixtures — V5.2-E E.2 + CI stabilization.

Two cross-cutting jobs handled here:

1. Open vs. Pro: the repo runs standalone with NoOp defaults
   (``_NoOpCohortApi``, absent ``dashboard_extras``). Tests that
   assert Pro behavior are marked ``requires_pro_overlay`` in their
   own file and skipped via the per-file fixture there.

2. Platforms where ``sqlite-vec`` can't load: the macOS GitHub
   Actions runners and some Linux configurations can't load the
   sqlite-vec extension (Python's libsqlite3 ABI mismatch, or
   load_extension disabled at compile time). When that happens, the
   ``init_db`` migration silently skips the ``CREATE VIRTUAL TABLE
   ... USING vec0(...)`` statements — the production code degrades
   gracefully — but tests that DEPEND on those tables fail with
   ``no such table: code_chunks_vec`` / ``telemetry_timeline_vec``.

   We detect sqlite-vec loadability once per session and skip the
   marked tests when the extension isn't usable. Tests in files that
   use vec0 declare ``pytestmark = pytest.mark.requires_sqlite_vec``
   at module level.
"""
from __future__ import annotations

import os
import sqlite3

import pytest

# CI fix: disable the OpenRouter pricing-sync background task in tests.
# It spawns a worker thread via ``asyncio.to_thread`` that can't be
# cancelled mid-execution; when the next TestClient setup closes the
# SQLite connection while a prior thread is still in conn.executemany,
# we get a segfault (Ubuntu cp310 / Windows cp310 + cp311 access
# violation in CI). The daemon's static pricing_matrix.json fallback
# covers tests; live OpenRouter rates aren't needed.
#
# setdefault so the test runner respects an explicit override.
os.environ.setdefault("MEMSTRATA_DISABLE_PRICING_SYNC", "1")


def _sqlite_vec_loads() -> bool:
    """Probe sqlite-vec loadability AND vec0 INSERT/SELECT roundtrip.

    Returns True only when the FULL vec0 surface works:
      1. ``sqlite_vec`` is importable
      2. ``conn.enable_load_extension(True)`` doesn't raise
         (Python compiled with --enable-load-extension)
      3. ``sqlite_vec.load(conn)`` doesn't raise
         (the wheel's binary loads against this libsqlite3)
      4. ``CREATE VIRTUAL TABLE ... USING vec0(...)`` doesn't raise
      5. INSERT of a packed float vector doesn't raise
      6. SELECT with MATCH (kNN query) doesn't raise

    The earlier round of this probe checked only steps 1-4. A CI
    failure on Ubuntu/3.12 inside ``test_phase_34_embedding.py``
    (which IS marked ``requires_sqlite_vec``) implied the partial-load
    case: vec0 registers, CREATE succeeds, but actual INSERT/SELECT
    blows up. Adding steps 5-6 catches that case so the marker
    correctly skips on platforms where vec0 partial-loads.

    Any failure step returns False. This matches the runtime
    behavior in ``memstrata.layer3._db._load_vec_extension`` and the
    migration's ``try/except sqlite3.OperationalError`` around the
    vec0 CREATE.
    """
    try:
        import sqlite_vec  # type: ignore[import]
    except ImportError:
        return False
    conn = sqlite3.connect(":memory:")
    try:
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.execute(
            "CREATE VIRTUAL TABLE t USING vec0("
            "id INTEGER PRIMARY KEY, e float[8])"
        )
        # INSERT + SELECT roundtrip — the steps that actually run
        # under load in the embedding-worker / retrieval paths.
        import struct
        sample = struct.pack("<8f", *([0.1] * 8))
        conn.execute("INSERT INTO t (id, e) VALUES (1, ?)", (sample,))
        rows = conn.execute(
            "SELECT id, distance FROM t WHERE e MATCH ? "
            "ORDER BY distance LIMIT 1",
            (sample,),
        ).fetchall()
        # Sanity: kNN must return our one row at distance 0.
        if not rows or rows[0][0] != 1:
            return False
        return True
    except Exception:                                          # noqa: BLE001
        return False
    finally:
        try:
            conn.close()
        except Exception:                                      # noqa: BLE001
            pass


_SQLITE_VEC_AVAILABLE = _sqlite_vec_loads()


@pytest.fixture(autouse=True)
def _skip_if_sqlite_vec_required(request):
    """Skip tests marked ``requires_sqlite_vec`` when the extension isn't loadable."""
    if request.node.get_closest_marker("requires_sqlite_vec"):
        if not _SQLITE_VEC_AVAILABLE:
            pytest.skip(
                "Test requires sqlite-vec + vec0; extension not loadable on this runner."
            )
