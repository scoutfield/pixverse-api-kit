---
name: growth-studio
description: Use PixVerse Growth Studio API for PDP product videos, Viral Clone remakes, video and image uploads, wallet reads, product-page workflows, polling, and durable recovery.
---

# PixVerse Growth Studio API

Run `pixverse-api growth-studio ...` as described under CLI location. Use only `PIXVERSE_GROWTH_API_KEY`; never use Platform or web-product credentials.

If credentials are missing, route setup to `pixverse-api auth login growth-studio --stdin` or the packaged `auth.command`. Do not ask the user to paste the key into chat.

## CLI location

When this skill is inside the installed plugin (`<plugin-root>/skills/growth-studio/SKILL.md`), run `<plugin-root>/scripts/pixverse-api` so the skill and CLI versions always match. When it is installed as a standalone Agent Skill, run `pixverse-api`, which the PixVerse API Plugin installer places on `PATH`. Do not use a package checkout or package-manager link.

## Start here

Read `references/growth-studio-overview.md` beside this skill first: it lists every Growth Studio route with its source (public guide or undocumented, observed live), billing, and retry policy, and compares the generic, PDP, and Viral Clone create paths.

## PDP workflow

1. Prepare a product with a title and one to eight uploaded `https://media.pixverse.ai/...` image URLs.
2. Copy `references/pdp-standard-high.json` beside this skill to a job-specific location and replace only its neutral example values.
3. Run `growth-studio pdp create --payload <absolute-path> --dry-run`. Dry run uses no credentials, creates no job, and sends no request.
4. Optionally run `growth-studio wallet balance` as a read-only snapshot. It is not a price quote or spending approval.
5. Obtain explicit approval immediately before one `--confirm-billable` create.
6. Preserve the returned `job_dir`, `video_id`, and `ledger_source_id`, then poll or resume that job.

The current PDP request requires `product`. `video` may be omitted, `null`, or an object. An object requires `mode` set to `standard` or `pro`; `quality` may be `normal` or `high`. Omitted and null video configuration use provider defaults and are omitted from the wire request.

PDP submits exactly once to `POST /openapi/v1/ecommerce_pdp/video`, with only `product` and the optional `video` object in the request body. There is no fallback create route and no completion callback. Wait five seconds before the first status read, then poll the returned video resource and honor `Retry-After` while it remains queued or processing.

## Viral Clone workflow

1. Import the reference video once with `growth-studio video import-url <public-mp4-url>` (free, synchronous, never retried; public direct MP4, at most 65 s and 200 MiB). A lost response may still have created an asset, so check `growth-studio video list --kind uploaded` before importing again. Keep the string `video_id` as `source_video_id`.
2. Copy `references/viral-clone-plus.json` beside this skill to a job-specific location and replace only its neutral example values. `model` is `standard`, `plus`, or `pro`; resolution is `768p`/`1440p` for `standard` and `480p`/`720p`/`1080p` for `plus`/`pro`. Do not add `video.duration_seconds`, `voiceover`, or `captions`; they are server-managed.
3. Run `growth-studio viral-clone create --payload <absolute-path> --dry-run`. Dry run uses no credentials, creates no job, and sends no request.
4. Optionally run `growth-studio wallet balance` and `growth-studio wallet discount` as read-only snapshots. They are not a price quote or spending approval.
5. Obtain explicit approval immediately before one `--confirm-billable` create.
6. Preserve the returned `job_dir` and string `run_id`, then poll with `viral-clone poll <run_id>` or `viral-clone resume <job-dir>`.

Viral Clone submits exactly once to `POST /openapi/v1/viral-clone/runs`. There is no callback and no guaranteed `Retry-After`: wait five seconds, then poll every five seconds; `succeeded` and `failed` are terminal. The run does not return a `video_id`; the output also appears in `growth-studio video list` as a `kind: "creation"` video whose `ledger_source_id` equals its own `video_id`. A reference that is too short for the model is rejected with `400 INVALID_REQUEST`.

Video `price` fields are pre-discount integer cents; wallet ledger amounts are signed decimal strings. A free allowance is used first, then the discount (workspace before account). Fully free runs create no ledger entry. To reconcile, match a ledger `source_type: "video"` and string `source_id` to the video's `ledger_source_id`.

## Catalog and image reads

`growth-studio models list` and `growth-studio images list [--offset 0] [--limit 20]` are read-only routes that are undocumented — observed live 2026-10-23. Pass the model catalog through unchanged; its price units are unexplained, so it is not a price quote. Image IDs and task IDs are strings. There is no single-image get command.

## Recovery

A successful create acceptance means queued and charged, not completed. Never retry a create automatically after a timeout, connection loss, malformed response, or interrupted poll. If a saved video ID exists, use `pdp resume <job-dir>`; if a saved Viral Clone `run_id` exists, use `viral-clone resume <job-dir>`. If no ID was saved, retain the redacted evidence and stop at reconciliation.

Use `references/growth-studio-pdp.md`, `references/growth-studio-viral-clone.md`, and `references/safety-and-recovery.md` beside this skill for exact fields, artifacts, errors, and recovery rules.
