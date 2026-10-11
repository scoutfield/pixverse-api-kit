# Models, Pricing, and Limits

Verified against official docs: 2026-09-20.

These provider facts can change independently of this CLI. Re-check the linked official pages before making a current compatibility, price, credit, duration, resolution, upload, QPS, or concurrency claim. For templates, TTS speakers, restyle effects, balance, and usage, prefer the read-only Platform operations at execution time.

## Model choice

| Need | Checked guidance | Verify live |
|---|---|---|
| Text/image/transition/fusion generation | C1 or V6, subject to endpoint parameters | Model overview, C1, V6, capability matrix |
| Video extension | V6 in the checked matrix | V6 and capability matrix |
| Standalone restyle/swap/mimic/modify/sound/lip-sync/image-template work | Use its dedicated endpoint; do not assume the base model selector applies | Endpoint page and pricing |

Both current C1 and V6 pages describe up to 15 seconds and 1080p for their supported generation modes, but exact parameter combinations remain endpoint-specific. The CLI validators are the authority for what this installed CLI version accepts; the official docs are the authority for current provider availability.

## Billing distinctions

- Account/resource/status discovery is read-only.
- Upload and custom-voice management are cataloged as non-billable in this CLI version.
- Generation, editing, enhancement, swap-mask selection, and agents are cataloged as billable.
- Pricing may be per second, per request, or feature/model-specific. Consult the live pricing page and, for templates, the live returned credit metadata before stating cost.
- Platform API credits and membership are separate from PixVerse web-app credits.

### Music MV snapshot

- `agent.music-mv` charges 15 credits per generated second at 720p, with duration rounded up.
- 1080p uses a 1.5x multiplier: 22.5 credits per generated second according to the reviewed interface document.
- Treat those rates as a dated provider snapshot. Check balance and reconfirm the exact paid payload before submission; the CLI does not infer spending authorization from a local estimate.

## Limits and media boundaries

- Image upload validation accepts JPG/JPEG/PNG/WebP, requires size below 20 MB, and enforces dimensions no larger than 10,000 px in this CLI version.
- General media upload accepts MP4/MOV/WebM and MP3/WAV/M4A/AAC; video dimensions are capped at 1920 by the checked validator. Specialized endpoints can impose tighter size/duration/dimension rules.
- Concurrency depends on the current Platform membership. Query or consult the live rate-limit page and respect `Retry-After` or provider errors; do not encode membership concurrency as timeless constants.
- Music MV accepts 10 to 360 seconds of audio, up to 15 MB, with five aspect ratios and 720p or 1080p output. The reviewed interface reports a provider concurrency limit of 10 and fifteen built-in visual styles plus `Custom`.

## Dynamic catalogs

Use `resource.templates`, `resource.tts-speakers`, and `resource.restyle-effects` as the current source for templates, voices, and style presets. Verify live instead of treating a saved count or list as permanent.

## Primary sources

- [Model overview](https://docs.platform.pixverse.ai/model-overview-2140345m0)
- [C1](https://docs.platform.pixverse.ai/c1-2067883m0)
- [V6](https://docs.platform.pixverse.ai/v6-2056814m0)
- [Capability matrix](https://docs.platform.pixverse.ai/capability-matrix-2144288m0)
- [Pricing](https://docs.platform.pixverse.ai/pricing-796039m0)
- [Rate limits](https://docs.platform.pixverse.ai/rate-limit-796040m0)
- [Image upload](https://docs.platform.pixverse.ai/upload-image-13016631e0)
- [Video and audio upload](https://docs.platform.pixverse.ai/upload-videoaudio-19094401e0)
- [One-click VibeMV](https://docs.platform.pixverse.ai/one-click-vibemv-44175576e0)
