# Growth Studio PDP Videos

For every Growth Studio route, workflow comparison, and billing rules, start at the [Growth Studio Overview](growth-studio-overview.md).

PDP creates a product-detail-page video from uploaded fashion or apparel product images. The public payload and CLI are generic across products from any seller or merchant; no seller-specific schema, domain, folder, or prompt is required. Merchant neutrality does not expand the currently documented fashion/apparel category boundary.

The existing URL-based Growth Studio video workflow remains separate. Use `growth-studio video create-from-url` or `growth-studio run-job` for that workflow; PDP does not accept or scrape a product-page URL.

## Quick Start

Upload each local product image first:

```bash
pixverse-api growth-studio upload image /absolute/path/front.webp
```

Put only the returned `https://media.pixverse.ai/...` URLs in a PDP payload. Then validate locally:

```bash
pixverse-api growth-studio pdp create \
  --payload /absolute/path/pdp.json \
  --dry-run
```

Dry run performs the same validation and normalization as live submission without loading credentials, accessing the network, creating a job directory, or charging the account.

When useful, inspect the read-only wallet snapshot:

```bash
pixverse-api growth-studio wallet balance
pixverse-api growth-studio wallet ledgers --offset 0 --limit 20
```

Wallet balance is a point-in-time preflight signal, not a price quote, reservation, entitlement check, or guarantee of a successful PDP submission.

After reviewing the dry run and obtaining explicit approval immediately before submission, run the billable command exactly once:

```bash
pixverse-api growth-studio pdp create \
  --payload /absolute/path/pdp.json \
  --confirm-billable
```

`--dry-run` and `--confirm-billable` are mutually exclusive. A live create is durable by default and polls unless `--no-poll` is supplied. A `202 Accepted` response means the request is charged and queued, not completed; continue with status reads rather than another create.

## Public Payload

```json
{
  "product": {
    "title": "Linen Summer Shirt",
    "description": "Breathable linen with a relaxed fit.",
    "images": [
      { "url": "https://media.pixverse.ai/example/front.webp" },
      { "url": "https://media.pixverse.ai/example/back.webp" }
    ],
    "brand": "Example Brand",
    "price": {
      "amount": "59.90",
      "currency": "USD"
    }
  },
  "video": {
    "mode": "pro",
    "duration": 10,
    "quality": "high",
    "aspect_ratio": "9:16",
    "additional_prompt": "Soft morning light and clean product-focused styling."
  }
}
```

The public root contains `product` and may contain `video`. Omitting `video` or setting it to `null` selects the provider defaults; both forms are normalized by leaving `video` out of the outbound request. When `video` is an object, `video.mode` is required.

| Field | Requirement |
|---|---|
| `product.title` | Required non-empty string, at most 255 characters |
| `product.description` | Optional string, at most 5,120 characters |
| `product.images` | Required 1–8 item array; every item contains only an uploaded PixVerse HTTPS URL |
| `product.brand` | Optional string, at most 255 characters |
| `product.price.amount` | Optional price object field; amount must remain a string |
| `product.price.currency` | Optional price object field; uppercase three-letter code |
| `video` | Optional object or `null`; omitted and `null` use provider defaults |
| `video.mode` | Required when `video` is an object: `standard` or `pro` |
| `video.duration` | Optional integer from 5 through 10 |
| `video.quality` | Optional: `normal` or `high` |
| `video.aspect_ratio` | Optional: `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, or `21:9` |
| `video.additional_prompt` | Optional string, at most 2,000 characters |

Brand and price are record fields; the API does not document them as generation controls. Unknown fields are rejected before submission. In particular, PDP does not accept `type`, `source_url`, `folder_id`, seller fields, or arbitrary metadata.

## Status and Recovery Commands

```bash
pixverse-api growth-studio pdp get <video_id>
pixverse-api growth-studio pdp poll <video_id> \
  [--timeout-minutes 10] \
  [--initial-delay-seconds 5] \
  [--fallback-delay-seconds 5]
pixverse-api growth-studio pdp resume /absolute/path/jobs/<job-dir> \
  [--timeout-minutes 10] \
  [--initial-delay-seconds 5] \
  [--fallback-delay-seconds 5]
```

The existing `growth-studio video get` and `video poll` commands can also read a PDP video ID, but the `pdp` spelling keeps the workflow clear.

`pdp resume` is poll-only. It reads the durable string `video_id` and never calls create. If a job has no saved ID, resume returns `reconciliation_required` rather than risk a duplicate charge.

## Job Artifacts

A live PDP create writes a timestamped job directory under `jobs/` unless `--jobs-dir` is supplied. It can contain:

- `request.json`: redacted normalized wire request, trace, workflow, and endpoint identity;
- `create-response.json`: redacted response from the single create call;
- `video-id.json`: string `video_id`;
- `ledger-source-id.json`: string `ledger_source_id`, when returned;
- `polling.jsonl`: one snapshot per poll;
- `final.json`: terminal state, or the create response with `--no-poll`;
- `error.json`: redacted safe error metadata.

PDP does not perform folder resolution, so it does not create `folder.json`.

## API Contract

The CLI submits the normalized public payload exactly once to:

```text
POST /openapi/v1/ecommerce_pdp/video
```

The request body contains `product` and, when configured, `video`; no private discriminator is added. A successful submission returns `202 Accepted`, a `Location` header for `/openapi/v1/videos/{video_id}`, and identifiers including `video_id`, `ledger_source_id`, and `request_id` when available.

PDP does not provide a completion callback or webhook. Wait at least five seconds before the first status read, then poll `GET /openapi/v1/videos/{video_id}`. Treat `queued` and `processing` as nonterminal and honor `Retry-After` (five seconds when absent); `succeeded`, `failed`, and `canceled` are terminal.

## Ambiguous Submission and Ledger Reconciliation

Create has no caller-provided idempotency key and is never automatically retried. After a timeout, connection loss, malformed response, or interrupted poll:

1. Preserve the original job directory.
2. If `video-id.json` exists, run `pdp resume`.
3. If no `video_id` exists, keep the `reconciliation_required` result and inspect `request.json`, `create-response.json`, and `error.json`.
4. If useful, query wallet ledgers. Match `source_type: "video"` and compare the ledger's string `source_id` with the saved string `ledger_source_id` or `video_id`.
5. Stop for operator review before any new submission.

A missing ledger entry does not prove that submission failed. It may be a free generation, or ledger visibility may be delayed.

## Errors and Access

- `403` from PDP or wallet endpoints usually indicates that the account or key lacks entitlement. Verify access; do not retry the billable create.
- `429` on a safe read-only request should follow `Retry-After`. Do not automatically retry an ambiguous create.
- Branch on structured error status/code rather than message text, and retain `request_id` for support and reconciliation.
- Terminal `failed` or `canceled` video states should be reported with their resource error; they do not authorize another create.

## Maintainer Implementation Note

The public capability name is PDP. Keep its dedicated create endpoint and exact public payload separate from the existing URL-based Growth Studio video workflow. Do not add private routing fields or fall back to another create endpoint.

See also [Command Reference](command-reference.md) and [Safety and Recovery](safety-and-recovery.md).
