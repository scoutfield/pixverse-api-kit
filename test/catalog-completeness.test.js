import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { getPlatformHelp } from "../src/platform/cli.js";
import { PLATFORM_OPERATIONS, getPlatformOperation, matchPlatformCommand } from "../src/platform/operations.js";
import { normalizeAndValidatePlatformInput } from "../src/platform/validation.js";

const ROOT = process.cwd();
const PLATFORM_SKILL = path.join(ROOT, ".agents/skills/pixverse-platform-api/SKILL.md");
const PLATFORM_OPERATION_REFERENCE = path.join(ROOT, ".agents/skills/pixverse-platform-api/references/operation-catalog.md");
const ROUTER_SKILL = path.join(ROOT, ".agents/skills/pixverse-api/SKILL.md");
// audio.verify has no public page yet; Music MV is documented as One-click VibeMV.
const MUSIC_MV_DOCUMENTATION_URLS = {
  "audio.verify": "https://aisphere.feishu.cn/wiki/L8pgwGoSwiDbQ8ksGIHcppcvnrc",
  "agent.music-mv": "https://docs.platform.pixverse.ai/one-click-vibemv-44175576e0",
};
const MUSIC_MV_OPERATION_IDS = new Set(["audio.verify", "agent.music-mv"]);

test("Platform catalog, validators, fixtures, and help cover the independent inventory", async () => {
  const inventory = JSON.parse(await fs.readFile(
    path.join(ROOT, "test/fixtures/platform/official-operation-inventory.json"),
    "utf8",
  ));
  const help = getPlatformHelp();
  const catalogIds = PLATFORM_OPERATIONS.map(({ id }) => id).sort();
  const inventoryIds = inventory.map(({ id }) => id).sort();

  assert.deepEqual(catalogIds, inventoryIds);
  for (const expected of inventory) {
    const operation = getPlatformOperation(expected.id);
    assert.deepEqual({ ...operation, command: [...operation.command] }, expected);
    assert.equal(operation.validationPolicy, expected.id);
    assert.equal(matchPlatformCommand(operation.command), operation);
    assert.match(help, new RegExp(escapeRegExp(`pixverse-api platform ${operation.command.join(" ")}`)));
    const helpLine = help.split("\n").find((line) => line.includes(`pixverse-api platform ${operation.command.join(" ")}`));
    assert.equal(helpLine.includes("[--no-wait]"), operation.billing === "billable");
    if (MUSIC_MV_OPERATION_IDS.has(operation.id)) {
      assert.equal(operation.documentationUrl, MUSIC_MV_DOCUMENTATION_URLS[operation.id]);
    } else {
      assert.equal(new URL(operation.documentationUrl).hostname, "docs.platform.pixverse.ai");
    }

    for (const fileName of ["request.json", "success.json", "error.json"]) {
      const fixturePath = path.join(ROOT, "test/fixtures/platform", expected.id, fileName);
      assert.equal(await exists(fixturePath), true);
      const fixtureText = await fs.readFile(fixturePath, "utf8");
      assert.doesNotThrow(() => JSON.parse(fixtureText));
    }

    const requestFixture = JSON.parse(await fs.readFile(
      path.join(ROOT, "test/fixtures/platform", expected.id, "request.json"),
      "utf8",
    ));
    const normalized = await normalizeAndValidatePlatformInput(operation, requestFixture.input);
    assert.equal(normalized.validationSummary.policy, expected.validationPolicy);
  }
  assert.match(help, /pixverse-api platform run-job .*\[--no-wait\]/);
  assert.match(help, /pixverse-api platform resume <job-directory>/);
});

test("Task 11 skill markers cover every Platform operation", async () => {
  const inventory = JSON.parse(await fs.readFile(
    path.join(ROOT, "test/fixtures/platform/official-operation-inventory.json"),
    "utf8",
  ));
  const platformSkill = await readOptional(PLATFORM_SKILL);
  const operationReference = await readOptional(PLATFORM_OPERATION_REFERENCE);
  const routerSkill = await readOptional(ROUTER_SKILL);
  const missing = [];
  if (!routerSkill.includes("pixverse-api platform")) missing.push("router skill platform namespace");
  if (!routerSkill.includes("pixverse-api growth-studio")) missing.push("router skill growth-studio namespace");

  for (const expected of inventory) {
    const marker = `operation:${expected.id}`;
    if (!platformSkill.includes(marker)) missing.push(`skill ${marker}`);
    if (!operationReference.includes(marker)) missing.push(`reference ${marker}`);
  }

  assert.deepEqual(missing, []);
});

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readOptional(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
