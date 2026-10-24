# Models, Pricing, and Limits

Verified against official docs: 2026-10-23.

These provider facts can change independently of this CLI. Re-check the linked official pages before making a current compatibility, price, credit, duration, resolution, upload, QPS, or concurrency claim. For templates, TTS speakers, restyle effects, balance, and usage, prefer the read-only Platform operations at execution time.

## Model choice

| Model | `model` value | Supported operations | Duration | Aspect ratios |
|---|---|---|---|---|
| V6 Max | `v6-max` | Text-to-video and image-to-video only (no templates, transition, fusion, or extend) | 1–15 s | 16:9, 9:16, 4:3, 3:4, 1:1, 2:3, 3:2, 21:9 |
| C1 | `c1` | Text, image, template, first/last frame, fusion | 1–15 s | Same eight ratios |
| V6 | `v6` | Text, image, template, first/last frame, fusion (incl. video references), extend | 1–15 s | Same eight ratios |
| V5.6 | `v5.6` | Text, image, template, first/last frame, fusion | 5 / 8 / 10 s | 16:9, 9:16, 4:3, 3:4, 1:1 |
| V5 | `v5` | Core generation and multi-transition | 5 / 8 s | 16:9, 9:16, 4:3, 3:4, 1:1 |

All five support 360p, 540p, 720p, and 1080p. Standalone restyle, swap, mimic, modify, sound, lip-sync, avatar, upscale, expand, and image-template work use their dedicated endpoints; the base model selector does not apply. The CLI validators are the authority for what this installed CLI version accepts; the official docs are the authority for current provider availability.

## Cost reporting

Every Platform call result carries a `cost` object (and the CLI prints a one-line `Cost:` summary on stderr). Always report the dollar cost to the user after any Platform call.

- `source: "status"` — credits the finished task actually consumed (status `Resp.credits`). Most authoritative.
- `source: "response"` — the creation response's request-level `Resp.credits`.
- `source: "estimate"` — computed locally from the table below; `credits: null` when the total depends on source/audio length or a template's `credit_consume`, with the per-second rate in `basis`.
- `source: "non-billable"` — reads, uploads, and voice management cost $0. `video status` also reports the task's `task_credits`/`task_usd`.
- `--dry-run` returns `cost_estimate` so spend can be confirmed before submission.

USD = credits ÷ 225 (1 credit ≈ US$0.004444), rounded to three decimals after totaling. The account ledger is final; plans, volume agreements, and promotions change effective cost.

## Pricing (credits; source: official pricing page, 2026-10-23)

### Per generated second — V6 Max, C1, V6, V6 video references

| Model | Audio | 360p | 540p | 720p | 1080p |
|---|---|---:|---:|---:|---:|
| V6 Max | off | 6 | 9 | 11 | 22 |
| V6 Max | on | 9 | 11 | 15 | 28 |
| C1 | off | 6 | 8 | 10 | 19 |
| C1 | on | 8 | 10 | 13 | 24 |
| V6 | off | 5 | 7 | 9 | 18 |
| V6 | on | 7 | 9 | 12 | 23 |
| V6 fusion with `video_references` | off | 10 | 14 | 18 | 36 |
| V6 fusion with `video_references` | on | 14 | 18 | 24 | 46 |

V6 Extend uses the V6 rate for the generated duration. Audio "on" means `generate_audio_switch` (or `sound_effect_switch`) is true.

### Fixed per request — V5.6, V5.5, V5

| Model | Duration | Audio | 360p | 540p | 720p | 1080p |
|---|---|---|---:|---:|---:|---:|
| V5.6 | 5 s | off / on | 35 / 80 | 35 / 80 | 45 / 90 | 75 / 120 |
| V5.6 | 8 s | off / on | 70 / 115 | 70 / 115 | 90 / 135 | 150 / 195 |
| V5.6 | 10 s | off / on | 77 / 122 | 77 / 122 | 99 / 144 | not supported |
| V5.5 single-shot | 5 s | off / on | 45 / 55 | 45 / 55 | 60 / 70 | 120 / 130 |
| V5.5 single-shot | 8 s | off / on | 90 / 100 | 90 / 100 | 120 / 130 | 240 / 250 |
| V5.5 single-shot | 10 s | off / on | 99 / 109 | 99 / 109 | 132 / 142 | not supported |
| V5.5 multi-shot | 5 s | off / on | 75 / 85 | 75 / 85 | 90 / 100 | 150 / 160 |
| V5.5 multi-shot | 8 s | off / on | 120 / 130 | 120 / 130 | 150 / 160 | 270 / 280 |
| V5.5 multi-shot | 10 s | off / on | 129 / 139 | 129 / 139 | 162 / 172 | not supported |
| V5 | 5 s | — | 45 | 45 | 60 | 120 |
| V5 | 8 s | — | 90 | 90 | 120 | 240 |

### Solutions

| Capability | Basis | Rate |
|---|---|---|
| Video Expand | input-video second, rounded up | 12/s at 720p, 24/s at 1080p |
| Lip sync, uploaded audio | audio second, rounded up | 4/s |
| Lip sync, TTS | 15 UTF-8 bytes, rounded up | 4/unit |
| Sound effects | source-video second | 2/s |
| Restyle | source-video second | 10/s |
| Swap mask selection | request | 2 |
| Upscale | source-video second | 5/s |
| Swap | source second | 9 / 9 / 12 (360p/540p/720p); 1080p not listed |
| Motion control (mimic) | source second | 9 / 10 / 12; 1080p not listed |
| Modify | source second | 8 / 10 / 12; 1080p not listed |
| Viral Recreation Agent | generated second | 80 at 720p, 157 at 1080p |
| Avatar | audio second or 15 TTS bytes, rounded up | 5 / 10 / 15 / 20 per unit (360p/540p/720p/1080p) |

### Multi-transition (`motion_mode=normal`; `fast` doubles)

Per segment: 1 s 23/30/60, 2 s 27/36/72, 3 s 32/42/84, 4 s 36/48/96, 5 s 45/60/120, 6 s 59/78/156, 7 s 72/96/192, 8 s 90/120/240, 9 s 95/126/252, 10 s 99/132/264, 15 s 135/180/360, 20 s 180/240/480, 25 s 225/300/600, 30 s 270/360/720 (360p–540p / 720p / 1080p).

### Templates

Use the selected template's `credit_consume` from `resource.templates` for the requested quality. Do not reuse a historical fixed price.

### Worked examples

- C1, 1080p, audio off, 5 s → 19 × 5 = 95 credits ≈ US$0.422
- V6, 720p, audio on, 8 s → 12 × 8 = 96 credits ≈ US$0.427
- V5.6, 720p, audio on, 8 s → 135 credits ≈ US$0.600
- Avatar, 720p, 20 s uploaded audio → 20 × 15 = 300 credits ≈ US$1.333

## Billing distinctions

- Account/resource/status discovery is read-only.
- Upload and custom-voice management are cataloged as non-billable in this CLI version.
- Generation, editing, enhancement, swap-mask selection, and agents are cataloged as billable.
- HTTP 200 with `ErrCode=0` confirms acceptance, not settlement. For failed tasks, confirm the refund entry; refunds may be delayed.
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

- [Model capability map](https://docs.platform.pixverse.ai/model-capability-map-2394982m0)
- [Pricing](https://docs.platform.pixverse.ai/pixverse-api-pricing-2394995m0)
- [Billing and usage](https://docs.platform.pixverse.ai/billing-and-usage-2394984m0)
- [Concurrency rules](https://docs.platform.pixverse.ai/concurrency-rules-2394990m0)
- [Error details](https://docs.platform.pixverse.ai/error-details-2490131m0)
- [Changelog](https://docs.platform.pixverse.ai/changelog-2394996m0)
- [Image upload](https://docs.platform.pixverse.ai/upload-image-13016631e0)
- [Video and audio upload](https://docs.platform.pixverse.ai/upload-media-video-and-audio-43051206e0)
- [One-click VibeMV](https://docs.platform.pixverse.ai/one-click-vibemv-44144151e0)
