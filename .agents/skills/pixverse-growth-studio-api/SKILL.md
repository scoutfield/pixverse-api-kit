---
name: pixverse-growth-studio-api
description: Use for PixVerse Growth Studio OpenAPI product-video work, including seller-neutral PDP videos for fashion or apparel, Viral Clone remakes of an imported reference video, product-page videos, video URL imports, uploads, folders, wallet reads, polling, and durable recovery. Do not use for Platform API or the PixVerse web CLI.
---

# PixVerse Growth Studio API

Use the local `pixverse-api growth-studio ...` CLI from this repository. It keeps the Growth Studio key server-side and records durable evidence for billable jobs.

## Route the Request

- Start at the [Growth Studio Overview](../../../docs/api/growth-studio-overview.md) for every route (public guide vs. undocumented), the create-path comparison, and billing rules.
- For a PDP or product-detail-page video, read [the PDP workflow](references/pdp-workflow.md), then copy and edit [the public PDP payload](references/pdp-payload.json). PDP is seller-neutral but currently limited to fashion/apparel products.
- For the existing URL-based product-video workflow, start from [the product URL payload](references/product-url-payload.json) and use `growth-studio run-job` when durable recovery is needed.
- Use the upload, folder, avatar, video, and wallet commands directly for read-only or supporting operations.
- For complete PDP fields and command options, see the repository's [Growth Studio PDP API guide](../../../docs/api/growth-studio-pdp.md).
- For a Viral Clone remake of a reference video, import the reference with `growth-studio video import-url`, copy [the Viral Clone payload](references/viral-clone-payload.json), and follow the [Growth Studio Viral Clone guide](../../../docs/api/growth-studio-viral-clone.md).

PDP and URL-based video generation are separate workflows. PDP accepts uploaded PixVerse image URLs; it does not accept a merchant page URL, folder fields, arbitrary metadata, or a routing discriminator. Its create route is `POST /openapi/v1/ecommerce_pdp/video`; do not fall back to the general video-create route.

## Setup and Provider Boundary

Run commands from the `pixverse-api-kit` repository root:

```bash
npm run cli -- growth-studio --help
```

Growth Studio uses `PIXVERSE_GROWTH_API_KEY` and bearer authentication. It must not read `PIXVERSE_PLATFORM_API_KEY` or use Platform credits. Keep keys in `.env` or the server environment, never in a payload, command argument, artifact, or browser.

Folders use the documented `GET`/`POST /openapi/v1/folders` endpoints with the same `PIXVERSE_GROWTH_API_KEY`; no separate folder credential exists. A folder is targeted with the string `video.folder_id` inside the create payload, never a top-level `folder_id`.

A non-loopback custom origin must be HTTPS, explicitly enabled with `PIXVERSE_GROWTH_ALLOW_CUSTOM_BASE_URL=true`, and controlled by the operator.

## Safety Invariants

- Treat video create and edit operations as billable. Growth Studio does not provide caller-controlled idempotency keys, so never automatically retry a create after an ambiguous response.
- For PDP, validate first with `--dry-run`, optionally inspect the read-only wallet snapshot, and obtain explicit approval immediately before running the command with `--confirm-billable`.
- A successful PDP `--dry-run` loads no credentials, sends no network request, and creates no job artifacts.
- Treat a PDP `202 Accepted` response as charged and queued, not completed. Submit once, then poll or resume.
- PDP has no completion callback. Wait five seconds before the first status read, then poll the returned video resource and honor `Retry-After` while it is queued or processing.
- Preserve `video_id`, `run_id`, `ledger_source_id`, `ledger_id`, folder IDs, and monetary amounts as strings.
- After a timeout or connection loss, use saved artifacts and status or ledger reads to reconcile. Do not use create as a recovery operation.
- Respect `Retry-After` for safe read-only polling rather than using tight loops.

## PDP Commands

```bash
npm run cli -- growth-studio upload image /absolute/path/front.webp
npm run cli -- growth-studio pdp create --payload /absolute/path/pdp.json --dry-run
npm run cli -- growth-studio wallet balance
npm run cli -- growth-studio pdp create --payload /absolute/path/pdp.json --confirm-billable
npm run cli -- growth-studio pdp get <video_id>
npm run cli -- growth-studio pdp poll <video_id>
npm run cli -- growth-studio pdp resume /absolute/path/jobs/<job-dir>
npm run cli -- growth-studio wallet ledgers --offset 0 --limit 20
```

Do not infer authorization from a prior dry run or wallet check. Follow [the PDP workflow](references/pdp-workflow.md) for the approval boundary, one-submit rule, artifacts, entitlement errors, and reconciliation.

## Viral Clone Commands

```bash
npm run cli -- growth-studio video import-url https://cdn.example.test/reference.mp4
npm run cli -- growth-studio video list --kind uploaded
npm run cli -- growth-studio viral-clone create --payload /absolute/path/viral-clone.json --dry-run
npm run cli -- growth-studio wallet discount
npm run cli -- growth-studio viral-clone create --payload /absolute/path/viral-clone.json --confirm-billable
npm run cli -- growth-studio viral-clone get <run_id>
npm run cli -- growth-studio viral-clone poll <run_id>
npm run cli -- growth-studio viral-clone resume /absolute/path/jobs/<job-dir>
```

- `video import-url` is free and synchronous but has no idempotency key; it is sent once and never retried. A lost response may still have created an asset, so check `video list --kind uploaded` first. Only `kind=uploaded` is accepted as a list filter.
- Viral Clone create (`POST /openapi/v1/viral-clone/runs`) is billable, single-submit, and gated by `--dry-run` / `--confirm-billable` like PDP. `run_id` is a short decimal string; keep it as a string.
- Duration, voiceover, and captions are server-managed; the payload rejects `video.duration_seconds`, `video.voiceover`, and `video.captions`. A reference too short for the model is rejected with `400 INVALID_REQUEST`.
- Poll every five seconds after an initial five-second wait; `succeeded` and `failed` are terminal. `RUN_NOT_FOUND` (404) is not retried.
- The run result has no `video_id`. The output also appears in `video list` as `kind: "creation"`, with `ledger_source_id` equal to its own `video_id`.
- Pricing: free allowance first, then the discount from `wallet discount` (workspace before account). Video `price` is pre-discount integer cents; ledger amounts are signed decimal strings. Refunds return the amount actually charged. Fully free runs create no ledger entry. Reconcile by matching ledger `source_type: "video"` and string `source_id` with the video's `ledger_source_id`.

Viral Clone jobs write `request.json`, `create-response.json`, `run-id.json`, `polling.jsonl`, `final.json`, and `error.json`. Resume never re-creates; without `run-id.json` it returns `reconciliation_required`.

## Catalog and Image Reads (undocumented — observed live 2026-10-23)

```bash
npm run cli -- growth-studio models list
npm run cli -- growth-studio images list --offset 0 --limit 20
```

Both are read-only and not in the official guide. `models list` passes the model catalog through unchanged; its price units (`price_unit`, `credit_rate_micro`) are unexplained, so never present them as a price quote. `images list` uses offset pagination (CLI bounds: offset >= 0, limit 1–100; server bounds unverified) and returns string `image_id` and `task_id`. There is no single-image get route.

## Existing URL-Based Workflow

These commands retain their existing behavior and are not aliases for PDP:

```bash
npm run cli -- growth-studio avatars list
npm run cli -- growth-studio folders list
npm run cli -- growth-studio folders ensure "Campaign Alpha"
npm run cli -- growth-studio upload image /absolute/path/product.webp
npm run cli -- growth-studio video create-from-url "https://shop.example.test/products/item"
npm run cli -- growth-studio video create-from-json /absolute/path/payload.json
npm run cli -- growth-studio run-job --payload /absolute/path/payload.json --folder-name "Campaign Alpha"
npm run cli -- growth-studio resume /absolute/path/jobs/<job-dir>
npm run cli -- growth-studio video get <video_id>
npm run cli -- growth-studio video poll <video_id>
npm run cli -- growth-studio video list --limit 20 --status succeeded
```

For a local image, upload it first and place only the returned `https://media.pixverse.ai/...` URL in `product.images[].url`. The existing general workflow may instead use `product.source_url`; PDP may not.

Folder targeting applies only to the existing general workflow:

- `--folder-id <folder_id>` uses a verified folder.
- `--folder-name <name>` reuses an exact (trimmed) name match or creates the folder with that name unchanged.
- `--auto-folder` infers a normalized folder name from supported general-payload fields and reuses a case-insensitive match.

Prefer `growth-studio run-job` over direct general-video creation when a durable artifact trail is needed. General-video creation has no dry-run mode.

## Artifacts and Recovery

General durable jobs can contain `request.json`, `folder.json`, `create-response.json`, `video-id.json`, `polling.jsonl`, `final.json`, and `error.json`. PDP jobs use the same core evidence and may add `ledger-source-id.json`; they do not use `folder.json`.

Artifacts are private, atomic, and recursively redacted. Resume polls the saved string ID and never submits again. If no ID was saved, the result is `reconciliation_required`; inspect the existing request, error, remote status, and wallet ledger evidence before deciding whether a new user-authorized submission is appropriate.

## Troubleshooting

- Missing credentials: configure `PIXVERSE_GROWTH_API_KEY` without printing its value.
- `403` on PDP or wallet endpoints: the account or key may not be entitled to that capability. Treat it as an access issue, not a transient error, and do not retry create.
- Invalid PDP image URL: upload the local image with `growth-studio upload image` and use the returned PixVerse media URL.
- `429`: wait according to `Retry-After`; do not convert a failed or ambiguous create into an automatic retry.
- `failed` or `canceled`: report the resource error and `request_id`; these are terminal resource states.
- Missing saved PDP `video_id`: use the reconciliation procedure in [the PDP workflow](references/pdp-workflow.md), never a blind resubmission.

Legacy `0.x` aliases still exist for the original Growth Studio commands and emit a deprecation warning. PDP has no legacy alias.
