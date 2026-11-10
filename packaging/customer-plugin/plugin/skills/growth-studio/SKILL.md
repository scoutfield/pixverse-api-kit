---
name: growth-studio
description: Use PixVerse Growth Studio OpenAPI for product and template videos, Viral Clone, Video Variations, Product Image Suites, uploads, wallet discounts and ledgers, legacy PDP, polling, and durable recovery.
---

# PixVerse Growth Studio API

Run `pixverse-api growth-studio ...` as described under CLI location. Use only `PIXVERSE_GROWTH_API_KEY`; never use Platform or web-product credentials.

If credentials are missing, route setup to `pixverse-api auth login growth-studio --stdin` or the packaged `auth.command`. Do not ask the user to paste the key into chat.

## CLI location

When this skill is inside the installed plugin (`<plugin-root>/skills/growth-studio/SKILL.md`), run `<plugin-root>/scripts/pixverse-api` so the skill and CLI versions always match. When it is installed as a standalone Agent Skill, run `pixverse-api`, which the PixVerse API Plugin installer places on `PATH`. Do not use a package checkout or package-manager link.

## Current public workflows (November 2026)

Read [the public workflow guide](references/growth-studio-workflows.md) before using the new commands. Use `growth-studio templates list` to choose a live template; `template create`, `viral-clone create`, `variation create`, and `product-suite create` take `--payload <file>` and either `--dry-run` or `--confirm-billable`. Obtain explicit approval immediately before a billable submission. Every create is durable and submitted once.

- `upload video <public-mp4-url>` imports synchronously and is free; never repeat an ambiguous import automatically.
- `template get/poll` uses `video_id`; `viral-clone get/poll` uses `run_id`; `product-suite get/poll` uses `task_id`.
- `variation get/poll` follows one video ID. `variation resume <job-dir>` follows every saved ID and preserves `input_indices` and the batch ledger ID.
- Each workflow supports `resume <job-dir>`, which never creates anything. Missing IDs require reconciliation.
- Product Image Suite `completed` and variation batch `completed` do not mean all outputs succeeded. Inspect every image/video status and retain failure details.
- `wallet discount` reads the percentage payable. Ledgers are the source of truth for actual charges; catalog milli-credits, video US cents, and ledger decimal currency strings are different units.
- `video list --kind template|variation|hook|uploaded` filters the list. Preserve filters and the opaque cursor while paging.

PDP and `wallet balance` are legacy capabilities absent from the current public guide; retain them for existing integrations without assuming current entitlement. Do not use internal web-session routes or web-login credentials.

## Legacy PDP workflow

1. Prepare a product with a title and one to eight uploaded `https://media.pixverse.ai/...` image URLs.
2. Copy `references/pdp-standard-high.json` beside this skill to a job-specific location and replace only its neutral example values.
3. Run `growth-studio pdp create --payload <absolute-path> --dry-run`. Dry run uses no credentials, creates no job, and sends no request.
4. Optionally run `growth-studio wallet balance` as a read-only snapshot. It is not a price quote or spending approval.
5. Obtain explicit approval immediately before one `--confirm-billable` create.
6. Preserve the returned `job_dir`, `video_id`, and `ledger_source_id`, then poll or resume that job.

The current PDP request requires `product`. `video` may be omitted, `null`, or an object. An object requires `mode` set to `standard` or `pro`; `quality` may be `normal` or `high`. Omitted and null video configuration use provider defaults and are omitted from the wire request.

PDP submits exactly once to `POST /openapi/v1/ecommerce_pdp/video`, with only `product` and the optional `video` object in the request body. There is no fallback create route and no completion callback. Wait five seconds before the first status read, then poll the returned video resource and honor `Retry-After` while it remains queued or processing.

## Recovery

A successful create acceptance means queued and charged, not completed. Never retry a create automatically after a timeout, connection loss, malformed response, or interrupted poll. If a saved video ID exists, use `pdp resume <job-dir>`. If no ID was saved, retain the redacted evidence and stop at reconciliation.

Use `references/growth-studio-pdp.md` and `references/safety-and-recovery.md` beside this skill for exact fields, artifacts, errors, and recovery rules.
