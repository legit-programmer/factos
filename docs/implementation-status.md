# Implementation status

Date: 30 September 2026

The initial backend implementation is proposed for the `legit-programmer/factos` repository.
The repository was empty when integration began.

Build choice confirmed by the user: **OpenAI embeddings**. Generation and verification use Gemini.
Additional confirmed constraint: **Firecrawl only for web crawling**.

## Validation

- 34 deterministic tests passed with real SQLite, FAISS and local format parsers.
- Python package compilation and Ruff checks passed.
- Tests cover user/session isolation, three histories, source publication/pinning, ordering, retry,
  tool cap including invalid/multiple calls, finalization, malformed output, UTF-16 exact spans,
  cancellation, SSE replay/expiry, supported loaders, Firecrawl-only API requests, and startup cleanup.
- Live model/provider/crawl validation requires server keys and chosen concrete model IDs.
- Dockerfile is supplied but an image has not been built in this environment.

## Before calling the MVP complete

1. Review and merge the backend implementation pull request.
2. Select Gemini/OpenAI model IDs and matching embedding dimensions/input limits; configure server keys.
3. Run `python -m factos.check_providers` and a bounded Firecrawl ingestion smoke check.
4. Manually inspect supported, contradicted, unverifiable, conflicting-source and multi-turn examples.
5. Run the React client (`frontend/`) against the configured backend and review a few real sessions.

## Frontend

The React client in `frontend/` implements the comparison UI: authentication, sessions, per-session
knowledge base, both answer lanes streamed from the combined turn stream, citations, and
contradicted/unverifiable highlights from the validated analysis spans.

- 15 unit tests (Vitest) cover UTF-16 highlight slicing, repeated and overlapping spans, citation parsing,
  event replay deduplication and SSE framing. Typecheck and production build pass.
- Checked end to end in Chromium against the real backend, with scripted Gemini/embedding responses
  standing in for live providers: registration, Markdown upload and indexing, two streamed turns with
  verification, finding navigation, reload from saved state, stop mid-stream, logout, and the narrow layout.

Local automated correctness checks do not certify the verifier's semantic judgments.
