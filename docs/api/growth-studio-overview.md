# Growth Studio Overview

Start here for Growth Studio. This page lists every route the kit uses, compares the create workflows, and summarizes billing and live observations. Details live in [Command Reference](command-reference.md), [Growth Studio PDP Videos](growth-studio-pdp.md), [Growth Studio Viral Clone](growth-studio-viral-clone.md), and [Safety and Recovery](safety-and-recovery.md).

All routes use `Authorization: Bearer <PIXVERSE_GROWTH_API_KEY>` under `/openapi/v1`. "Public guide" means the [Growth Studio OpenAPI integration guide](https://docs.pixverse.ai/growth-studio-openapi-integration-guide).

## Routes

Retry policy: every `GET` is retried on retryable `429`/`5xx` (honoring `Retry-After`); every `POST` is sent once and never retried, because none has an idempotency key.

| Method | Path | CLI command | Billable | Retry | Source |
|---|---|---|---|---|---|
| GET | `/avatars` | `avatars list` | No | GET retry | Public guide |
| POST | `/image/upload` | `upload image <file>` | No | Never | Public guide |
| POST | `/videos` | `video create-from-url`, `video create-from-json`, `run-job` | Yes | Never | Public guide |
| GET | `/videos/{video_id}` | `video get`, `video poll`, `pdp get`, `pdp poll`, `resume` | No | GET retry | Public guide |
| GET | `/videos` (`kind=uploaded` optional) | `video list [--kind uploaded]` | No | GET retry | Public guide |
| POST | `/videos/{video_id}/edit` | `video edit` | Yes | Never | Public guide |
| GET | `/folders` | `folders list`, `folders ensure` | No | GET retry | Public guide |
| POST | `/folders` | `folders ensure` (when missing) | No | Never | Public guide |
| POST | `/viral-clone/runs` | `viral-clone create --confirm-billable` | Yes | Never | Public guide |
| GET | `/viral-clone/runs/{run_id}` | `viral-clone get`, `viral-clone poll`, `viral-clone resume` | No | GET retry | Public guide |
| POST | `/video/upload` | `video import-url <url>` | No | Never | Public guide |
| GET | `/wallet/discount` | `wallet discount` | No | GET retry | Public guide |
| GET | `/wallet/ledgers` | `wallet ledgers` | No | GET retry | Public guide |
| POST | `/ecommerce_pdp/video` | `pdp create --confirm-billable` | Yes | Never | Undocumented — observed live 2026-10-23 |
| GET | `/wallet/balance` | `wallet balance` | No | GET retry | Undocumented — observed live 2026-10-23 |
| GET | `/models` | `models list` | No | GET retry | Undocumented — observed live 2026-10-23 |
| GET | `/images` | `images list` | No | GET retry | Undocumented — observed live 2026-10-23 |

`POST /openapi/v1/ka/videos` still answers live, but the kit does not use it. There is no `GET /images/{id}` route (it returns 404).

## Which Create Path

| | Generic marketing video | PDP | Viral Clone |
|---|---|---|---|
| Route | `POST /videos` | `POST /ecommerce_pdp/video` | `POST /viral-clone/runs` |
| Inputs | `product.source_url` and/or up to 6 uploaded images, plus `video` settings | Product title and 1–8 uploaded `media.pixverse.ai` images; optional `video` | Workspace reference video (`source_video_id`) plus a listing (`listing_id`, or title and 1–10 images) |
| Duration | `video.duration_seconds`: 15, 30, 45, or 60 | `video.duration`: 5–10 | Server-managed |
| Avatar | `auto`, `custom`, or `disabled` | None | `custom` or `disabled` |
| Editing | `video edit` (check `supports_edit`) | Not documented; check `supports_edit` | `supports_edit: false` |
| Result in `GET /videos` | Video resource by `video_id` | `kind: "product"` | Separate `kind: "creation"` video; the run returns only `run_id` |
| Recovery ID | `video-id.json` | `video-id.json`, `ledger-source-id.json` | `run-id.json` |

Imported reference videos appear as `kind: "uploaded"` with price `0`.

## Billing and Reconciliation

- A video's `price` is a pre-discount integer in USD cents.
- Actual charges appear only in wallet ledgers, as signed decimal strings (`amount`, `original_amount`, `balance_before`, `balance_after`). They are already currency amounts; do not divide them by 100.
- Free allowances are used first, then a discount. Only one discount applies, chosen in order workspace > account > default; discounts are not combined. `wallet discount` shows the active one.
- Fully free tasks create no ledger entry.
- Failed tasks are refunded at the amount actually charged.
- Match a ledger entry's `source_type` and string `source_id` to a video's `ledger_source_type` and `ledger_source_id`. Edit charges use `source_type: "video_edit"` with source IDs of the form `video-edit:{video_id}:{edit.id}`.
- A missing ledger entry does not prove a failure (free allowance, or delayed visibility). Never resubmit a billable create to "check".

## Live Observations (2026-10-23/24)

These were observed against the live API and are not guaranteed by the public guide.

- `GET /videos?kind=` accepts only `uploaded`; `product`, `creation`, and other values return `400 INVALID_REQUEST`.
- `wallet discount` can return `source: "default"`.
- Viral Clone rejected a 2-second reference (`400 INVALID_REQUEST`) and accepted a 5-second one. No minimum is documented.
- Viral Clone `run_id` is a short decimal string (for example `"25388"`). Run status does not return the resulting `video_id`; find it in `GET /videos` as `kind: "creation"`.
- A `plus` / `480p` / `9:16` Viral Clone run took about 3.5 minutes, with no `Retry-After` on status reads.
- `Ai-Trace-Id` is no longer documented, but the server still echoes it as `X-Request-Id` / `request_id`. The kit keeps sending it.
- Generic `POST /videos` returned `500 INTERNAL_ERROR` for this workspace on 2026-10-10; those failed tasks were not charged.
- `X-RateLimit-Limit` values seen: 4000–8000 for `GET` video and wallet routes, 200 for Viral Clone create, 10 for `video/upload`.
