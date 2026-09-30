# Factos backend

Initial Python backend implementation of `docs/backend-spec.md`. Backend only; the React client is outside scope.

## Run

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

No frontend, model picker, distributed workers, automatic job resumption, hosted vector database,
source revision-management workflow, password reset, or email delivery is included.
