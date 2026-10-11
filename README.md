# PixVerse API Kit

Agent-safe PixVerse API tools for two dedicated server-side APIs:

- **Platform API** — discovery, uploads, image/video generation, editing, agents, account reads, status, webhooks, and durable recovery.
- **Growth Studio API** — PDP product videos, uploads, folders, wallet reads, product-page workflows, polling, and durable recovery.

The installed command is `pixverse-api`. It is separate from the public PixVerse web CLI named `pixverse`.

## Repository boundary

Customer pitch pages, reviewed customer payloads, pitch-production evidence, and pitch QA now live in the private [`pixverse-pitch-studio`](https://github.com/heshaojian/pixverse-pitch-studio) repository. This API Kit owns only the Platform and Growth Studio CLI, API skills and documentation, durable recovery, security controls, and customer-plugin packaging.

Historical pitch material remains in this repository's Git history. Share the curated customer plugin, not this development repository, unless a separately reviewed distribution repository is approved.

## Quick start

### 1. Install the packaged CLI and agent plugin

Build the self-contained package:

```bash
npm run package:customer-plugin
```

Open the generated archive:

```bash
open dist/customer-plugin/0.3.0-beta.3/pixverse-api-plugin-0.3.0-beta.3.zip
```

Then double-click `install.command` inside the extracted folder. If macOS blocks it, Control-click `install.command`, choose **Open**, and confirm.

Command-line install from the extracted folder:

```bash
zsh ./install.command
```

The installer registers the plugin with every supported coding agent it finds, and installs the CLI in a global Node-style layout:

| Agent | How it is registered |
|---|---|
| Codex | Native plugin from the local `pixverse-private-beta` marketplace |
| Claude Code | Native plugin from the same local marketplace (`claude plugin install pixverse-api@pixverse-private-beta`) |
| Gemini CLI | Standalone Agent Skills in `~/.gemini/skills/` |
| Cursor | Standalone Agent Skills in `~/.cursor/skills/` |
| GitHub Copilot CLI | Standalone Agent Skills in `~/.copilot/skills/` |
| OpenCode | Standalone Agent Skills in `~/.config/opencode/skills/` |

Set `PIXVERSE_API_AGENTS=codex,claude,...` to choose agents explicitly (default `auto`). Any other Agent Skills client can use the three folders in the package's `agent-skills/` directory. See `packaging/customer-plugin/INSTALL-MACOS.md` for details.

CLI layout:

```text
<selected npm prefix>/lib/node_modules/pixverse-api
<selected npm prefix>/bin/pixverse-api -> ../lib/node_modules/pixverse-api/dist/index.js
```

By default it installs beside the existing `pixverse` CLI when one is found, then falls back to `npm prefix -g`. To force the real global npm prefix, run the installer with:

```bash
PIXVERSE_API_SKIP_PIXVERSE_PREFIX=1 zsh ./install.command
```

Verify the install:

```bash
which pixverse-api
pixverse-api --version
pixverse-api --help
```

### 2. Configure credentials

Platform and Growth Studio use different API keys. Do not reuse one provider's key for the other provider.

For most users, use the packaged helper:

```bash
open "$(npm prefix -g)/lib/node_modules/pixverse-api/auth.command"
```

CLI fallback:

```bash
printf '%s' '<platform-api-key>' | pixverse-api auth login platform --stdin
printf '%s' '<growth-studio-api-key>' | pixverse-api auth login growth-studio --stdin
pixverse-api auth status
```

If the key is on your clipboard, this avoids saving accidental newlines:

```bash
pbpaste | tr -d '\r\n' | pixverse-api auth login platform --stdin
pbpaste | tr -d '\r\n' | pixverse-api auth login growth-studio --stdin
```

Credentials are saved for the current macOS user at:

```text
~/.pixverse-api-kit/credentials.env
```

Existing installs that still have credentials under `~/Library/Application Support/PixVerse/api-plugin/credentials.env`
or `~/Library/Application Support/PixVerse/API Plugin/credentials.env` are read as legacy fallbacks and migrated by
the installer/helper the next time credentials are saved.

Never paste API keys into agent chat, prompt files, payload JSON, or shell history as command arguments.

### 3. Verify read-only access

```bash
pixverse-api auth status
pixverse-api platform account balance
pixverse-api growth-studio wallet balance
pixverse-api platform resource templates --payload ./template-query.json
```

### 4. Run a safe dry run before paid work

```bash
pixverse-api platform video text --payload /absolute/path/text-video.json --dry-run
pixverse-api growth-studio pdp create --payload /absolute/path/pdp.json --dry-run
```

For live/billable jobs, use `run-job` or the provider-specific create command with the required confirmation flag. Platform billable jobs wait by default. Keep the generated job directory so interrupted work can be resumed instead of resubmitted.

## Customer package contents

The package artifacts are written to `dist/customer-plugin/0.3.0-beta.3/`:

- `pixverse-api-plugin-0.3.0-beta.3.zip`
- `pixverse-api-plugin-0.3.0-beta.3.zip.sha256`
- `release-report.json`

The build requires Node.js 20+, npm, `zip`, and `unzip`. It stages only approved CLI, API documentation, plugin, and production dependency files; validates the extracted archive; and never reads API credentials or sends paid PixVerse requests. The archive includes double-click macOS install and uninstall helpers plus command-line fallback instructions.

The included private evaluation license is a legal draft. The generated archive must remain local and must not be published, uploaded, or shared externally until legal and release approval are recorded.

## Development setup

This package is private and is not published to npm. Install its pinned dependencies from this checkout, then link the `pixverse-api` binary locally:

```bash
npm ci
npm link
pixverse-api --help
```

If you do not want a global npm link, replace `pixverse-api` in the examples with `npm run cli --`.

For development in this checkout, `.env` still works:

```bash
PIXVERSE_PLATFORM_API_KEY=...
PIXVERSE_PLATFORM_BASE_URL=https://app-api.pixverse.ai

PIXVERSE_GROWTH_API_KEY=mh_live_...
PIXVERSE_GROWTH_BASE_URL=https://growth-api.pixverse.ai
```

Keys stay server-side. Platform and Growth Studio credentials are separate and never fall back to each other.

The default origins are the official HTTPS services. HTTP/HTTPS loopback origins (`localhost`, `127.0.0.1`, or `::1`) are allowed for local tests. Any other origin must use HTTPS and is rejected unless its provider-specific opt-in is set to `true`:

```bash
PIXVERSE_PLATFORM_ALLOW_CUSTOM_BASE_URL=true
PIXVERSE_GROWTH_ALLOW_CUSTOM_BASE_URL=true
```

Those flags deliberately allow credentials to be sent to the configured custom origin. Use them only for a server you control and keep them out of normal production configuration.

## Provider commands

```bash
pixverse-api platform --help
pixverse-api growth-studio --help
```

Platform examples:

```bash
pixverse-api platform account balance
pixverse-api platform account usage --payload /absolute/path/usage-query.json
pixverse-api platform resource templates --payload /absolute/path/template-query.json
pixverse-api platform upload image /absolute/path/reference.png
pixverse-api platform video text --payload /absolute/path/text-video.json --dry-run
pixverse-api platform run-job --operation video.image --payload /absolute/path/image-video.json
pixverse-api platform run-job --operation video.image --payload /absolute/path/image-video.json --no-wait
pixverse-api platform resume /absolute/path/pixverse-api-jobs/platform/<job-dir>
```

### Platform API Capabilities

The Platform provider covers every specialized endpoint currently documented by PixVerse. Discovery and status operations are read-only; uploads and custom-voice management are non-billable; generation, editing, enhancement, and agent operations are billable.

| Area | Operations | What it covers |
|---|---|---|
| Account | `account.balance`, `account.usage` | Current Platform credits and usage deductions or refunds |
| Uploads | `upload.image`, `upload.media` | Images plus video or audio inputs for later operations |
| Audio review | `audio.verify` | Synchronous review of uploaded audio before Music MV generation |
| Live resources | `resource.templates`, `resource.tts-speakers`, `resource.restyle-effects` | Current effect templates, speech voices, and restyle presets |
| Custom voices | `voice.create`, `voice.delete` | Create and remove custom TTS voices |
| Images | `image.template`, `image.status` | Template-based image generation and result polling |
| Core video generation | `video.text`, `video.image`, `video.template` | Text-to-video, image-to-video, and managed template effects |
| Guided video generation | `video.transition`, `video.multi-transition`, `video.fusion`, `video.motion-control` | First/last-frame transitions, ordered keyframes, references, and motion transfer |
| Speech and sound | `video.lip-sync`, `video.avatar`, `video.sound-effect` | Lip sync, talking portraits, and synchronized generated audio |
| Video editing | `video.restyle`, `video.swap-mask`, `video.swap`, `video.modify` | Style transfer, subject or region replacement, and prompt-directed edits |
| Video finishing | `video.extend`, `video.upscale` | Clip continuation and resolution enhancement |
| Specialized agents | `agent.viral-recreation`, `agent.real-estate`, `agent.music-mv` | Viral recreation, real-estate video, and one-click Music MV workflows |
| Retrieval | `video.status` | Poll a known video generation without resubmitting it |

Platform workflows keep credentials, credits, identifiers, validation, and durable job artifacts separate from Growth Studio. Query live resources before choosing templates, speakers, or restyle presets; do not treat saved catalog snapshots as permanent. See [`docs/api/platform-operations.md`](docs/api/platform-operations.md) for the complete operation inventory and [`docs/api/safety-and-recovery.md`](docs/api/safety-and-recovery.md) for billable-job recovery rules.

Growth Studio examples:

```bash
pixverse-api growth-studio avatars list
pixverse-api growth-studio folders list
pixverse-api growth-studio folders ensure "Campaign Alpha"
pixverse-api growth-studio upload image /absolute/path/product.webp
pixverse-api growth-studio pdp create --payload /absolute/path/pdp.json --dry-run
pixverse-api growth-studio wallet balance
pixverse-api growth-studio video create-from-url "https://shop.example.com/products/item"
pixverse-api growth-studio video create-from-json /absolute/path/payload.json
pixverse-api growth-studio run-job --payload /absolute/path/payload.json --folder-name "Campaign Alpha"
pixverse-api growth-studio resume /absolute/path/jobs/<job-dir>
pixverse-api growth-studio video poll 627410861853514292
```

PDP is the merchant-neutral product-detail-page video workflow for the currently supported fashion/apparel category. It uses uploaded PixVerse image URLs, has a credential-free `--dry-run`, and requires explicit approval immediately before a live `--confirm-billable` submission. A live create is submitted once and recorded durably. See [`docs/api/growth-studio-pdp.md`](docs/api/growth-studio-pdp.md).

Legacy Growth Studio aliases such as `get`, `poll`, `run-job`, and `create-from-url` still work during `0.x` and emit one deprecation warning.

## Safety

- Platform uses `API-KEY` and a fresh `Ai-trace-id` for every new request.
- Growth Studio uses `Authorization: Bearer <PIXVERSE_GROWTH_API_KEY>`.
- Keep all IDs as strings.
- Platform billable jobs wait by default. Use `--no-wait` to return after acceptance, then use `resume` with the saved job directory; neither path resubmits generation.
- Use `run-job` for new billable work and `resume` for an existing durable job.
- For PDP, use `--dry-run`, optionally inspect the wallet snapshot, obtain approval immediately before `--confirm-billable`, and submit only once. A `202 Accepted` result is charged and queued.
- After an ambiguous billable response, inspect saved artifacts and known IDs before retrying.
- `resume` polls a saved ID only; it never resubmits a generation. If no ID was saved, it reports that reconciliation is required.
- Default automated tests use loopback or injected clients and do not submit paid jobs.

## Troubleshooting

### `apiKey is not registered`

The CLI found a Platform key, but the Platform service rejected that exact key. Common causes:

- The key belongs to Growth Studio, not Platform.
- The key was copied with hidden characters.
- Multiple copies of a key were pasted into the same prompt.
- A command, file path, or terminal escape sequence was pasted instead of the key.

Reset only the Platform key:

```bash
pixverse-api auth logout platform
pbpaste | tr -d '\r\n' | pixverse-api auth login platform --stdin
pixverse-api platform account balance
```

Reset only the Growth Studio key:

```bash
pixverse-api auth logout growth-studio
pbpaste | tr -d '\r\n' | pixverse-api auth login growth-studio --stdin
pixverse-api growth-studio wallet balance
```

### `pixverse-api: command not found`

Check where npm installs global commands:

```bash
npm prefix -g
ls -l "$(npm prefix -g)/bin/pixverse-api"
```

If the command exists but is not on `PATH`, open a new terminal or add `<npm prefix>/bin` to your shell path.

### An agent does not see the plugin

After install, close and reopen the agent, then start a new task. Codex and Claude Code register:

```text
pixverse-api@pixverse-private-beta
```

You can inspect registration with:

```bash
codex plugin list
claude plugin list
ls ~/.gemini/skills ~/.cursor/skills ~/.copilot/skills ~/.config/opencode/skills
```

The installer's last line names the agents it registered. If an agent was not detected, rerun the installer with `PIXVERSE_API_AGENTS` naming it.

### Force reinstall into the global npm prefix

If you have multiple Node installations and want the package under `npm prefix -g` instead of beside the existing `pixverse` CLI:

```bash
PIXVERSE_API_SKIP_PIXVERSE_PREFIX=1 zsh ./install.command
```

## Docs

- `docs/api/command-reference.md`
- `docs/api/growth-studio-pdp.md`
- `docs/api/platform-operations.md`
- `docs/api/safety-and-recovery.md`
- `.agents/skills/pixverse-api/SKILL.md`
- `.agents/skills/pixverse-platform-api/SKILL.md`
- `.agents/skills/pixverse-growth-studio-api/SKILL.md`

## Job Artifacts

Platform `run-job` writes under `pixverse-api-jobs/platform/` by default. Platform default waiting writes polling snapshots and `final.json`; Platform `--no-wait` writes the accepted request and known ID for later `resume`. Growth Studio `run-job` and live PDP create write under `jobs/` by default. Both providers preserve redacted request evidence, known IDs, polling snapshots, final state, and safe error records. PDP can additionally preserve `ledger-source-id.json`. Use the matching provider or PDP `resume` command with that job directory to continue polling without submitting another generation.
