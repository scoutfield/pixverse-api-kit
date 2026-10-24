import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  PLATFORM_OPERATIONS,
  getPlatformOperation,
  matchPlatformCommand,
} from "../../src/platform/operations.js";

const inventory = JSON.parse(fs.readFileSync(
  new URL("../fixtures/platform/official-operation-inventory.json", import.meta.url),
  "utf8",
));
const successShapes = JSON.parse(fs.readFileSync(
  new URL("../fixtures/platform/official-success-shapes.json", import.meta.url),
  "utf8",
));

// Music MV is documented as One-click VibeMV; audio.verify has its own page.
const MUSIC_MV_DOCUMENTATION_URLS = {
  "audio.verify": "https://docs.platform.pixverse.ai/verify-uploaded-audio-43051207e0",
  "agent.music-mv": "https://docs.platform.pixverse.ai/one-click-vibemv-44144151e0",
};
const MUSIC_MV_OPERATION_IDS = new Set(["audio.verify", "agent.music-mv"]);

test("Platform catalog matches every independently recorded official operation", () => {
  assert.equal(PLATFORM_OPERATIONS.length, 33);
  assert.deepEqual(
    PLATFORM_OPERATIONS.map((operation) => ({ ...operation, command: [...operation.command] })),
    inventory,
  );
});

test("Platform operation IDs and commands are unique", () => {
  const ids = PLATFORM_OPERATIONS.map(({ id }) => id);
  const commands = PLATFORM_OPERATIONS.map(({ command }) => command.join(" "));

  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(commands).size, commands.length);
});

test("every operation and command is immutable", () => {
  assert.equal(Object.isFrozen(PLATFORM_OPERATIONS), true);
  for (const operation of PLATFORM_OPERATIONS) {
    assert.equal(Object.isFrozen(operation), true);
    assert.equal(Object.isFrozen(operation.command), true);
    assert.equal(
      ["docs.platform.pixverse.ai", "aisphere.feishu.cn"].includes(new URL(operation.documentationUrl).hostname),
      true,
    );
    assert.equal(typeof operation.billing, "string");
    assert.equal(typeof operation.asynchronous, "boolean");
  }
});

test("every operation links to its exact official documentation page", () => {
  const publicUrls = [];
  for (const operation of PLATFORM_OPERATIONS) {
    if (MUSIC_MV_OPERATION_IDS.has(operation.id)) {
      assert.equal(operation.documentationUrl, MUSIC_MV_DOCUMENTATION_URLS[operation.id]);
    } else {
      assert.equal(new URL(operation.documentationUrl).hostname, "docs.platform.pixverse.ai");
      // Image-to-video and video templates share one official page.
      if (operation.id !== "video.template") publicUrls.push(operation.documentationUrl);
    }
  }
  assert.equal(new Set(publicUrls).size, publicUrls.length);
  assert.equal(publicUrls.includes("https://docs.platform.pixverse.ai/pixverse-api-llm-txt-2109771m0"), false);
});

test("catalog lookup resolves IDs and exact CLI segments", () => {
  const operation = getPlatformOperation("video.multi-transition");
  assert.equal(operation.path, "/openapi/v2/video/multi_transition/generate");
  assert.equal(matchPlatformCommand(["video", "multi-transition"]), operation);
  assert.equal(matchPlatformCommand(["video", "multi-transition", "--payload", "input.json"]), operation);
  assert.equal(getPlatformOperation("unknown.operation"), undefined);
  assert.equal(matchPlatformCommand(["video"]), undefined);
  assert.equal(matchPlatformCommand(["video", "unknown"]), undefined);
});

test("billable classification is explicit instead of inferred from HTTP method", () => {
  assert.equal(getPlatformOperation("account.usage").method, "POST");
  assert.equal(getPlatformOperation("account.usage").billing, "read-only");
  assert.equal(getPlatformOperation("video.text").method, "POST");
  assert.equal(getPlatformOperation("video.text").billing, "billable");
});

test("reviewed body and asynchronous metadata matches the official contracts", () => {
  assert.equal(getPlatformOperation("voice.create").resultIdPath, null);

  const voiceDelete = getPlatformOperation("voice.delete");
  assert.equal(voiceDelete.bodyMode, "json");

  const swapMask = getPlatformOperation("video.swap-mask");
  assert.equal(swapMask.asynchronous, false);
  assert.equal(swapMask.resultIdPath, null);

  assert.equal(getPlatformOperation("video.status").resultIdPath, "Resp.id");
});

test("success fixtures retain exact documented collection and empty response shapes", () => {
  const usage = successShapes.find(({ id }) => id === "account.usage");
  assert.deepEqual(usage.Resp, {
    items: [],
    next_cursor: "",
    has_more: false,
  });

  const voiceCreate = successShapes.find(({ id }) => id === "voice.create");
  assert.equal(Object.hasOwn(voiceCreate, "Resp"), false);

  const voiceDelete = successShapes.find(({ id }) => id === "voice.delete");
  assert.equal(Object.hasOwn(voiceDelete, "Resp"), false);

  assert.deepEqual(
    successShapes.find(({ id }) => id === "resource.templates").Resp,
    { effect_items: [] },
  );
  assert.deepEqual(
    successShapes.find(({ id }) => id === "resource.tts-speakers").Resp,
    { total: 15, data: [{ speaker_id: "7", name: "Harper" }] },
  );
  assert.equal(
    Object.hasOwn(successShapes.find(({ id }) => id === "resource.restyle-effects"), "Resp"),
    false,
  );
});

test("result paths resolve against independent documented success shapes", () => {
  assert.equal(successShapes.length, PLATFORM_OPERATIONS.length);
  assert.deepEqual(
    successShapes.map(({ id }) => id).sort(),
    PLATFORM_OPERATIONS.map(({ id }) => id).sort(),
  );

  for (const operation of PLATFORM_OPERATIONS) {
    const success = successShapes.find(({ id }) => id === operation.id);
    if (operation.resultIdPath !== null) {
      const resultId = operation.resultIdPath
        .split(".")
        .reduce((value, segment) => value?.[segment], success);
      assert.equal(
        typeof resultId,
        "string",
        `${operation.id} ${operation.resultIdPath} must resolve to a string ID`,
      );
    }
  }

  const swapMaskSuccess = successShapes.find(({ id }) => id === "video.swap-mask");
  assert.equal(typeof swapMaskSuccess.Resp.keyframe_id, "string");
  assert.equal(Array.isArray(swapMaskSuccess.Resp.mask_info), true);
});
