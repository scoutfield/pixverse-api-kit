---
name: start
description: Start here for PixVerse API Plugin setup, provider selection, safety boundaries, and routing to Platform or Growth Studio.
---

# PixVerse API Plugin

Use this skill to choose the correct server-side PixVerse API. This plugin is separate from the PixVerse web-product CLI named `pixverse`.

## CLI location

When this skill is inside the installed plugin (`<plugin-root>/skills/start/SKILL.md`), run `<plugin-root>/scripts/pixverse-api` so the skill and CLI versions always match. When it is installed as a standalone Agent Skill, run `pixverse-api`, which the PixVerse API Plugin installer places on `PATH`. Do not use a package checkout or package-manager link.

Begin with `pixverse-api --help` (or the plugin wrapper equivalent).

## Provider choice

- Use the `platform` skill (`pixverse-api-platform` when installed standalone) for Platform API discovery, uploads, generation, editing, specialized agents, account reads, status, webhooks, and recovery.
- Use the `growth-studio` skill (`pixverse-api-growth-studio` when installed standalone) for Growth Studio product/template videos, Viral Clone, Video Variations, Product Image Suites, video imports, discounts, legacy PDP, status, and recovery.
- Platform uses only `PIXVERSE_PLATFORM_API_KEY`.
- Growth Studio uses only `PIXVERSE_GROWTH_API_KEY`.
- Never substitute one provider's key, balance, identifiers, or approval for the other.

## Credentials

For customer setup, prefer the packaged `auth.command` helper. It saves the dedicated Platform and Growth Studio API keys in the user's private PixVerse API Plugin support folder. For command-line setup, use `pixverse-api auth login platform --stdin`, `pixverse-api auth login growth-studio --stdin`, `pixverse-api auth status`, and `pixverse-api auth logout ...`.

## Shared safety

Start with help, discovery, read-only checks, or a dry run. Before any billable request, show the exact provider, operation, payload, and known cost information, then obtain explicit approval for that submission. Submit once, preserve returned identifiers and job artifacts, and resume polling rather than recreating an unclear or interrupted job.

Never ask the user to paste an API key into chat, a prompt, a payload, or a command argument. Keep all provider identifiers as strings.

See `references/command-reference.md` and `references/safety-and-recovery.md` beside this skill for the full command and recovery references.
