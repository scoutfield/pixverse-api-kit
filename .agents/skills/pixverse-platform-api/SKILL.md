---
name: pixverse-platform-api
description: Use this skill for PixVerse Platform API commands, payload validation, uploads, generation, polling, webhooks, and recovery through pixverse-api platform.
---

# PixVerse Platform API

Use this skill for the server-side Platform API through `pixverse-api platform`. It is separate from the web `pixverse` CLI and from `pixverse-api growth-studio`; credentials, credits, commands, and job artifacts do not cross those boundaries.

## Route the request

- Read [capabilities](references/capabilities.md) to select an operation or build a prerequisite chain from a user goal.
- Read [operation catalog](references/operation-catalog.md) for the exact command, method, path, billing class, async behavior, result ID, and official endpoint page.
- Read [payload examples](references/payload-examples.json) before authoring a payload or query.
- Read [models, pricing, and limits](references/models-pricing-and-limits.md) when model compatibility, upload constraints, credits, throughput, templates, speakers, or presets affect the task; refresh volatile facts live.
- Read [workflows and recovery](references/workflows-and-recovery.md) before uploads, billable submission, polling, resume, webhook handling, or raw diagnostics.
- Read [troubleshooting](references/troubleshooting.md) when configuration, validation, provider, moderation, status, rate, or ambiguous-submission errors occur.

## Provider boundary

Use only `PIXVERSE_PLATFORM_API_KEY` and the default `https://app-api.pixverse.ai`. Never use Growth Studio keys, web-session credentials, or another provider's credit balance. Preserve all API IDs as strings.

## Safe execution

1. Resolve prerequisites with read-only catalog/account calls.
2. Validate a specialized command locally and run it with `--dry-run`.
3. For a billable operation, confirm the exact live spend is authorized in the active request immediately before submission.
4. Submit once with a fresh trace ID, preferably through `run-job`; Platform billable commands wait by default and preserve the job directory, result ID, polling history, and terminal result.
5. Use `--no-wait` only when asynchronous return is required, then continue the known job with `resume`. If submission was ambiguous and no result ID was saved, stop at `reconciliation_required`; do not resubmit.
6. Treat success as transport success plus `ErrCode === 0`.
7. After every Platform call, report the dollar cost from the result's `cost` field (credits and USD, plus whether it is provider-reported or an estimate). Before a billable submission, quote the `--dry-run` `cost_estimate`.

Use `platform raw` only for diagnosis or a newly documented endpoint absent from the specialized catalog. Do not use raw access to bypass specialized validation, authentication, trace, billing, or recovery controls.

## Operation markers

- operation:account.balance
- operation:account.usage
- operation:upload.image
- operation:upload.media
- operation:audio.verify
- operation:resource.templates
- operation:resource.tts-speakers
- operation:resource.restyle-effects
- operation:voice.create
- operation:voice.delete
- operation:image.template
- operation:image.status
- operation:video.text
- operation:video.image
- operation:video.template
- operation:video.transition
- operation:video.multi-transition
- operation:video.lip-sync
- operation:video.fusion
- operation:video.restyle
- operation:video.swap-mask
- operation:video.swap
- operation:video.sound-effect
- operation:video.extend
- operation:video.motion-control
- operation:video.modify
- operation:video.upscale
- operation:video.expand
- operation:video.avatar
- operation:agent.viral-recreation
- operation:agent.real-estate
- operation:agent.music-mv
- operation:video.status
