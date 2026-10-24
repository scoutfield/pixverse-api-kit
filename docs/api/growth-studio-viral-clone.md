# Growth Studio Viral Clone

For every Growth Studio route, workflow comparison, and billing rules, start at the [Growth Studio Overview](growth-studio-overview.md).

Viral Clone remakes a reference video for a product listing. The reference must already be a video in the workspace, typically imported with `growth-studio video import-url`. Viral Clone create is billable, has no idempotency key, and is submitted exactly once.

Viral Clone is separate from PDP and from the URL-based general video workflow. It has its own create route, run resource, and payload.

## Quick Start

1. Import the reference video (free, synchronous, single attempt):

   ```bash
   pixverse-api growth-studio video import-url https://cdn.example.test/reference.mp4
   ```

   Keep the returned string `video_id`; it becomes `source_video_id`.

2. Copy the example payload (`references/viral-clone-payload.json` in the Growth Studio skill, or `viral-clone-plus.json` in the plugin examples), replace the neutral values, and validate locally:

   ```bash
   pixverse-api growth-studio viral-clone create \
     --payload /absolute/path/viral-clone.json \
     --dry-run
   ```

   Dry run validates and normalizes the payload without loading credentials, accessing the network, creating a job directory, or charging the account.

3. Optionally read the wallet snapshot and discount (read-only, not a price quote or approval):

   ```bash
   pixverse-api growth-studio wallet balance
   pixverse-api growth-studio wallet discount
   ```

4. After explicit approval immediately before submission, run the billable create exactly once:

   ```bash
   pixverse-api growth-studio viral-clone create \
     --payload /absolute/path/viral-clone.json \
     --confirm-billable
   ```

   `--dry-run` and `--confirm-billable` are mutually exclusive. A live create writes a durable job directory and polls unless `--no-poll` is supplied. Job options are `--jobs-dir`, `--job-name`, `--timeout-minutes`, `--initial-delay-seconds`, `--fallback-delay-seconds`, and `--no-poll`.

## Video Import

```text
POST /openapi/v1/video/upload
{"url": "https://cdn.example.test/reference.mp4"}
```

- The body is exactly `{ "url": ... }`; unknown fields are rejected by the server.
- The URL must be a public HTTP(S) direct MP4 link, at most 65 seconds and 200 MiB.
- The call is synchronous and free. It returns `200` with `video_id`, `url`, `duration` (float seconds), `width`, `height`, `file_size`, and `request_id`.
- It fetches and moderates the source, so it can take a long time. Import has its own rate limit (10 per minute observed live).
- There is no idempotency key, so the CLI never retries an import. A lost response may still have created an asset; check `growth-studio video list --kind uploaded` before importing again. Import errors may carry `retryable: false` and `details.stage` (for example `fetch` or `persist_unknown`) with code `UPLOAD_FAILED`.

Imported assets appear in `GET /openapi/v1/videos` as `kind: "uploaded"`, with price `0`, empty currency and ledger fields, `supports_edit: false`, and a duration rounded up to whole seconds. `growth-studio video list --kind uploaded` filters to them; the server accepts only `kind=uploaded` as a filter (other values such as `product` or `creation` return `400 INVALID_REQUEST`), so the CLI rejects other values locally.

Video list responses show these `kind` values: `product` (PDP), `uploaded` (imports), and `creation` (Viral Clone output).

## Payload

```json
{
  "source_video_id": "627410861853514292",
  "model": "plus",
  "script_language": "en-US",
  "listing": {
    "title": "Example Travel Mug",
    "description": "Insulated stainless steel mug that keeps drinks hot for hours.",
    "brand": "Example Brand",
    "image_info": {
      "items": [
        { "url": "https://media.pixverse.ai/example/mug-front.webp", "sort": 0 }
      ]
    }
  },
  "video": {
    "aspect_ratio": "9:16",
    "resolution": "720p",
    "language": "en-US",
    "bgm_mode": "model_direct"
  },
  "avatar": { "mode": "disabled" }
}
```

| Field | Requirement |
|---|---|
| `source_video_id` | Required decimal string; a video in the workspace (for example from video import) |
| `model` | Required: `standard`, `plus`, or `pro` (case-sensitive) |
| `script_language` | Required BCP 47 tag such as `en-US` |
| `listing.listing_id` | Optional string; when given, the server ignores the other product fields |
| `listing.title` | Required without `listing_id`; at most 255 characters |
| `listing.description` | Optional; at most 5,120 characters |
| `listing.brand` | Optional; at most 255 characters |
| `listing.image_info.items` | Required without `listing_id`; 1–10 items of `{ url, sort? }` |
| `listing.image_info.items[].url` | Required: an upload URL or a public HTTP(S) image URL |
| `listing.image_info.items[].sort` | Optional integer, default `0` |
| `video` | Required object |
| `video.aspect_ratio` | Required: `1:1`, `9:16`, `16:9`, `3:4`, `4:3`, or `21:9` |
| `video.resolution` | Required, lowercase; `standard`: `768p` or `1440p`; `plus`/`pro`: `480p`, `720p`, or `1080p` |
| `video.language` | Required BCP 47 tag |
| `video.bgm_mode` | Optional: `model_direct` or `independent` |
| `avatar` | Optional object; `mode` is `custom` or `disabled` (no `auto`) |
| `avatar.url` / `avatar.avatar_id` | `custom` requires exactly one; `disabled` forbids both |

The serialized body must be at most 1 MiB. Unknown fields are rejected locally. `video.duration_seconds`, `video.voiceover`, and `video.captions` are not accepted: duration, voiceover, and captions are server-managed.

The reference video must be long enough for the selected model. There is no documented minimum and the CLI cannot see the source duration, so it does not enforce one. Live observation: a 2-second reference was rejected with `400 INVALID_REQUEST` ("Check the source duration and selected model specifications"), while 4–5 second references were accepted.

## Create and Status Contract

```text
POST /openapi/v1/viral-clone/runs
GET  /openapi/v1/viral-clone/runs/{run_id}
```

Create returns `202 Accepted` with `{ run_id, status: "processing", request_id }` and a `Location` header for the run. `run_id` is a short decimal string (for example `"25388"`), not a 64-bit video ID; the CLI keeps it as a string and falls back to the `Location` header if the body omits it.

Status returns `{ run_id, status, output?, error?, request_id }`:

- `status` is `processing`, `succeeded`, or `failed`; `succeeded` and `failed` are terminal.
- `output` (`video_url`, `thumbnail_url`, `mime_type`) appears only on success.
- `error` (`code`, `message`) appears only on failure; it has no `retryable` or `details`.
- An unknown run returns `404 RUN_NOT_FOUND`.

There is no callback and no guaranteed `Retry-After`. The CLI waits five seconds, then polls every five seconds (honoring `Retry-After` if one is ever sent). Read errors with `429` or `5xx` that are retryable keep polling within the deadline; create is never retried.

Live observation: a `plus` / `480p` / `9:16` run with avatar disabled and a 5-second reference went from `processing` to `succeeded` in about 3.5 minutes (about 40 polls, no `Retry-After`). The final body was exactly `run_id`, `status`, `output { video_url, thumbnail_url, mime_type: "video/mp4" }`, and `request_id`.

The run status does not include the resulting `video_id`. The output also appears in `GET /openapi/v1/videos` as a separate video with `kind: "creation"`, its own `video_id` (different from `run_id`), `ledger_source_type: "video"`, `ledger_source_id` equal to that `video_id`, `supports_edit: false`, and server-managed voiceover and captions.

```bash
pixverse-api growth-studio viral-clone get <run_id>
pixverse-api growth-studio viral-clone poll <run_id> [--timeout-minutes 30] [--initial-delay-seconds 5] [--fallback-delay-seconds 5]
pixverse-api growth-studio viral-clone resume /absolute/path/jobs/<job-dir> [polling options]
```

`viral-clone resume` is poll-only. It reads the saved string `run_id` and never calls create. If no `run_id` was saved, it returns `reconciliation_required`. The generic `growth-studio resume <job-dir>` also recognizes Viral Clone jobs.

## Job Artifacts

A live create writes a private, atomic, redacted job directory under `jobs/` unless `--jobs-dir` is supplied:

- `request.json`: normalized wire request, trace, `workflow: "viral-clone"`, and endpoint;
- `create-response.json`: response from the single create call;
- `run-id.json`: string `run_id`;
- `polling.jsonl`: one snapshot per status read;
- `final.json`: terminal run, or the create response with `--no-poll`;
- `error.json`: safe error metadata.

A resumed nonterminal `final.json` is preserved as `final-prior-N.json`.

## Pricing, Discounts, and Refunds

- A free allowance is used first; after that, the applicable discount applies. `growth-studio wallet discount` returns `{ discount, source, expires_at, request_id }`: `discount` is a string percentage such as `"70"`, `source` is `workspace`, `account`, or `default`, and `expires_at` is ISO 8601 or `null`. A workspace discount takes precedence over an account discount.
- Refunds return the amount actually charged, not the pre-discount price.
- Price fields on video resources (`price`) are pre-discount integer cents (for example `48` with currency `USD`). Wallet ledger `amount`, `original_amount`, `balance_before`, and `balance_after` are signed decimal strings. Do not compare the two directly without converting units.
- Fully free tasks do not create a consumption transaction. Live observation: a Viral Clone run that consumed a free allowance left the wallet balance unchanged, decreased `free_chances` by one, and created no ledger entry.

## Reconciliation

Create has no idempotency key and is never retried. After a timeout, connection loss, malformed response, or interrupted poll:

1. Keep the original job directory.
2. If `run-id.json` exists, run `viral-clone resume`.
3. If not, keep `reconciliation_required` and inspect `request.json`, `create-response.json`, and `error.json`. Do not resubmit.
4. Check `growth-studio video list` for a new `kind: "creation"` video, then `growth-studio wallet ledgers`: match `source_type: "video"` and compare the ledger's string `source_id` with the video's string `ledger_source_id` (its `video_id`).
5. A missing ledger entry does not prove failure; the run may have used the free allowance, or ledger visibility may be delayed. Stop for operator review before any new submission.

## Wallet Ledgers

`GET /openapi/v1/wallet/ledgers` accepts `offset` (≥ 0, default 0) and `limit` (1–100, default 20). The CLI enforces `--limit` 1–100; the server rejects `101`. Each `data[]` entry has `ledger_id`, `type`, `amount` (signed decimal string), `original_amount` (string or `null`), `currency`, `balance_before`, `balance_after`, `source_type` (`video`, `video_batch`, `video_edit`, `image_task`, `topup_order`, `refund_order`, `dispute`, `avatar_voice`, `avatar_image`, or `unknown`), `source_id`, and `created_at`, with `pagination { offset, limit, total }`.

## Errors

- `404 RUN_NOT_FOUND`: the run does not exist in this workspace. Not retried.
- `429 CONCURRENCY_LIMIT_EXCEEDED`: too many concurrent runs. The body's `retryable` flag is honored for reads; a create is still never retried automatically. Wait and decide manually.
- `UPLOAD_FAILED` with `details.stage`: video import failed at that stage. `persist_unknown` means the asset may exist; check the uploaded list before importing again.
- `400 INVALID_REQUEST`: invalid parameters, including a too-short reference for the model.
- `403`: the key or account may not be entitled to Viral Clone.

Branch on status and code, keep `request_id`, and never turn an error into an automatic resubmission.

See also [Command Reference](command-reference.md), [Growth Studio PDP Videos](growth-studio-pdp.md), and [Safety and Recovery](safety-and-recovery.md).
