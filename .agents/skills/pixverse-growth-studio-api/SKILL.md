---
name: pixverse-growth-studio-api
description: Use for PixVerse Growth Studio OpenAPI product-video work, including seller-neutral PDP videos for fashion or apparel, product-page videos, uploads, folders, wallet reads, polling, and durable recovery. Do not use for Platform API or the PixVerse web CLI.
---

# PixVerse Growth Studio API

Use the local `pixverse-api growth-studio ...` CLI from this repository. It keeps the Growth Studio key server-side and records durable evidence for billable jobs.

## Route the Request

- For a PDP or product-detail-page video, read [the PDP workflow](references/pdp-workflow.md), then copy and edit [the public PDP payload](references/pdp-payload.json). PDP is seller-neutral but currently limited to fashion/apparel products.
- For the existing URL-based product-video workflow, start from [the product URL payload](references/product-url-payload.json) and use `growth-studio run-job` when durable recovery is needed.
- Use the upload, folder, avatar, video, and wallet commands directly for read-only or supporting operations.
- For complete PDP fields and command options, see the repository's [Growth Studio PDP API guide](../../../docs/api/growth-studio-pdp.md).

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
- Preserve `video_id`, `ledger_source_id`, `ledger_id`, folder IDs, and monetary amounts as strings.
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
