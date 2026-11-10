---
name: pixverse-api
description: Use this skill for the unified PixVerse API CLI router. It covers provider choice, setup, shared safety rules, and when to route to Platform API or Growth Studio API commands.
---

# PixVerse API CLI

Use `pixverse-api` for server-side PixVerse API work in this repository. Keep it separate from the web/product CLI named `pixverse`.

Canonical provider namespaces:

```bash
npm run cli -- platform --help
npm run cli -- growth-studio --help
pixverse-api platform account balance
pixverse-api growth-studio avatars list
```

Provider boundaries:

- `pixverse-api platform ...` uses `PIXVERSE_PLATFORM_API_KEY`, Platform credits, `API-KEY`, and `Ai-trace-id`.
- `pixverse-api growth-studio ...` uses `PIXVERSE_GROWTH_API_KEY`, Growth Studio credits, and bearer auth.
- Platform and Growth Studio credentials never fall back to each other.
- Do not use the general `pixverse` web CLI as a workaround for API work unless the user explicitly asks.

Safety rules:

- Keep keys in `.env` or server environment only. Do not print them.
- Use dry runs for payload inspection when possible.
- Preserve Platform IDs and Growth Studio IDs as strings.
- Use durable job commands for billable work.
- After an unclear billable result, inspect saved artifacts, known IDs, or status endpoints before retrying.

Route to the provider skills for details:

- `pixverse-platform-api` for Platform API operations, webhooks, artifacts, and recovery.
- `pixverse-growth-studio-api` for Growth Studio product/template videos, Viral Clone, Video Variations, Product Image Suites, imports, discounts, legacy PDP, polling, and durable recovery. PDP is merchant-neutral, but its current upstream scope is fashion/apparel.

For PDP, keep the provider boundary explicit: use only `PIXVERSE_GROWTH_API_KEY`, dry-run the public payload first, obtain approval immediately before `--confirm-billable`, and recover from artifacts rather than resubmitting an ambiguous create.
