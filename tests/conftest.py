"""Shared test fixtures — V5.2-E E.1.

Auto-mounts the Pro overlay on the Open MIT-core ``app`` so every test
that uses ``TestClient(app)`` sees the same behavior as the real daemon
(harness/cli.py `_cmd_api` mounts the overlay at startup). Without
this, post-E.1 the api_server tests that depend on cohort baseline,
plan-tier endpoints, or the money-tab dashboard substitutions would
regress because Open's defaults are NoOp / billing-blind.

Hard Rule 86: this conftest lives in Open's test tree but imports Pro
— allowed because the test tree is build-only, never shipped to users.
The boundary applies to runtime code, not to development scaffolding.
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True, scope="session")
def _mount_pro_overlay_for_tests():
    """Mount the Pro overlay once per test session.

    Idempotent — ``api_overlay.mount`` is gated on an
    ``app.state._pro_overlay_mounted`` flag, so a re-mount during a
    re-import (rare, but possible across xdist workers) is a no-op.
    """
    try:
        from memory_layer.layer3.api_server import app
        from memory_layer_pro.api_overlay import mount as _mount
        _mount(app)
    except Exception as exc:                              # noqa: BLE001
        # If the overlay can't load (e.g., monorepo state mid-refactor),
        # surface so failures are diagnosable rather than silently
        # producing NoOp behavior in routes that expected Pro.
        import warnings
        warnings.warn(f"Pro overlay not mounted in tests: {exc}")
    yield
