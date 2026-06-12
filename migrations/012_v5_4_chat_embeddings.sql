-- Migration 012: V5.4 Phase 34 — relevance-based retrieval
-- Spec: V5_4_PHASE_34_REFINEMENT.md §3.1
--
-- Requires sqlite-vec to be loaded before execution.
-- Applied automatically by _db._migrate_phase_34() on every startup.
-- Safe to re-run: IF NOT EXISTS / UNIQUE / WHERE NOT IN guards are idempotent.

-- Vector store for chat turn embeddings (nomic-embed-text → 768 dimensions).
-- Separate virtual table: vec0 tables don't mix with ALTER TABLE.
CREATE VIRTUAL TABLE IF NOT EXISTS telemetry_timeline_vec USING vec0(
    timeline_id   INTEGER PRIMARY KEY,
    embedding     float[768]
);

-- Deferred-embedding queue.  Ingest path enqueues (sub-1ms); worker drains.
-- UNIQUE on timeline_id: each turn is embedded once; INSERT OR IGNORE is safe.
CREATE TABLE IF NOT EXISTS embedding_queue (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    timeline_id         INTEGER NOT NULL UNIQUE,
    enqueued_at         TEXT    DEFAULT (datetime('now')),
    attempts            INTEGER DEFAULT 0,
    last_error          TEXT,
    completed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_embedding_queue_pending
    ON embedding_queue(completed_at, attempts)
    WHERE completed_at IS NULL;

-- Backfill: enqueue all existing timeline rows for embedding.
-- UNIQUE constraint makes this idempotent — re-running never duplicates rows.
INSERT OR IGNORE INTO embedding_queue (timeline_id)
SELECT id FROM telemetry_session_timeline;
