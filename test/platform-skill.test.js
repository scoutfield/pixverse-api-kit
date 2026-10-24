import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PLATFORM_OPERATIONS } from "../src/platform/operations.js";
import { normalizePlatformStatus } from "../src/platform/status.js";
import { normalizeAndValidatePlatformInput } from "../src/platform/validation.js";

const ROOT = process.cwd();
const SKILL_ROOT = path.join(ROOT, ".agents/skills/pixverse-platform-api");
const REFERENCES = [
  "capabilities.md",
  "operation-catalog.md",
  "payload-examples.json",
];
// Music MV is documented as One-click VibeMV; audio.verify has its own page.
const MUSIC_MV_DOCUMENTATION_URLS = {
  "audio.verify": "https://docs.platform.pixverse.ai/verify-uploaded-audio-43051207e0",
  "agent.music-mv": "https://docs.platform.pixverse.ai/one-click-vibemv-44144151e0",
};
const MUSIC_MV_OPERATION_IDS = new Set(["audio.verify", "agent.music-mv"]);

async function readSkill(relativePath) {
  return fs.readFile(path.join(SKILL_ROOT, relativePath), "utf8");
}

function localMarkdownLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g)]
    .map((match) => match[1]);
}

function parseCatalog(markdown) {
  const rows = markdown.split("\n")
    .filter((line) => /^\| operation:/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim().replaceAll("`", "")));
  return new Map(rows.map((row) => [row[0].replace("operation:", ""), {
    command: row[1], method: row[2], path: row[3], billing: row[4],
    asynchronous: row[5], resultIdPath: row[6], prerequisite: row[7], documentationUrl: row[8],
  }]));
}

function visitIdentifiers(value, key = "") {
  if (Array.isArray(value)) return value.flatMap((item) => visitIdentifiers(item, key));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([childKey, child]) => visitIdentifiers(child, childKey));
  }
  return /(^|_)(id|ids)$/.test(key) ? [{ key, value }] : [];
}

function parseStatusTable(markdown) {
  return new Map(markdown.split("\n")
    .filter((line) => /^\| [15678] \|/.test(line))
    .map((line) => {
      const [code, name, terminal] = line.split("|").slice(1, 4).map((cell) => cell.trim().replaceAll("`", ""));
      return [Number(code), { name, terminal: terminal === "yes" }];
    }));
}

test("Platform skill exposes the complete progressively disclosed resource graph", async () => {
  const skill = await readSkill("SKILL.md");
  const ui = await readSkill("agents/openai.yaml");

  assert.match(skill, /name: pixverse-platform-api/);
  assert.match(skill, /pixverse-api platform/);
  assert.match(skill, /not.*web.*pixverse|separate.*web.*pixverse/i);
  assert.match(skill, /not.*growth.?studio|separate.*growth.?studio/i);
  assert.match(ui, /display_name: "PixVerse Platform API"/);
  assert.match(ui, /allow_implicit_invocation: true/);
  assert.match(ui, /\$pixverse-platform-api/);

  for (const reference of REFERENCES) {
    assert.match(skill, new RegExp(`references/${reference.replace(".", "\\.")}`));
  }
  for (const operation of PLATFORM_OPERATIONS) {
    assert.match(skill, new RegExp(`operation:${operation.id.replaceAll(".", "\\.")}`));
  }
});

test("all local Markdown links in the skill resolve inside the skill folder", async () => {
  const markdownFiles = ["SKILL.md", "references/capabilities.md"];
  for (const relativeFile of markdownFiles) {
    const markdown = await readSkill(relativeFile);
    for (const target of localMarkdownLinks(markdown)) {
      const resolved = path.resolve(SKILL_ROOT, path.dirname(relativeFile), target);
      assert.equal(resolved.startsWith(`${SKILL_ROOT}${path.sep}`), true);
      await fs.access(resolved);
    }
  }
});

test("operation reference is traceable to every executable catalog row", async () => {
  const catalog = parseCatalog(await readSkill("references/operation-catalog.md"));
  assert.equal(catalog.size, PLATFORM_OPERATIONS.length);
  for (const operation of PLATFORM_OPERATIONS) {
    const row = catalog.get(operation.id);
    assert.ok(row, `missing ${operation.id}`);
    assert.equal(row.command, `platform ${operation.command.join(" ")}`);
    assert.equal(row.method, operation.method);
    assert.equal(row.path, operation.path);
    assert.equal(row.billing, operation.billing);
    assert.equal(row.asynchronous, operation.asynchronous ? "yes" : "no");
    assert.equal(row.resultIdPath, operation.resultIdPath ?? "none");
    assert.notEqual(row.prerequisite, "");
    assert.equal(row.documentationUrl, operation.documentationUrl);
    if (MUSIC_MV_OPERATION_IDS.has(operation.id)) {
      assert.equal(row.documentationUrl, MUSIC_MV_DOCUMENTATION_URLS[operation.id]);
    } else {
      assert.equal(new URL(row.documentationUrl).hostname, "docs.platform.pixverse.ai");
    }
  }
});

test("every Platform operation has a safe locally valid recipe", async () => {
  const examples = JSON.parse(await readSkill("references/payload-examples.json"));
  assert.deepEqual(Object.keys(examples).sort(), PLATFORM_OPERATIONS.map(({ id }) => id).sort());

  for (const operation of PLATFORM_OPERATIONS) {
    const recipe = examples[operation.id];
    assert.equal(typeof recipe.description, "string");
    assert.ok(recipe.description.length > 0);
    const variants = [{ label: "primary", input: recipe.input }, ...(recipe.alternatives ?? [])];
    for (const variant of variants) {
      await normalizeAndValidatePlatformInput(operation, variant.input, {
        inspectLocalMedia: async () => assert.fail("examples must not require private local media"),
      });
      for (const identifier of visitIdentifiers(variant.input)) {
        if (Array.isArray(identifier.value)) {
          assert.equal(identifier.value.every((item) => typeof item === "string"), true);
        } else {
          assert.equal(typeof identifier.value, "string", `${operation.id}.${identifier.key}`);
        }
      }
    }
  }
});

test("payload recipes contain no credentials, private hosts, or production media URLs", async () => {
  const text = await readSkill("references/payload-examples.json");
  assert.doesNotMatch(text, /PIXVERSE_.*KEY|API-KEY|Bearer\s|api[_-]?key/i);
  for (const match of text.matchAll(/https?:\/\/[^"\\]+/g)) {
    assert.equal(new URL(match[0]).hostname.endsWith("example.test"), true);
  }
});

test("model, pricing, and limit guidance is dated and linked to primary sources", async () => {
  const skill = await readSkill("SKILL.md");
  const reference = await readSkill("references/models-pricing-and-limits.md");
  const officialPages = [
    "https://docs.platform.pixverse.ai/model-capability-map-2394982m0",
    "https://docs.platform.pixverse.ai/pixverse-api-pricing-2394995m0",
    "https://docs.platform.pixverse.ai/concurrency-rules-2394990m0",
    "https://docs.platform.pixverse.ai/upload-image-13016631e0",
    "https://docs.platform.pixverse.ai/upload-media-video-and-audio-43051206e0",
  ];
  assert.match(skill, /references\/models-pricing-and-limits\.md/);
  assert.match(reference, /Verified against official docs: 2026-10-23/);
  assert.match(reference, /refresh|re-check|verify live/i);
  for (const page of officialPages) assert.ok(reference.includes(page), page);
  assert.ok(reference.includes(MUSIC_MV_DOCUMENTATION_URLS["agent.music-mv"]));
  assert.match(reference, /15 credits.*second/i);
  assert.match(reference, /22\.5 credits.*second/i);
  assert.match(reference, /10.*360 seconds/i);
  assert.doesNotMatch(reference, /654[- ]template/i);
});

test("workflow status meanings match the executable normalizer", async () => {
  const workflow = await readSkill("references/workflows-and-recovery.md");
  const rows = parseStatusTable(workflow);
  assert.equal(rows.size, 5);
  for (const code of [1, 5, 6, 7, 8]) {
    const actual = normalizePlatformStatus(code);
    assert.deepEqual(rows.get(code), { name: actual.status, terminal: actual.terminal });
  }
});

test("workflow and troubleshooting guidance preserves paid-call and webhook invariants", async () => {
  const skill = await readSkill("SKILL.md");
  const workflow = await readSkill("references/workflows-and-recovery.md");
  const troubleshooting = await readSkill("references/troubleshooting.md");
  assert.match(skill, /references\/workflows-and-recovery\.md/);
  assert.match(skill, /references\/troubleshooting\.md/);
  assert.match(workflow, /--dry-run/);
  assert.match(workflow, /waits? by default/i);
  assert.match(workflow, /--no-wait/);
  assert.match(workflow, /run-job/);
  assert.match(workflow, /resume/);
  assert.match(workflow, /reconciliation_required/);
  assert.doesNotMatch(workflow, /run-job[^\n]*--poll/);
  const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /platform run-job[^\n]*--no-wait/);
  assert.match(readme, /Platform billable jobs wait by default/i);
  assert.match(workflow, /verify.*before.*pars/i);
  assert.match(workflow, /return.*`ok`.*after/i);
  assert.match(workflow, /https:\/\/docs\.platform\.pixverse\.ai\/how-to-use-webhook-1905378m0/);
  assert.match(troubleshooting, /ErrCode.*zero|ErrCode.*0/i);
  assert.match(troubleshooting, /ambiguous/i);
  assert.match(troubleshooting, /do not.*resubmit|never.*resubmit|must not.*retry/i);
  assert.match(troubleshooting, /moderation/i);
  assert.match(troubleshooting, /rate|concurren/i);
  assert.match(workflow, /audio verify/i);
  assert.match(workflow, /agent\.music-mv/);
  assert.match(troubleshooting, /701020/);
  assert.match(troubleshooting, /500044/);
  assert.match(troubleshooting, /400080/);
});

test("capability routing exposes the complete Music MV prerequisite chain", async () => {
  const capabilities = await readSkill("references/capabilities.md");
  assert.match(capabilities, /audio\.verify/);
  assert.match(capabilities, /agent\.music-mv/);
  assert.match(capabilities, /upload\.media.*audio\.verify.*agent\.music-mv/is);
  assert.match(capabilities, /video\.status|resume/);
});
