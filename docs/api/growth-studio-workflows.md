# Growth Studio public workflows

Aligned with the [Growth Studio OpenAPI Integration Guide](https://docs.pixverse.ai/growth-studio-openapi-integration-guide), reviewed November 10, 2026. These commands use the existing Growth Studio bearer API key and `/openapi/v1` on `https://growth-api.pixverse.ai`.

## Commands and identifiers

| Command | Purpose | Result identifier / query |
|---|---|---|
| `growth-studio upload video <public-url>` | Synchronous MP4 import, free; JSON request, not multipart | `video_id`; `video get` |
| `growth-studio templates list` | Read the live template catalog | Integer `id`, including zero |
| `growth-studio template create --payload <file>` | One product video using a catalog template | `video_id`; `template get/poll` |
| `growth-studio viral-clone create --payload <file>` | Clone an existing workspace reference video | `run_id`; `viral-clone get/poll` |
| `growth-studio variation create --payload <file>` | Batch of variations from an eligible Viral Clone video | `videos[].video_id`; `variation get/poll` for each |
| `growth-studio product-suite create --payload <file>` | Product images for Amazon, Walmart, or TikTok Shop | `task_id`; `product-suite get/poll` |
| `growth-studio wallet discount` | Read the currently effective discount | No cached price guarantee |
| `growth-studio video list --kind <kind>` | Filter by `template`, `variation`, `hook`, or `uploaded` | Keep kind/status unchanged while paging |

Every new billable create requires either `--dry-run` or `--confirm-billable`. Dry runs validate without credentials, network requests, or job files. Review the normalized request and obtain explicit approval immediately before a live billable create. Do not treat this CLI update, a catalog read, or a wallet read as approval to generate content.

```bash
pixverse-api growth-studio templates list
pixverse-api growth-studio template create --payload /absolute/path/template.json --dry-run
pixverse-api growth-studio template create --payload /absolute/path/template.json --confirm-billable --no-poll
pixverse-api growth-studio template resume /absolute/path/jobs/saved-job
```

Use the same `create`, `get`, `poll`, and `resume` pattern for `viral-clone`, `variation`, and `product-suite`. Creation polls by default. `--no-poll` returns acceptance and the durable job location. `get` and `poll` take the resource ID, while `resume` takes the job directory. Variation resume follows all returned video IDs and retains the server's `input_indices` mapping; `variation poll` takes one video ID, not a batch or ledger ID.

Job options: `--jobs-dir`, `--job-name`, and `--no-poll`. Polling options: `--timeout-minutes` (default 30), `--initial-delay-seconds`, and `--fallback-delay-seconds`. New workflows wait at least five seconds, honor longer `Retry-After` values, and stop at the appropriate terminal state.

## Inputs

Upload local images first with `growth-studio upload image <file>`. Use the returned CDN URL unchanged. Template, variation, and suite images must be platform CDN assets; the CLI accepts HTTPS `media.pixverse.ai` and `cdn.pixverse.ai` image URLs without query parameters or fragments. The server verifies asset validity and access. Viral Clone product references also allow public HTTP(S) images, but its custom avatar must be a platform image or a system avatar ID. Reference-image limits for the selected Viral Clone tier remain server-validated because the guide does not specify their numeric values.

### Template

Fetch `templates list` before choosing `template_id`; the example zero is only valid if present in the live catalog. The template chooses model, duration, resolution, and aspect ratio; do not submit those fields. Provide 1–10 product images for manual products, or a product `source_url`. All three switches below are required, including explicit `false` values. `callout_text_switch` is optional and independent of captions. Keep the submitted setting because query results do not return it.

```json
{
  "template_id": 0,
  "product": {"title": "Linen shirt", "images": [{"url": "https://media.pixverse.ai/example/shirt.webp"}]},
  "video": {"language": "en-US", "voiceover": false, "captions": false, "background_music": false, "callout_text_switch": true}
}
```

### Video import and Viral Clone

```bash
pixverse-api growth-studio upload video 'https://example.com/reference.mp4' --dry-run
pixverse-api growth-studio upload video 'https://example.com/reference.mp4'
```

Import requires a direct public MP4 URL, optionally signed. The service validates actual content: at most 65 seconds and 200 MiB, positive dimensions, and successful moderation. The CLI sends only `url`, with a 64 KiB body limit. Import is synchronous and returns an asset ID, not a run. Each successful POST creates a distinct asset, so import is never automatically retried. Import evidence removes URL queries and fragments. Use `video-import resume <job-dir>` for recovery; without a saved ID it returns `reconciliation_required`.

Viral Clone uses a workspace `source_video_id` and returns a distinct `run_id`. Never substitute one for the other. `standard` supports `768p` and `1440p`; `plus` and `pro` support `480p`, `720p`, and `1080p`. Duration follows the reference. `script_language` and `video.language` can differ.

```json
{
  "source_video_id": "123456789",
  "model": "plus",
  "script_language": "en-US",
  "listing": {"title": "Linen shirt", "image_info": {"items": [{"url": "https://media.pixverse.ai/example/shirt.webp", "sort": 0}]}},
  "video": {"aspect_ratio": "9:16", "resolution": "720p", "language": "en-US"},
  "avatar": {"mode": "disabled"}
}
```

Alternatively, `listing` can specify a saved `listing_id`. Its stored product data takes precedence. A custom avatar requires exactly one of `url` or `avatar_id`; `auto` is unsupported. Optional `video.bgm_mode` accepts `model_direct` or `independent`; independent music requires music in the reference. Run query results report only the final video or error, not intermediate analysis or script content.

### Variations

Submit 1–20 explicit configurations; the server does not generate a Cartesian product. Avatar and scene modes are `keep`, `auto`, `text` (nonempty description), or `image` (platform `image_url`, optional description). Each target requires a full supported language code. Source eligibility is checked by the service.

```json
{
  "source_video_id": "123456789",
  "videos": [
    {"avatar": {"mode": "keep"}, "scene": {"mode": "text", "description": "A bright kitchen"}, "language": {"code": "en-US"}},
    {"avatar": {"mode": "keep"}, "scene": {"mode": "auto"}, "language": {"code": "ja-JP"}}
  ]
}
```

The service deduplicates identical configurations within one request and returns `input_indices`. The CLI preserves that mapping and does not deduplicate requests or make another create call. A second request incurs a new batch. `ledger_source_id` identifies the batch's charge, not a video that can be polled.

### Product Image Suite

Specify the platform, its exact marketplace, a language permitted for that marketplace, and unique image types. Manual products require 1–9 reference images. Product `source_url` can supply missing product data. Omit `quality` or use an empty string; specifying a model, size, or aspect ratio is unsupported.

```json
{
  "platform": "amazon", "marketplace": "amazon.com", "language": "en-US",
  "product": {"title": "Travel mug", "images": [{"url": "https://media.pixverse.ai/example/mug.webp"}]},
  "image_types": ["main", "lifestyle"]
}
```

Marketplace/language pairs and image purposes are validated against the guide, including Walmart Mexico's six-type restriction. Viral Clone, variation, and suite bodies must fit within 1 MiB of UTF-8 JSON.

An image suite's `completed` status means processing is settled; inspect every `images[].status`. Only `succeeded` images have usable URLs. A completed suite can contain failed or audit-rejected images, including no successful images. The CLI preserves every image result and error. Polling never regenerates failures.

## Durable recovery

New workflows save private, atomic artifacts: `request.json`, `create-response.json`, `resource-ids.json`, optional `ledger-source-id.json`, `polling.jsonl`, individual `result-<id>.json`, `final.json`, and uniquely named error records. Signed URL queries/fragments are removed from persisted evidence. Original responses and partial results are retained.

Creation and import POSTs are submitted once. After an ambiguous outcome, use the original job directory. Resume only queries saved IDs; missing IDs yield `reconciliation_required` without loading credentials. Error output includes `details.job_dir`. For variation batches, already saved terminal results are reused and remaining IDs are polled. Batch `completed` means all videos reached a terminal state, not that every video succeeded.

## Billing and compatibility

`wallet discount` returns the percentage payable as a string: `"70"` means 70% of the original paid amount. Workspace rules take precedence; free allowances apply before discounts. The response is a current snapshot, not a reservation. Catalog `price_per_video` uses milli-credits, video `price` uses integer US cents, and ledger monetary fields use decimal strings in currency units. Preserve their units and do not calculate actual charges from catalog prices alone.

`wallet ledgers --limit 0` now selects the documented default of 20. Match ledger entries by both `source_type` and `source_id`; template/variation creation may use `video_batch`, while individual failure refunds use `video`. `original_amount` can be null and excludes free items. Refund settlement can lag task failure. Missing ledgers do not prove creation failed.

Existing product-video, image upload, avatar, folder, editing, and recovery commands remain available. PDP and `wallet balance` are retained as legacy capabilities, absent from the current guide; their availability has not been reverified. Routes mentioned only in passing (`models`, `images`, and professional creation) are not wrapped without documented request schemas.
