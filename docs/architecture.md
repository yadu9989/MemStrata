# Architecture

MemStrata is a single Python daemon that sits on your machine. It captures
chat turns from the browser, watches your code, indexes both into a local
SQLite database, and exposes the result through three surfaces: a JSON HTTP
API, an MCP server, and a local dashboard.

This document describes how the pieces fit together in this repository (the
open-source core). The commercial Pro tier adds a separate proxy layer and
extra dashboards; those live in a different repository and are not described
here.

---

## One diagram

```
              ┌─────────────────────────────────────────────┐
              │  Browser (you, on claude.ai / chatgpt.com)  │
              │                                             │
              │  MemStrata extension captures each turn     │
              └─────────────────────────────────────────────┘
                                  │
                                  │  POST /telemetry/session
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  127.0.0.1:8000 — MemStrata daemon  (FastAPI + Uvicorn)      │
   │                                                              │
   │   ┌──────────────┐   ┌───────────────┐   ┌────────────────┐  │
   │   │ /telemetry/  │   │  /context/    │   │  /dashboard    │  │
   │   │  session     │   │  injection    │   │  + /api/...    │  │
   │   └──────┬───────┘   └───────┬───────┘   └────────┬───────┘  │
   │          │                   │                    │          │
   │          ▼                   ▼                    ▼          │
   │   ┌──────────────────────────────────────────────────────┐   │
   │   │  layer3._db  +  sqlite-vec  →  ~/.memstrata/core.db  │   │
   │   └──────────────────────────────────────────────────────┘   │
   │                              ▲                                │
   │   ┌──────────────────────────┴──────────────────────────┐    │
   │   │  Background workers (lifespan-managed)              │    │
   │   │    • EmbeddingWorker — embeds new chat turns        │    │
   │   │    • Ingestion service — watches registered repos  │    │
   │   │    • OpenRouter pricing sync — refreshes daily      │    │
   │   │    • Ollama health probe — every 30 s / 5 min       │    │
   │   └─────────────────────────────────────────────────────┘    │
   └──────────────────────────────────────────────────────────────┘
                                  │
                                  │  /mcp (Streamable HTTP)
                                  ▼
                ┌─────────────────────────────────────┐
                │  MCP client (Claude Desktop, Cursor)│
                │     5 tools: get_context,           │
                │     list_chat_sessions,             │
                │     get_chat_history, search_memory,│
                │     get_dashboard_stats             │
                └─────────────────────────────────────┘
```

Every arrow is loopback HTTP or a process-local file. No arrow leaves
the machine in steady state. The only outbound calls the daemon itself
makes are:

- Once per 24 h, a GET to `openrouter.ai/api/v1/models` to refresh the
  pricing table used by the dashboard's savings calculator. Carries no
  user data.
- Once per 24 h, a GET to `bankofcanada.ca/valet/observations/FXUSDCAD`
  to refresh the USD/CAD rate displayed on the dashboard. Carries no
  user data.
- A loopback poll to `localhost:11434` (Ollama) so the dashboard knows
  whether local inference is available.

Browser extensions talk directly to provider TLS endpoints when you
chat (e.g. `claude.ai`); the extension never proxies those requests.

---

## Module map

| Path | What's in it |
|---|---|
| `memory_layer/layer3/api_server.py` | The FastAPI app. Mounts `/mcp` (MCP server), serves `/dashboard`, exposes `/telemetry/session`, `/api/dashboard/*`, `/context/*`, `/baseline/status`, and the indexing-progress endpoints. ~3,300 lines. |
| `memory_layer/layer3/_db.py` | Schema + connection management. Idempotent `init_db`. Path resolution via `ML_DB_PATH` → `ML_DATA_DIR` → `~/.memstrata/core.db`. Loads the `sqlite-vec` extension. |
| `memory_layer/layer3/mcp_app.py` | The MCP server (FastMCP over Streamable HTTP). Registers five tools. |
| `memory_layer/layer3/mcp_server.py` | The CLI entry that runs the MCP server standalone (when not mounted under the daemon). |
| `memory_layer/layer3/retrieval.py` | Token-budgeted retrieval against the local store. Used by `/context/*` routes. |
| `memory_layer/layer3/ingestion/` | The codebase ingestion subsystem. File watcher, tree-sitter chunker, lifecycle (opt-in/opt-out), denylist, resource-policy gate (battery / RAM limits), branch-switch detection, progress tracking. |
| `memory_layer/layer3/pricing/` | Live OpenRouter sync (`openrouter_sync.py`), per-model rate lookup (`lookup.py`), and the bundled static fallback (`pricing_matrix.json`). |
| `memory_layer/layer3/ollama_health.py` | Shared sync + async probe of `localhost:11434`. Never raises (the polling loop depends on that). |
| `memory_layer/workers/embedding_worker.py` | Background worker that pulls newly-captured turns out of a queue, embeds them, and writes the vectors into the `sqlite-vec` virtual table. |
| `memory_layer/cli/` | The `memstrata` CLI: `register` (opt a project into ingestion), `ingest` (one-shot full-tree pass), and the cd-hook generator (`cd_hook.py`). |
| `memory_layer/config/keychain.py` | OS keyring wrapper for storing per-provider API keys. Talks to Windows Credential Manager, macOS Keychain, or Linux secret-service. |
| `browser-extension/` | Chrome/Edge/Firefox extension (Manifest V3, TypeScript, esbuild). Universal content script + per-provider detector chain. |
| `migrations/` | SQL migrations applied on top of `_db.py`'s base schema. |
| `shared/telemetry_schema.json` | JSON schema for telemetry events. Public contract — other tools can validate against it. |

See [`data-model.md`](data-model.md) for table-level schema detail and
[`mcp-server.md`](mcp-server.md) for the MCP tool surface.

---

## Lifecycle

The daemon is a long-running ASGI app under uvicorn. The FastAPI
`lifespan` context manager:

1. Opens a connection to the configured SQLite path, runs `init_db`,
   then closes the connection (each request gets its own short-lived
   conn via a dependency injector — long-lived connections in SQLite
   trip up WAL).
2. Initializes app state for the Ollama health, the active ingestion
   service, and the background pricing-sync task.
3. Spawns three background asyncio tasks: Ollama polling, OpenRouter
   pricing refresh, and the embedding worker. Each catches every
   exception inside its own loop — a background task is never allowed
   to abort the lifespan.
4. On shutdown, cancels the tasks in reverse order, joins the embedding
   worker, and finalizes any in-progress ingestion runs.

If any background task raises during startup, the daemon logs a warning
and continues. The product position is: "if Ollama is down we can't do
local AI, but the dashboard, MCP server, and chat capture still work."

---

## Data flow

### Capture
1. Browser extension's content script detects an assistant turn on
   `claude.ai`/`chatgpt.com`/etc. through one of the universal detectors
   (aria-live, semantic attrs, structural, velocity).
2. Content script extracts the turn (`TurnExtractor`), assigns a
   per-DOM-node `message_id`, and POSTs to
   `http://localhost:8000/telemetry/session`.
3. `api_server.record_turn` writes the row to `telemetry_session_timeline`
   and (for chat-source turns) upserts into `chat_sessions`. If the
   turn carries enough metadata to compute savings (input/cache/output
   token counts, model, project_id), those are also computed and
   stored in the same row.
4. A background `EmbeddingWorker` picks up new turns, embeds them via
   Ollama (`nomic-embed-text`), and writes vectors to the `sqlite-vec`
   virtual table.

### Retrieval
1. An MCP client (Claude Desktop, Cursor) calls one of the five tools
   over `/mcp`.
2. The tool implementation queries `_db` and/or
   `memory_layer.layer3.retrieval` for a token-budgeted result.
3. JSON response goes back through the MCP protocol.

The dashboard at `/dashboard` is the same retrieval path, just served
as inline HTML+JS for human eyes. It fetches `/api/dashboard/state` and
`/api/dashboard/sessions` and renders three tabs (Money, Now, Quality).
The Money tab is injected by the Pro overlay when present; Open shows
only Now and Quality.

---

## What's NOT in this repository

Not because we forgot — because they're commercial. See
[`repository-split.md`](repository-split.md) for the full reasoning.

- **The interception harness.** A separate localhost proxy that sits in
  front of provider APIs (`api.openai.com`, `api.anthropic.com`, etc.)
  and rewrites requests to inject token-budgeted context blocks. That
  is Pro.
- **VS Code extension.** A different surface for the same retrieval
  primitives. Pro.
- **Plan-tier feature gating.** The `/license/*` endpoints, plan tier
  enforcement, Stripe webhook, and money-back-guarantee accounting.
  Pro.
- **The system tray app.** The packaged macOS/Windows tray icon that
  manages the daemon lifecycle for end users. Pro.

All of those build on top of the same MIT-core daemon you see in this
repo. Open users get a fully-functional capture + storage + MCP
experience; Pro users add the proxy layer and IDE surface.
