# Platform Operations

The checked operation source is `src/platform/operations.js`; the independent test fixture is `test/fixtures/platform/official-operation-inventory.json`.

For the complete table, see `.agents/skills/pixverse-platform-api/references/operation-catalog.md`.

Coverage marker summary:

- account: `account.balance`, `account.usage`
- upload: `upload.image`, `upload.media`
- audio review: `audio.verify`
- resources: `resource.templates`, `resource.tts-speakers`, `resource.restyle-effects`
- voice: `voice.create`, `voice.delete`
- image: `image.template`, `image.status`
- video generation/editing: `video.text`, `video.image`, `video.template`, `video.transition`, `video.multi-transition`, `video.lip-sync`, `video.fusion`, `video.restyle`, `video.swap-mask`, `video.swap`, `video.sound-effect`, `video.extend`, `video.motion-control`, `video.modify`, `video.upscale`, `video.expand`, `video.avatar`, `video.status`
- agents: `agent.viral-recreation`, `agent.real-estate`, `agent.music-mv`

Music MV prerequisite chain: `upload.media` -> `audio.verify` -> optional `upload.image` -> `agent.music-mv` -> `video.status` or `resume`. The generation call is billable and must use the durable Platform job path.
