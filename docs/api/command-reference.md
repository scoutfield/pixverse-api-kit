# PixVerse API Command Reference

Use `pixverse-api` for server API work. The general `pixverse` web CLI remains a separate product.

This repository is a private package. From its root, run `npm ci && npm link` to install the local `pixverse-api` binary. Without a link, replace `pixverse-api` below with `npm run cli --`.

```bash
pixverse-api --help
pixverse-api platform --help
pixverse-api growth-studio --help
```

## Configuration

The customer-friendly setup follows the PixVerse CLI auth pattern, but stores dedicated server API keys:

```bash
printf '%s' '<platform-api-key>' | pixverse-api auth login platform --stdin
printf '%s' '<growth-studio-api-key>' | pixverse-api auth login growth-studio --stdin
pixverse-api auth status
pixverse-api auth logout platform
pixverse-api auth path
```

The packaged macOS build also includes `auth.command`, which prompts for the same two dedicated API keys and stores them for the current macOS user.

| Provider | Required key | Default origin |
|---|---|---|
| Platform | `PIXVERSE_PLATFORM_API_KEY` | `https://app-api.pixverse.ai` |
| Growth Studio | `PIXVERSE_GROWTH_API_KEY` | `https://growth-api.pixverse.ai` |

Provider credentials are isolated and never fall back to each other. The CLI accepts the official HTTPS origin and HTTP/HTTPS loopback origins (`localhost`, `127.0.0.1`, or `::1`) by default. Using any other origin requires HTTPS and the corresponding explicit opt-in:

```bash
PIXVERSE_PLATFORM_ALLOW_CUSTOM_BASE_URL=true
PIXVERSE_GROWTH_ALLOW_CUSTOM_BASE_URL=true
```

An opt-in permits the provider credential to be sent to that custom origin. Use it only for a server you control.

## Platform

### Specialized operations

The general form is:

```bash
pixverse-api platform <resource> <operation> [--payload /absolute/path/input.json] [--dry-run]
```

`--dry-run` performs local normalization and validation and prints a redacted request description without making a network request. Billable specialized operations use the durable Platform job path even without the explicit `run-job` spelling and wait for a terminal result by default; use `--no-wait` when you need asynchronous return after acceptance.

| Area | Commands | Billing class |
|---|---|---|
| Account | `account balance`, `account usage` | Read-only |
| Upload | `upload image`, `upload media` | Non-billable |
| Audio review | `audio verify` | Non-billable |
| Resources | `resource templates`, `resource tts-speakers`, `resource restyle-effects` | Read-only |
| Custom voices | `voice create`, `voice delete` | Non-billable |
| Images | `image template`, `image status` | Generate is billable; status is read-only |
| Core video | `video text`, `video image`, `video template` | Billable |
| Guided video | `video transition`, `video multi-transition`, `video fusion`, `video motion-control` | Billable |
| Speech and sound | `video lip-sync`, `video avatar`, `video sound-effect` | Billable |
| Editing | `video restyle`, `video swap-mask`, `video swap`, `video modify` | Billable |
| Finishing | `video extend`, `video upscale` | Billable |
| Agents | `agent viral-recreation`, `agent real-estate`, `agent music-mv` | Billable |
| Retrieval | `video status` | Read-only |

Most inputs are JSON payloads. These operations also accept one positional value instead of `--payload`: `upload image <path>`, `upload media <path>`, `voice delete <speaker_id>`, `image status <image_id>`, and `video status <video_id>`. Do not combine positional input with `--payload`.

Examples:

```bash
pixverse-api platform account balance
pixverse-api platform resource templates --payload /absolute/path/template-query.json
pixverse-api platform upload image /absolute/path/reference.png
pixverse-api platform audio verify --payload /absolute/path/audio-verification.json
pixverse-api platform agent music-mv --payload /absolute/path/music-mv.json --dry-run
pixverse-api platform video text --payload /absolute/path/text-video.json --dry-run
pixverse-api platform video status 627410861853514292
```

See [Platform Operations](platform-operations.md) for endpoint-specific payload requirements and official documentation links.

### Durable Platform jobs

```bash
pixverse-api platform run-job \
  --operation agent.music-mv \
  --payload /absolute/path/music-mv.json \
  --interval-ms 5000 \
  --timeout-ms 600000

pixverse-api platform run-job \
  --operation agent.music-mv \
  --payload /absolute/path/music-mv.json \
  --no-wait

pixverse-api platform resume /absolute/path/pixverse-api-jobs/platform/<job-dir> \
  --interval-ms 5000 \
  --timeout-ms 600000
```

`run-job` accepts only a billable Platform operation ID and waits until a terminal result by default. `--no-wait` records the submission and known result ID, then returns immediately without detached background polling. `--poll` remains accepted as an explicit wait compatibility alias and cannot be combined with `--no-wait`. `--interval-ms` must be positive and `--timeout-ms` must be non-negative.

`resume` reads an existing job directory and polls its saved `video_id` or `image_id`. It never creates another generation. If the original submission is ambiguous and no result ID was saved, it returns `reconciliation_required`.

Platform jobs use `pixverse-api-jobs/platform/` by default and can contain `request.json`, `create-response.json`, `video-id.json` or `image-id.json`, `polling.jsonl`, `final.json`, and `error.json`.

### Raw Platform requests

```bash
pixverse-api platform raw <method> </openapi/v2/path> \
  [--payload /absolute/path/body.json] \
  [--header 'name:value'] \
  [--dry-run]
```

The raw escape hatch accepts `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, and `DELETE` only for an `/openapi/v2/...` path. It will not accept absolute URLs, traversal, encoded path separators, or overrides of authentication, host, content-length, or trace headers. Raw requests are single-attempt and do not provide durable billable-job recovery; prefer a specialized operation for supported endpoints.

## Growth Studio

### Discovery, folders, and uploads

```bash
pixverse-api growth-studio avatars list
pixverse-api growth-studio folders list
pixverse-api growth-studio folders ensure "Campaign Alpha"
pixverse-api growth-studio upload image /absolute/path/product.webp
```

`folders ensure` accepts either the positional name shown above or `--folder-name <name>`. The name is trimmed and otherwise sent unchanged; an existing folder is reused only on an exact (trimmed) name match.

Folders use the documented `GET /openapi/v1/folders` and `POST /openapi/v1/folders` endpoints with the same `PIXVERSE_GROWTH_API_KEY` bearer credential as every other Growth Studio call. A resolved folder is sent as the string `video.folder_id` in the create payload.

`upload image` accepts `.jpg`, `.jpeg`, `.png`, or `.webp` files of at most 20 MiB and rejects other files before any network request.

### PDP videos

PDP is a seller-neutral product-detail-page video workflow for the currently documented fashion/apparel category. Upload local images first and place only the returned `https://media.pixverse.ai/...` URLs in the public payload.

```bash
pixverse-api growth-studio pdp create \
  --payload /absolute/path/pdp.json \
  --dry-run

pixverse-api growth-studio pdp create \
  --payload /absolute/path/pdp.json \
  --confirm-billable \
  [--jobs-dir /absolute/path/jobs] \
  [--job-name product-name] \
  [--timeout-minutes 10] \
  [--initial-delay-seconds 5] \
  [--fallback-delay-seconds 5] \
  [--no-poll]

pixverse-api growth-studio pdp get <video_id>
pixverse-api growth-studio pdp poll <video_id> [polling options]
pixverse-api growth-studio pdp resume /absolute/path/jobs/<job-dir> [polling options]
```

`--dry-run` and `--confirm-billable` are mutually exclusive. Dry run validates and prints the normalized request without credentials, network access, job artifacts, or billing. A live submission requires explicit approval immediately beforehand and is sent exactly once. Treat `202 Accepted` as charged and queued, then poll or resume rather than creating again.

The public PDP payload contains only `product` and `video`; it rejects `type`, `source_url`, folder fields, seller fields, and arbitrary metadata. Brand and price are optional record fields, not documented generation controls. See [Growth Studio PDP Videos](growth-studio-pdp.md) for the complete payload, approval, artifact, and reconciliation contract.

### Wallet reads

```bash
pixverse-api growth-studio wallet balance
pixverse-api growth-studio wallet ledgers [--offset 0] [--limit 20]
```

These calls are read-only. Balance is a snapshot, not a price quote, reservation, entitlement check, or substitute for billable approval. Ledger `offset` must be a non-negative integer and `limit` must be an integer from 1 through 100.

### Existing URL-based and general videos

```bash
pixverse-api growth-studio video create-from-url \
  "https://shop.example.com/products/item" [folder options]

pixverse-api growth-studio video create-from-json \
  /absolute/path/payload.json [folder options]

pixverse-api growth-studio video status <video_id>
pixverse-api growth-studio video get <video_id>
pixverse-api growth-studio video poll <video_id>
pixverse-api growth-studio video list [--limit 20] [--status succeeded] [--cursor <cursor>]
pixverse-api growth-studio video edit <video_id> <clip_index> <instruction>
```

Folder options for creation are mutually exclusive targeting choices:

- `--folder-id <folder_id>` uses a verified existing folder.
- `--folder-name <name>` reuses an exact (trimmed) name match or creates the folder with that name unchanged.
- `--auto-folder` infers a normalized name from supported payload metadata or the merchant URL and reuses a case-insensitive match.

A payload that already contains `video.folder_id` keeps that folder; no folder is listed or created. `video list --limit` must be an integer from 1 through 100 and `--status` one of `queued`, `processing`, `succeeded`, `failed`, or `canceled`. `video edit` requires a `clip_index` from 1 through 40 and a non-empty instruction of at most 500 characters.

Read-only requests (`avatars list`, `folders list`, `video get`/`status`/`list`, and polling) retry on HTTP 429 and retryable 5xx responses, honoring `Retry-After` (seconds or HTTP date) and otherwise using capped exponential backoff. Video create, video edit, image upload, and folder create are never retried automatically.

The existing general `create-from-url`, `create-from-json`, and `video edit` commands have no dry-run mode. They can create billable asynchronous work and do not provide the full durable job workflow. Prefer `run-job` for new general video generation. PDP is a separate workflow and does provide `pdp create --dry-run`.

### Durable Growth Studio jobs

```bash
pixverse-api growth-studio run-job \
  --payload /absolute/path/payload.json \
  [--folder-id <folder_id> | --folder-name <name> | --auto-folder] \
  [--jobs-dir /absolute/path/jobs] \
  [--job-name product-name] \
  [--timeout-minutes 10] \
  [--initial-delay-seconds 5] \
  [--fallback-delay-seconds 5] \
  [--no-poll]

pixverse-api growth-studio resume /absolute/path/jobs/<job-dir> \
  [--timeout-minutes 10] \
  [--initial-delay-seconds 5] \
  [--fallback-delay-seconds 5]
```

Timing values must be finite: `--timeout-minutes` must be greater than zero. Polling never waits less than five seconds before the first status read or less than one second between later reads; smaller delay values are raised to those minimums. By default, `run-job` polls to a terminal state. `--no-poll` returns after recording the create response and string `video_id`.

`resume` reads `video-id.json` and continues polling only. It never calls the create endpoint. With no saved video ID it reports `reconciliation_required`, preserving the evidence needed to investigate an ambiguous submission.

Growth Studio jobs use `jobs/` by default and can contain `request.json`, `folder.json`, `create-response.json`, `video-id.json`, `polling.jsonl`, `final.json`, and `error.json`. PDP jobs omit folder resolution and can additionally contain `ledger-source-id.json`. A resumed nonterminal `final.json` is preserved as `final-prior-N.json`. JSON artifacts are private, atomic, and recursively redacted.

### Legacy aliases

Legacy Growth Studio aliases remain available during `0.x` and emit one deprecation warning:

| Legacy command | Canonical command |
|---|---|
| `avatars` | `growth-studio avatars list` |
| `folders` | `growth-studio folders list` |
| `ensure-folder` | `growth-studio folders ensure` |
| `upload-image` | `growth-studio upload image` |
| `create-from-url` | `growth-studio video create-from-url` |
| `create-from-json` | `growth-studio video create-from-json` |
| `get` | `growth-studio video get` |
| `poll` | `growth-studio video poll` |
| `list` | `growth-studio video list` |
| `edit` | `growth-studio video edit` |
| `run-job` | `growth-studio run-job` |

There is no legacy alias for provider-qualified `resume`.

## Recovery rule

After a timeout, connection loss, malformed response, or any other ambiguous billable submission, do not rerun the create command. Keep the job directory and use the matching provider's `resume` command; for PDP, use `growth-studio pdp resume`. With no saved result ID, stop at `reconciliation_required` and inspect ledger evidence instead of resubmitting. See [Safety and Recovery](safety-and-recovery.md) for the artifact and webhook contracts.
