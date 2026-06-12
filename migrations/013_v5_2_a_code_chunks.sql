-- Migration 013: V5.2-A Phase 35.0 — automated codebase ingestion
-- Spec: V5_2_A_ADDENDUM.md §7
--
-- Adds the semantic-chunk index that powers the V5.2-A backfill
-- orchestrator. The structural V3 `entity_relation` graph (referenced
-- in the spec as the FK target for code_chunks.entity_id) is not
-- present in this repo yet; we keep entity_id nullable so the table
-- works in pure-semantic mode until structural retrieval lands.
--
-- Applied automatically by _db._migrate() on every startup.
-- Idempotent: every statement uses IF NOT EXISTS.

-- ── code_chunks_vec ─────────────────────────────────────────────────────────
-- Vec0 virtual table; chunk_id is the join key into code_chunks. 768-dim
-- matches nomic-embed-text (the same model V5.4 Phase 34 already
-- uses for telemetry_timeline_vec).
CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks_vec USING vec0(
    chunk_id      INTEGER PRIMARY KEY,
    embedding     float[768]
);

-- ── code_chunks (metadata) ──────────────────────────────────────────────────
-- One row per AST entity (or file-sized fallback chunk). stable_hash is
-- SHA-256 over the normalized source slice; the orchestrator skips
-- re-embedding when stable_hash already exists for (project_id, entity_id).
CREATE TABLE IF NOT EXISTS code_chunks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL,
    -- Forward-compat with V3 entity_relation graph. NULL means "no
    -- structural entity (whole-file fallback)" — also lets us land
    -- semantic chunks before the structural graph table exists.
    entity_id       TEXT,
    file_path       TEXT NOT NULL,
    language        TEXT NOT NULL,
    line_start      INTEGER NOT NULL,
    line_end        INTEGER NOT NULL,
    stable_hash     TEXT NOT NULL,
    text            TEXT NOT NULL,
    token_estimate  INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- (project_id, file_path, line_start) is the natural key for the
    -- "did this chunk move?" check during incremental updates.
    UNIQUE (project_id, file_path, line_start, line_end)
);

CREATE INDEX IF NOT EXISTS idx_code_chunks_project
    ON code_chunks (project_id);
CREATE INDEX IF NOT EXISTS idx_code_chunks_file
    ON code_chunks (project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_code_chunks_hash
    ON code_chunks (project_id, stable_hash);

-- ── indexing_jobs (Hard Rule 72 resume state) ───────────────────────────────
-- One in-flight row per project. The orchestrator updates this after
-- every batch so a crash in Phase B (parse) or C (embed) resumes from
-- last_processed_file rather than restarting from scratch.
CREATE TABLE IF NOT EXISTS indexing_jobs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id          TEXT NOT NULL,
    project_path        TEXT NOT NULL,
    phase               TEXT NOT NULL CHECK (
        phase IN ('scan','parse','embed','verify','complete','paused','failed')
    ),
    files_total         INTEGER NOT NULL DEFAULT 0,
    files_processed     INTEGER NOT NULL DEFAULT 0,
    entities_total      INTEGER NOT NULL DEFAULT 0,
    entities_embedded   INTEGER NOT NULL DEFAULT 0,
    last_processed_file TEXT,
    started_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at        TIMESTAMP,
    error               TEXT,

    -- One job per project; resuming reuses the same row.
    UNIQUE (project_id)
);

CREATE INDEX IF NOT EXISTS idx_indexing_jobs_phase
    ON indexing_jobs (phase);

-- ── project_opt_in (Hard Rule 70 gate) ──────────────────────────────────────
-- Backfill NEVER starts without a row here with state='opted_in'. The
-- 'pending' state means "prompt the user next time the project is seen";
-- 'opted_out' is sticky — re-running the prompt requires explicit user
-- action.
CREATE TABLE IF NOT EXISTS project_opt_in (
    project_path        TEXT PRIMARY KEY,
    state               TEXT NOT NULL CHECK (
        state IN ('opted_in','opted_out','pending')
    ),
    decided_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    user_added_dirs     TEXT,
    user_excluded_dirs  TEXT
);

-- ── file_hashes (branch-switch diffing) ─────────────────────────────────────
-- Per-file content hash so the watcher can ask "what changed?" on git
-- HEAD movement without rehashing every file. PRIMARY KEY covers the
-- only access pattern (lookup by project + path).
CREATE TABLE IF NOT EXISTS file_hashes (
    project_id      TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    last_seen       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, file_path)
);
