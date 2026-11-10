import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizePdpPayload } from "../src/growth-studio/pdp.js";
import { normalizeViralClonePayload } from "../src/growth-studio/viral-clone.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_ROOT = path.join(ROOT, ".agents/skills/pixverse-growth-studio-api");
const PUBLIC_DOCS = [
  "README.md",
  "docs/api/command-reference.md",
  "docs/api/safety-and-recovery.md",
  "docs/api/growth-studio-pdp.md",
  "docs/api/growth-studio-viral-clone.md",
  "docs/api/growth-studio-overview.md",
];

async function read(relativePath) {
  return fs.readFile(path.join(ROOT, relativePath), "utf8");
}

async function readSkill(relativePath) {
  return fs.readFile(path.join(SKILL_ROOT, relativePath), "utf8");
}

function localMarkdownLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)#]+)(?:#[^)]+)?\)/g)]
    .map((match) => match[1]);
}

test("PDP payload reference is merchant-neutral and accepted by the executable normalizer", async () => {
  const raw = await readSkill("references/pdp-payload.json");
  const payload = JSON.parse(raw);
  const snapshot = structuredClone(payload);
  const normalized = normalizePdpPayload(payload);

  assert.deepEqual(payload, snapshot);
  assert.equal(payload.type, undefined);
  assert.equal(payload.product.source_url, undefined);
  assert.equal(payload.folder_id, undefined);
  assert.equal(payload.metadata, undefined);
  assert.equal("type" in normalized, false);
  assert.equal(payload.product.images.length >= 1, true);
  assert.equal(payload.video.mode, "pro");
  for (const { url } of payload.product.images) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "https:");
    assert.equal(parsed.origin, "https://media.pixverse.ai");
  }

  assert.doesNotMatch(raw, /revolve|lioness|amazon|shopify|feishu\.cn/i);
  assert.doesNotMatch(raw, /api[_-]?key|bearer\s|mh_live_/i);
});

test("entry skills discover PDP while routing operational detail to references", async () => {
  const skill = await readSkill("SKILL.md");
  const umbrella = await read(".agents/skills/pixverse-api/SKILL.md");

  assert.match(skill, /^---\nname: pixverse-growth-studio-api\ndescription: [^\n]+\n---/);
  assert.doesNotMatch(skill, /\[TODO:/);
  assert.match(skill, /growth-studio pdp create/);
  assert.match(skill, /--dry-run/);
  assert.match(skill, /--confirm-billable/);
  assert.match(skill, /references\/pdp-payload\.json/);
  assert.match(skill, /references\/pdp-workflow\.md/);
  assert.match(skill, /docs\/api\/growth-studio-pdp\.md/);
  assert.doesNotMatch(skill, /\/openapi\/v1\/ka\/videos|ecommerce_fashion_pdp/);

  assert.match(umbrella, /PDP|product.detail.page/i);
  assert.match(umbrella, /pixverse-growth-studio-api/);
  assert.match(umbrella, /PIXVERSE_GROWTH_API_KEY/);
  assert.match(umbrella, /PIXVERSE_PLATFORM_API_KEY/);
});

test("PDP workflow preserves billing, entitlement, and recovery invariants", async () => {
  const workflow = await readSkill("references/pdp-workflow.md");

  for (const command of [
    "growth-studio upload image",
    "growth-studio pdp create",
    "--dry-run",
    "growth-studio wallet balance",
    "--confirm-billable",
    "growth-studio pdp resume",
    "growth-studio wallet ledgers",
  ]) {
    assert.ok(workflow.includes(command), `missing workflow command: ${command}`);
  }

  assert.match(workflow, /any seller or merchant/i);
  assert.match(workflow, /fashion|apparel/i);
  assert.match(workflow, /uploaded.*media\.pixverse\.ai|media\.pixverse\.ai.*uploaded/i);
  assert.match(workflow, /explicit approval.*immediately before|immediately before.*explicit approval/i);
  assert.match(workflow, /202.*charged.*queued|charged.*queued.*202/i);
  assert.match(workflow, /403.*entitle|entitle.*403/i);
  assert.match(workflow, /never.*retr(?:y|ied)|do not.*resubmit/i);
  assert.match(workflow, /wallet.*(snapshot|preflight).*(not|does not|cannot).*price|not.*price.*wallet/i);
  assert.match(workflow, /source_type.*video/i);
  assert.match(workflow, /ledger_source_id/);
  assert.match(workflow, /string/i);
  assert.match(workflow, /free generation|no ledger entry/i);
  assert.match(workflow, /reconciliation_required/);
  assert.doesNotMatch(workflow, /revolve|lioness|amazon|shopify|feishu\.cn/i);
});

test("Growth Studio PDP links resolve inside the skill or repository", async () => {
  for (const relativeFile of ["SKILL.md", "references/pdp-workflow.md"]) {
    const markdown = await readSkill(relativeFile);
    for (const target of localMarkdownLinks(markdown)) {
      const resolved = path.resolve(SKILL_ROOT, path.dirname(relativeFile), target);
      assert.equal(resolved.startsWith(`${ROOT}${path.sep}`), true);
      if (target.startsWith("references/")) {
        assert.equal(resolved.startsWith(`${SKILL_ROOT}${path.sep}`), true);
      }
      await fs.access(resolved);
    }
  }
});

test("public PDP documentation is linked and states the safe single-submit contract", async () => {
  const texts = await Promise.all(PUBLIC_DOCS.map(read));
  const [readme, commandReference, safety, guide] = texts;
  const combined = texts.join("\n");

  assert.match(readme, /docs\/api\/growth-studio-pdp\.md/);
  assert.match(commandReference, /growth-studio pdp create/);
  assert.doesNotMatch(commandReference, /Growth Studio has no dry-run command/i);
  assert.match(safety, /ledger-source-id\.json/);
  assert.match(guide, /202.*charged.*queued|charged.*queued.*202/i);
  assert.match(guide, /403.*entitle|entitle.*403/i);
  assert.match(guide, /existing.*URL-based|URL-based.*separate/i);
  assert.match(guide, /fashion|apparel/i);
  assert.match(guide, /any seller or merchant/i);
  assert.match(guide, /source_type.*video/i);
  assert.match(guide, /free generation|no ledger entry/i);
  assert.match(guide, /ledger-source-id\.json/);
  assert.match(guide, /\/openapi\/v1\/ecommerce_pdp\/video/);
  assert.doesNotMatch(guide, /\/openapi\/v1\/ka\/videos|ecommerce_fashion_pdp/);
  assert.doesNotMatch(combined, /aisphere\.feishu\.cn|feishu\.cn\/docx/i);
});

test("local links in the changed public documentation resolve inside the repository", async () => {
  for (const relativeFile of PUBLIC_DOCS) {
    const markdown = await read(relativeFile);
    for (const target of localMarkdownLinks(markdown)) {
      const resolved = path.resolve(ROOT, path.dirname(relativeFile), target);
      assert.equal(resolved.startsWith(`${ROOT}${path.sep}`), true);
      await fs.access(resolved);
    }
  }
});

test("Viral Clone payload references are neutral, identical, and accepted by the normalizer", async () => {
  const raw = await readSkill("references/viral-clone-payload.json");
  const example = await read("packaging/customer-plugin/plugin/examples/viral-clone-plus.json");
  assert.equal(example, raw);
  const payload = JSON.parse(raw);
  assert.deepEqual(normalizeViralClonePayload(payload), payload);
  assert.equal(typeof payload.source_video_id, "string");
  assert.equal(payload.video.duration_seconds, undefined);
  assert.doesNotMatch(raw, /revolve|lioness|amazon|shopify|feishu\.cn/i);
  assert.doesNotMatch(raw, /api[_-]?key|bearer\s|mh_live_/i);
});

test("Viral Clone, import, and overview documentation states the safety contract", async () => {
  const skill = await readSkill("SKILL.md");
  const guide = await read("docs/api/growth-studio-viral-clone.md");
  const overview = await read("docs/api/growth-studio-overview.md");
  const commandReference = await read("docs/api/command-reference.md");
  const readme = await read("README.md");
  const pluginSkill = await read("packaging/customer-plugin/plugin/skills/growth-studio/SKILL.md");

  for (const text of [skill, pluginSkill, commandReference]) {
    for (const command of ["viral-clone create", "--confirm-billable", "video import-url", "wallet discount", "models list", "images list"]) {
      assert.ok(text.includes(command), `missing ${command}`);
    }
    assert.match(text, /undocumented/i);
  }
  for (const text of [skill, pluginSkill, guide, readme]) {
    assert.match(text, /ledger_source_id/);
    assert.match(text, /pre-discount integer cents/);
  }
  assert.match(guide, /\/openapi\/v1\/viral-clone\/runs/);
  assert.match(guide, /run-id\.json/);
  assert.match(guide, /reconciliation_required/);
  assert.match(guide, /never retr/i);
  assert.match(guide, /server-managed/);
  assert.match(guide, /RUN_NOT_FOUND/);
  assert.match(guide, /CONCURRENCY_LIMIT_EXCEEDED/);
  assert.match(guide, /UPLOAD_FAILED/);
  assert.match(overview, /https:\/\/docs\.pixverse\.ai\/growth-studio-openapi-integration-guide/);
  assert.match(overview, /Undocumented — observed live 2026-10-23/);
  for (const route of ["/avatars", "/image/upload", "/videos/{video_id}/edit", "/folders", "/viral-clone/runs/{run_id}", "/video/upload", "/wallet/discount", "/wallet/ledgers", "/ecommerce_pdp/video", "/wallet/balance", "/models", "/images", "/ka/videos"]) {
    assert.ok(overview.includes(route), `overview missing ${route}`);
  }
  for (const text of [readme, commandReference, await read("docs/api/growth-studio-pdp.md"), guide, skill, pluginSkill]) {
    assert.match(text, /growth-studio-overview\.md/);
  }
});
