# Capability Selection

Choose by desired outcome first. Then check the exact operation row and a validated payload example.

## Discover and prepare

| Goal | Operation | Prerequisite/output |
|---|---|---|
| Check credits | `account.balance` | Read-only; use before spend when balance matters. |
| Audit deductions or refunds | `account.usage` | Use UTC range or cursor pagination. |
| Upload a still image | `upload.image` | Produces an image ID string. |
| Upload video or audio | `upload.media` | Produces a media ID string. |
| Verify Music MV audio | `audio.verify` | Synchronously reviews an uploaded audio ID before Music MV generation. |
| Find a current effect | `resource.templates` | Query live; do not use a stored template snapshot. |
| Find a speech voice | `resource.tts-speakers` | Query live system/custom speakers. |
| Find a restyle preset | `resource.restyle-effects` | Query live before `video.restyle`. |
| Clone or remove a voice | `voice.create` / `voice.delete` | Upload audio first for creation. |

## Generate images and videos

| Goal | Choose | Distinction |
|---|---|---|
| Prompt-only video | `video.text` | No image input. |
| Animate one image | `video.image` | Upload image, then pass its ID. |
| Apply a managed effect | `video.template` | Query live templates; this is not free-form generation. |
| Interpolate first and last frames | `video.transition` | Exactly two boundary frames. |
| Move through 2-7 ordered keyframes | `video.multi-transition` | Ordered per-segment durations. |
| Guide generation with named references | `video.fusion` | Image references, and supported video references/modes. |
| Generate from an image template | `image.template` | Poll with `image.status`. |
| Make a portrait speak | `video.avatar` | Portrait plus exactly one audio/TTS source. |

## Edit or augment existing video

| Goal | Choose | Do not confuse with |
|---|---|---|
| Align mouth movement to speech | `video.lip-sync` | Avatar creates from a portrait; lip sync edits video. |
| Change overall visual style | `video.restyle` | Modify changes prompted content. |
| Find replaceable regions | `video.swap-mask` | Run before `video.swap` when no mask is known. |
| Replace a selected subject/region | `video.swap` | Requires the selected keyframe/mask and replacement image. |
| Add synchronized generated audio | `video.sound-effect` | Does not perform speech lip sync. |
| Continue an existing clip | `video.extend` | Not transition between independent frames. |
| Transfer or replicate motion | `video.motion-control` | Not a general prompt edit. |
| Prompt-edit video content | `video.modify` | Optional masks/references narrow the edit. |
| Increase output resolution | `video.upscale` | Enhancement after a video exists. |
| Reframe a video to a new aspect ratio | `video.expand` | Generates content around the source frame; 720p or 1080p; billed by input duration. |

## Specialized agents and retrieval

- `agent.viral-recreation`: use reference images plus exactly one reference video for the viral-recreation workflow.
- `agent.real-estate`: use a listing URL or supported image set for a property-tour/ad workflow.
- `agent.music-mv`: turn verified music into a 720p or 1080p MV with optional character/style references, captions, lyrics, and lip sync.
- `video.status` and `image.status`: poll a known ID; never repeat generation to check progress.

## Compound prerequisite chains

- Image-to-video: `upload.image` -> `video.image` -> `video.status`.
- Template video: `resource.templates` -> `upload.image` -> `video.template` -> `video.status`.
- Swap: source video -> `video.swap-mask` -> `upload.image` -> `video.swap` -> `video.status`.
- TTS lip sync: `resource.tts-speakers` or `voice.create` -> `video.lip-sync` -> `video.status`.
- Audio lip sync: `upload.media` -> `video.lip-sync` -> `video.status`.
- Music MV: `upload.media` -> `audio.verify` -> optional `upload.image` -> `agent.music-mv` -> `video.status` or `resume`.
- Fusion: upload/resolve references -> `video.fusion` -> `video.status`.
