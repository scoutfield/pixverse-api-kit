# Safety and Recovery

## Credentials

- Platform: `PIXVERSE_PLATFORM_API_KEY`, header `API-KEY`, Platform credits.
- Growth Studio: `PIXVERSE_GROWTH_API_KEY`, bearer auth, Growth Studio credits.
- The providers never fall back to each other's keys.
- The official HTTPS origins are the defaults. HTTP/HTTPS loopback origins (`localhost`, `127.0.0.1`, or `::1`) are allowed for local testing.
- A non-default, non-loopback origin must use HTTPS and is rejected unless the matching explicit opt-in is `true`: `PIXVERSE_PLATFORM_ALLOW_CUSTOM_BASE_URL` or `PIXVERSE_GROWTH_ALLOW_CUSTOM_BASE_URL`. Enabling one permits that provider's credential to be sent to the configured custom origin, so use it only with a server you control.

## Durable Jobs

Use the durable submission surface for billable work: Platform `run-job`, Growth Studio `run-job`, or Growth Studio `pdp create --confirm-billable` / `viral-clone create --confirm-billable`. Each writes a durable, redacted request artifact before submission. Platform billable jobs wait by default; use `--no-wait` only when asynchronous return is required, then resume from the saved job directory. A new Platform job gets a fresh UUID `Ai-trace-id`; recovery may reuse only the saved trace from `request.json`. Growth Studio stores its own trace and never borrows Platform credentials or identifiers.

Depending on the provider and how far the job reached, its directory can contain:

- `request.json`
- `folder.json` when Growth Studio folder resolution was used
- `create-response.json`
- `video-id.json` or `image-id.json`
- `run-id.json` for a Growth Studio Viral Clone job
- `ledger-source-id.json` for a PDP job when the API returns `ledger_source_id`
- `polling.jsonl`
- `final.json`
- `error.json` on failures

Growth Studio JSON artifacts are private, atomic, and recursively redacted. When Growth Studio resumes a nonterminal `final.json`, it preserves the earlier snapshot as `final-prior-N.json` before continuing.

Resume with the matching provider:

```bash
pixverse-api platform resume /absolute/path/pixverse-api-jobs/platform/<job-dir>
pixverse-api growth-studio resume /absolute/path/jobs/<job-dir>
pixverse-api growth-studio pdp resume /absolute/path/jobs/<job-dir>
pixverse-api growth-studio viral-clone resume /absolute/path/jobs/<job-dir>
```

### Polling defaults and transient read errors

Platform status polling defaults to a 5 second interval (the status page asks for no less than 5 seconds) and a 30 minute wait per session (`--interval-ms` / `--timeout-ms` override both). Generation can run longer than that; a timeout is not a failure and the job resumes from its directory.

Status reads are read-only, so a transient read failure does not abandon the job. Transport errors, HTTP 429 and 5xx, and the retryable `ErrCode`s `500069` (high load) and `500044` (concurrency limit) keep the job polling with exponential backoff (starting at the interval, capped at 60 seconds), honoring `Retry-After` when present, until the overall timeout. Each such failure is appended to `polling.jsonl` as a `poll_error` record; a timeout reached during failures records the last error in the timeout details. Any other error (for example an invalid ID) still fails immediately. Each read-only HTTP retry sends a fresh `Ai-trace-id`, because PixVerse can return a cached earlier result for a reused trace. None of this applies to the billable submission: it is sent exactly once, never retried automatically, and keeps its saved trace for recovery.

`resume` is poll-only. It reads the saved result ID and continues status checks; it never calls a create endpoint. If the submission response was ambiguous and no result ID was saved, it returns `reconciliation_required` instead of risking a duplicate charged generation. Inspect the saved request, error, recent remote jobs, and any provider request ID before deciding whether to submit again.

## Growth Studio PDP

PDP live creation requires `--confirm-billable`. First use its credential-free `--dry-run`, optionally inspect the wallet balance snapshot, and obtain explicit approval immediately before the confirmed command. Wallet balance is not a price quote, reservation, entitlement check, or authorization to spend.

Submit a confirmed PDP create once. The endpoint has no caller-provided idempotency key, and a `202 Accepted` response means charged and queued rather than complete. A timeout or transport failure after submission is ambiguous; never automatically retry create.

PDP recovery preserves `video_id`, optional `ledger_source_id`, ledger IDs, and amounts as strings. When an ID was saved, use `growth-studio pdp resume`. When no `video_id` was saved, preserve `reconciliation_required` and, when useful, query:

```bash
pixverse-api growth-studio wallet ledgers --offset 0 --limit 20
```

Match a ledger item with `source_type: "video"` and a string `source_id` equal to the saved string `ledger_source_id` or `video_id`. No matching item is not proof of failure: a generation can be free, or ledger visibility can be delayed. A `403` from PDP or wallet calls normally indicates missing account or key entitlement; resolve access rather than retrying a billable create.

See [Growth Studio PDP Videos](growth-studio-pdp.md) for its seller-neutral fashion/apparel payload and full workflow.

## Growth Studio Viral Clone and Video Import

Viral Clone create follows the PDP rules: credential-free `--dry-run`, explicit approval immediately before `--confirm-billable`, one submission, no automatic retry. Recovery uses the saved string `run_id` (`run-id.json`) with `growth-studio viral-clone resume`; without it, the result is `reconciliation_required`. `growth-studio video import-url` is free but is also sent once and never retried, because a lost response may already have created an uploaded asset. See [Growth Studio Viral Clone](growth-studio-viral-clone.md).

## Webhooks

Platform webhook verification first parses the raw body as a JSON object whose values must be scalar or `null`. It converts those key/value pairs to a URL-encoded query string with `URLSearchParams`, and verifies either insertion order or key-sorted order (code-point/byte order, matching the official Go and Java examples) for compatibility. The signed string is:

```text
${timestamp}\n${nonce}\n${queryString}
```

For example, `{"video_id":"123","status":1}` becomes `video_id=123&status=1`. A `null` value (such as `"url": null` on a failed delivery) is accepted and signed as `null`, which is what `String(null)` in the official Node example produces; the Go (`<nil>`) and Python (`None`) spellings are also accepted. Nested objects and arrays are not supported by this signature format and are rejected. The signature is Base64 HMAC-SHA256.

The handler validates authentication, reserves the nonce, and returns exact body `ok` only after the delivery callback succeeds and the reservation is committed. PixVerse resends any delivery that does not receive `ok` (8 retries over about 5 hours), so duplicates are acknowledged rather than rejected:

- A verified replay of an already-processed nonce returns `200 ok` without calling the delivery callback again.
- Deliveries are also deduplicated by payload `(id, status)`, as the official docs recommend, so a redelivery with a fresh nonce is acknowledged with `ok` once the first one succeeded. A later status for the same `id` is a new event.
- A duplicate that arrives while the first attempt is still being processed gets `409`, so PixVerse retries it later; if the first attempt fails, its reservation is released and the retry is delivered.

`timestampToleranceSeconds` (an option of `createPlatformWebhookHandler` and `verifyPlatformWebhook`, 1 second to 7 days) bounds how old a `Webhook-Timestamp` may be. The default is 6 hours: the docs do not say whether retries are re-signed, and a short window could reject PixVerse's own late retries if they keep the original timestamp. Replays inside the window are still blocked by the nonce and `(id, status)` deduplication, which are held for the whole window. Timestamps more than 300 seconds in the future are always rejected. A custom store's `reserve(key, expiresAt, nowSeconds)` must return a falsy value only for a key that is already committed, and throw (for example an error with `statusCode: 409`) for one that is still reserved. For a multi-instance receiver, use a shared durable store.
