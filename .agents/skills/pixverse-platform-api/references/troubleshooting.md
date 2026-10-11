# Troubleshooting

HTTP success is not Platform success. Require a valid response envelope and `ErrCode` equal to zero.

| Class | Evidence | Next action |
|---|---|---|
| Configuration/authentication | Missing `PIXVERSE_PLATFORM_API_KEY`, rejected key, wrong base URL | Stop; fix Platform configuration. Never substitute a Growth Studio or web credential. |
| Local input/media validation | CLI rejects field combinations, URL, type, size, dimensions, duration, or unsafe numeric ID | Fix the payload and rerun `--dry-run`; no provider request was made. |
| Provider parameter rejection | Nonzero parameter-related `ErrCode` | Compare the specialized example, local validator, and current endpoint page; change only the rejected input. |
| Moderation | Status 7 or moderation `ErrCode` | Treat as terminal. Report the provider reason; revise content only if the user asks. Do not hide or bypass moderation. |
| Rate/concurrency pressure | Rate/concurrency `ErrCode`, HTTP 429, or retry guidance | For read-only calls, wait as directed and retry safely. For a confirmed-not-accepted submission, follow provider guidance; if acceptance is ambiguous, reconcile instead of resubmitting. |
| Polling issue | Transient failure while a result ID is known | Status polling already waits through transport errors, HTTP 429/5xx, and `500069`/`500044` until its timeout (see `poll_error` records in `polling.jsonl`). After a timeout, preserve the ID and job directory and resume polling without recreating the generation. |
| High load (`500069`) | Provider reports the system is under high load | Retryable for read-only calls; status polling continues automatically. A submission rejected with it was not accepted; obtain fresh approval before submitting again, and never auto-resubmit. |
| Webhook duplicates | PixVerse redelivers until it receives `ok` | The handler acknowledges verified duplicates (same nonce, or same `id` and `status`) with `ok` and does not call the delivery callback twice. A `409` means the first attempt is still in progress. |
| Ambiguous billable submission | Timeout/connection loss after dispatch and no saved result ID | Do not retry or resubmit. Keep `request.json` and trace ID, inspect usage/provider records, and report `reconciliation_required`. |
| Terminal generation failure | Status 6, 7, or 8 | Preserve final status, trace, provider envelope, and failure details; do not automatically create a replacement job. |
| Missing result ID | Successful-looking create envelope lacks the cataloged ID path | Preserve create response and trace; stop as a response-contract error and reconcile. |
| Trace reuse | New request attempts caller-supplied/saved trace | Create a fresh request trace. Reuse saved trace only via the explicit recovery path. |
| Music MV audio not verified (`701020`) | Generation rejects the audio ID before acceptance | Run `audio.verify`, correct any review issue, then obtain fresh authorization before a new paid submission. Never auto-submit after verification. |
| Music MV moderation (`500063`) | Audio or lyrics violate provider policy | Stop and report the provider reason. Revise content only when requested; do not bypass moderation. |
| Music MV concurrency (`500044`) | Provider reports the generation concurrency limit | Preserve the job evidence and wait for capacity. Do not retry when acceptance is ambiguous. |
| Invalid Music MV lyrics (`400080`) | Lyrics contain no meaningful information | Correct the lyrics and rerun `--dry-run`; do not alter them silently. |
| Instrumental lip-sync rejection (`400017`) | Lip sync is enabled but no recognizable vocals exist | Disable lip sync or provide vocal audio, then validate the changed payload before any paid submission. |

Read-only retry safety does not authorize a billable retry. Never resubmit an ambiguous billable request merely because a read-only status or catalog call would be safe to retry.

Before sharing diagnostics, redact credentials, authorization headers, cookies, private media, signed URLs, webhook secrets, and sensitive raw response fields. Preserve safe operation, error, result ID, and trace context for reconciliation.

## Official sources

- [Error codes](https://docs.platform.pixverse.ai/error-codes-796041m0)
- [Common errors and solutions](https://docs.platform.pixverse.ai/common-errors-and-solutions-882978m0)
