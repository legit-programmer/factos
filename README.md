# Factos

Document-grounded answering with hallucination checks: a Python backend (`backend/`, specified in
`docs/backend-spec.md`) and a React client (`frontend/`, "Hallucination Lab").

## Frontend

React 19 + TypeScript + Vite. Node 20+.

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173, proxies /api/* to the backend on 127.0.0.1:8000
npm test           # span, citation, stream-reducer and SSE parser tests
npm run build      # typecheck + production bundle in frontend/dist
```

Keep the backend's `FACTOS_ALLOWED_ORIGIN` at `http://localhost:5173` (the default). The dev proxy keeps
requests same-origin, so the login cookie stays first-party and the backend sees the Vite origin on
mutating requests. Set `FACTOS_BACKEND_URL` in `frontend/.env` to proxy elsewhere.

For deployment, serve `frontend/dist` and route `/api/*` to the backend on the same origin (strip the
`/api` prefix), or build with `VITE_API_BASE=https://backend.example` and set the backend's allowed origin to
the frontend's exact origin.

Developer tools: in `npm run dev` (or a build with `VITE_DEV_TOOLS=true`) a floating **Dev** button
opens a panel whose **Mock backend** switch serves every API call from an in-browser simulation of the
backend (also `?mock=1` / `?mock=0`). The mock keeps its own users, sessions and documents in localStorage,
seeds a demo account (credentials shown in the panel), and mirrors the real routes, status codes and
bodies: auth, sessions, source indexing, attachments, request-id deduplication, cancellation, turn-ordered
fact checks, analysis retry, and the combined event stream with `Last-Event-ID` replay and 410 expiry. The
panel sets simulation speed and the next question's outcome (grounded/ungrounded failure, failed, partial or
slow check), toggles Firecrawl, and can drop open streams, expire replay, simulate a backend restart or
reset the data.

What the client does:

- Email/password sign-up and login (15–128 character passwords), logout, and a 401 fallback to login.
- Sessions sidebar with per-session contradicted/unverifiable counts, rename (double-click the title),
  delete, and a collapsible rail. Sessions are created on the first question or upload and titled from it.
- Knowledge base per session: upload PDF/DOCX/PPTX/Markdown, crawl a website (when Firecrawl is enabled),
  see indexing status and unreadable-page warnings, retry failed sources, remove sources.
- Both answers stream side by side from the single combined turn stream. The client reads it with `fetch`,
  resumes with `Last-Event-ID`, ignores replayed duplicates, and falls back to the saved turn on 410.
  Stop cancels the turn. Up to four images can be attached to a question.
- Grounded answers render `[c_…]` markers as numbered footnotes with source locations and excerpts.
- Ungrounded answers are highlighted from the server's exact UTF-16 spans: red for contradicted and yellow
  for unverifiable. A finding card shows what the model said, what the sources say, the reason and the
  evidence, and outlines the grounded sentence that cites the same evidence. Findings whose quote does not
  match the text, and analyses whose hash differs from the displayed answer, are not drawn.
- Queued, running, partial, failed and skipped checks are shown as such, with coverage, tool-call use and
  checker notes, and a retry for failed or partial checks. Earlier turns collapse into summary rows.
- Narrow screens switch between the two answers with a Grounded/Ungrounded toggle.

## Backend

Python 3.12+ on Linux, one process, one Uvicorn worker, one persistent disk volume.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.lock
pip install --no-deps -e .
cp .env.example .env
# Fill server-side API keys and concrete model IDs in .env.
uvicorn factos.api:create_app --factory --host 127.0.0.1 --port 8000 --workers 1
```

Open `/docs` for the API schema. Browser mutation requests must include the exact configured Origin,
including registration/login. Swagger's same-origin requests are rejected when its origin differs from
`FACTOS_ALLOWED_ORIGIN`; use the intended React client or send that header explicitly in local API requests.
Register, log in, create a session, add sources, then create a turn and subscribe to its `events_url`.
Use credentialed browser requests. `EventSource` must use `{withCredentials: true}` across local ports.

For deployment, set `FACTOS_LOCALHOST_DEVELOPMENT=false`, configure the exact HTTPS client origin,
use HTTPS, and mount `FACTOS_DATA_DIR` on persistent storage. Do not run multiple Uvicorn workers.
Keys stay server-side. Passwords use Argon2id; login cookie tokens are hashed in SQLite.
Email identifiers are stripped and case-folded; no Gmail-specific alias rewriting. Passwords must have
15–128 characters. Login cookies expire after seven days.

## Implemented behavior

- `GET /sessions` includes `updated`, `active` and per-session contradicted/unverifiable counts for the
  sidebar; `PATCH /sessions/{id}` renames a session (owner only, same title rules as creation).
- SQLite users, cookie sessions, ownership, parent sessions, three distinct child histories, turns,
  source/chunk mappings, analyses, attachments and durable events.
- Concurrent RAG/baseline generation with the same configured Gemini model/settings. Baseline never
  receives corpus evidence, RAG answers or verifier findings. Completed history exchanges are retained;
  failed/partial answer outputs are saved but excluded from subsequent answering prompts.
- OpenAI embeddings only, chosen during this implementation. Exact model and dimension are configuration.
  Inputs are counted with `cl100k_base`; the configured input cap must match the selected embedding model.
  No model is silently substituted. Embedding responses are normalized and validated.
- Session-local FAISS `IndexIDMap2(IndexFlatIP)` snapshots, checksum/config/mapping validation, durable
  publication, stable chunk IDs, retained vectors and historical evidence, serialized concurrent additions.
- PDF/DOCX/PPTX/Markdown extraction through LangChain loaders with structural location supplements.
  PDF pages without extractable text generate warnings. Legacy DOC/PPT, OCR and image/diagram extraction
  are unsupported. DOCX body/tables and PPTX direct text/tables have explicit coverage warnings.
- Website ingestion **only through Firecrawl v2**. A thin LangChain loader talks to Firecrawl's crawl,
  status, pagination and crawl-errors APIs. It never directly fetches target website content. Defaults:
  25 pages, two link-discovery hops, same hostname, no external links/subdomains, linked downloads excluded,
  automatic PDF parsing disabled. Sitemap discovery is skipped to keep the two-hop boundary meaningful.
- Public-URL validation before submitting crawls and for returned URLs. Website ingestion is disabled
  until an operator confirms equivalent private-address/redirect restrictions at Firecrawl's fetch boundary.
  Local DNS preflight alone cannot enforce safety inside a remotely hosted crawler.
- Stateful verification in strict per-session turn order, against the original pinned snapshot.
  At most ten vector invocations and ten tool rounds, counting invalid calls. Excess calls get paired
  budget errors; one tools-disabled finalization follows the limit. Provider call IDs and signatures are
  preserved in the current loop. One tools-disabled schema/span repair is permitted.
- Verified source excerpts, server-derived red/yellow mapping, deterministic UTF-16 spans, repeated-quote
  occurrence handling, duplicate removal, and withholding of conflicting overlaps. Invalid raw analyses
  remain saved and clearly marked in verifier history.
- One combined SSE stream with channel labels, SQLite-first event persistence, per-turn monotonic IDs,
  Last-Event-ID replay, heartbeat, 24-hour replay expiry and saved-turn fallback. SSE pulls bounded batches
  from disk rather than maintaining unbounded subscriber queues. Disconnect leaves work running.
- Per-session request-id deduplication/conflicts, bounded retained tasks and ingestion/model semaphores,
  cancellation, explicit retries, restart interruption handling, and session deletion.

## Validation and remaining setup

```bash
cd backend
pytest -q
ruff check factos tests
python -m compileall -q factos
python -m factos.check_providers  # requires configured keys; makes small paid provider requests
```

The automated suite uses fake generation/embedding responses, real FAISS and local document parsers,
and a mocked Firecrawl API. It checks ownership/history isolation, verifier ordering, the ten-call boundary,
invalid final outputs, source additions and original-snapshot retries, Unicode spans, durable replay,
ingestion errors, document locations, cancellation and restart cleanup.

Live Gemini, OpenAI and Firecrawl end-to-end behavior has not been tested: no credentials/model IDs were
provided. Run the provider capability check after selecting concrete models, then manually inspect a
small set of supported, contradicted, unverifiable, conflicting-source and multi-turn examples before
calling the MVP complete. Schema/evidence validation does not prove semantic entailment.

Parser work runs in bounded threads. Cancellation waits for an active blocking parser or snapshot write
to finish before removing session files. Thread execution cannot forcibly stop a hung native parser;
hard parser termination would require a separately bounded process worker.

No model picker, distributed workers, automatic job resumption, hosted vector database,
source revision-management workflow, password reset, or email delivery is included.
