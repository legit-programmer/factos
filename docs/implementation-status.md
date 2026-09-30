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
5. Point the React client at the documented authenticated API and combined turn event stream.

Local automated correctness checks do not certify the verifier's semantic judgments.
