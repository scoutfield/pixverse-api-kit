import assert from "node:assert/strict";
import test from "node:test";

import {
  GrowthStudioApiError,
  GrowthStudioClient,
  normalizeWalletLedgerOptions,
  parseResponse,
} from "../../src/growth-studio/client.js";
import { createRecordingFetch, describeRecordedBody, jsonResponse } from "../helpers/recording-fetch.js";

const VIDEO = Object.freeze({
  aspect_ratio: "9:16",
  duration_seconds: 30,
  resolution: "1080p",
  language: "en-US",
  voiceover: true,
  captions: true,
  background_music: true,
  avatar: Object.freeze({ mode: "auto" }),
});

// describeRecordedBody parses losslessly into null-prototype records; compare as plain JSON.
async function recordedJson(body) {
  return JSON.parse(JSON.stringify(await describeRecordedBody(body), (_key, value) => (
    typeof value === "bigint" ? value.toString() : value
  )));
}

test("Growth Studio client uses bearer auth only and never sends Platform headers", async () => {
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({ video_id: "627410861853514292", status: "processing" }),
    jsonResponse({ folders: [], request_id: "folder-list-request" }),
    jsonResponse({ folder_id: "630251570268735431", request_id: "folder-create-request" }, { status: 201 }),
  ]);
  const client = new GrowthStudioClient({
    ["api" + "Key"]: "growth-fixture-key",
    baseUrl: "https://growth.example.test",
    fetchImpl,
  });

  await client.createVideo({
    product: { source_url: "https://shop.example.test/item" },
    video: { ...VIDEO, folder_id: "630251570268735431" },
  }, { traceId: "create-trace" });
  await client.listFolders({ traceId: "folder-trace" });
  await client.createFolder({ name: "ACME" }, { traceId: "create-folder-trace" });

  assert.equal(calls[0].headers.get("Authorization"), "Bearer growth-fixture-key");
  assert.equal(calls[1].headers.get("Authorization"), "Bearer growth-fixture-key");
  assert.equal(calls[2].headers.get("Authorization"), "Bearer growth-fixture-key");
  assert.equal(calls.every(({ headers }) => !headers.has("API-KEY")), true);
  assert.equal(calls.every(({ headers }) => headers.has("Ai-Trace-Id")), true);
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "GET", "POST"]);
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    "/openapi/v1/videos",
    "/openapi/v1/folders",
    "/openapi/v1/folders",
  ]);
  assert.deepEqual(await recordedJson(calls[0].body), {
    product: { source_url: "https://shop.example.test/item" },
    video: { ...VIDEO, avatar: { mode: "auto" }, folder_id: "630251570268735431" },
  });
  assert.equal(calls[1].body, undefined);
  assert.deepEqual(await recordedJson(calls[2].body), { name: "ACME" });
});

test("Growth Studio client preserves string identifiers through create and poll", async () => {
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({ video_id: "627410861853514292", status: "processing" }),
    jsonResponse({ video_id: "627410861853514292", status: "succeeded" }),
  ]);
  const client = new GrowthStudioClient({
    ["api" + "Key"]: "growth-fixture-key",
    baseUrl: "https://growth.example.test",
    fetchImpl,
    sleep: async () => {},
  });

  const created = await client.createVideo({
    product: { source_url: "https://shop.example.test/item" },
    video: VIDEO,
  });
  const final = await client.pollVideo(created.body.video_id, { initialDelaySeconds: 0 });

  assert.equal(created.body.video_id, "627410861853514292");
  assert.equal(final.video_id, "627410861853514292");
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "GET"]);
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    "/openapi/v1/videos",
    "/openapi/v1/videos/627410861853514292",
  ]);
  assert.equal(calls.every(({ headers }) => !headers.has("API-KEY")), true);
});

test("Growth Studio PDP uses bearer auth and the exact PDP wire contract", async () => {
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({
      video_id: "627410861853514292",
      status: "processing",
      ledger_source_id: "627410861853514292",
      request_id: "pdp-create-fixture",
    }, { status: 202, headers: { location: "/openapi/v1/videos/627410861853514292" } }),
  ]);
  const client = new GrowthStudioClient({
    ["api" + "Key"]: "growth-fixture-key",
    baseUrl: "https://growth.example.test",
    fetchImpl,
  });

  const result = await client.createPdpVideo({
    product: {
      title: "Linen Summer Shirt",
      images: [{ url: "https://media.pixverse.ai/example/front.webp" }],
    },
    video: { mode: "standard" },
  }, { traceId: "pdp-create-fixture" });

  assert.equal(result.body.video_id, "627410861853514292");
  assert.equal(result.body.ledger_source_id, "627410861853514292");
  assert.equal(result.requestId, "pdp-create-fixture");
  assert.equal(calls[0].method, "POST");
  assert.equal(new URL(calls[0].url).pathname, "/openapi/v1/ecommerce_pdp/video");
  assert.equal(calls[0].headers.get("Authorization"), "Bearer growth-fixture-key");
  assert.equal(calls[0].headers.get("Ai-Trace-Id"), "pdp-create-fixture");
  assert.equal(calls[0].headers.has("API-KEY"), false);
  assert.deepEqual(await recordedJson(calls[0].body), {
    product: {
      title: "Linen Summer Shirt",
      images: [{ url: "https://media.pixverse.ai/example/front.webp" }],
    },
    video: { mode: "standard" },
  });
});

test("Growth Studio PDP and wallet validation fail before any network request", async () => {
  const { calls, fetchImpl } = createRecordingFetch();
  const client = new GrowthStudioClient({
    ["api" + "Key"]: "growth-fixture-key",
    baseUrl: "https://growth.example.test",
    fetchImpl,
  });

  await assert.rejects(
    client.createPdpVideo({
      product: {
        title: "Linen Summer Shirt",
        images: [{ url: "https://merchant.example.test/front.webp" }],
      },
      video: { mode: "standard" },
    }),
    /media\.pixverse\.ai origin/,
  );
  await assert.rejects(
    client.listWalletLedgers({ offset: "20" }),
    /offset must be a safe integer/i,
  );

  assert.equal(calls.length, 0);
});

test("Growth Studio PDP submission is single-attempt on transport and HTTP failures", async () => {
  const payload = {
    product: {
      title: "Linen Summer Shirt",
      images: [{ url: "https://media.pixverse.ai/example/front.webp" }],
    },
    video: { mode: "standard" },
  };
  const transportRecorder = createRecordingFetch([
    new TypeError("fixture connection reset"),
  ]);
  const transportClient = new GrowthStudioClient({
    ["api" + "Key"]: "growth-fixture-key",
    baseUrl: "https://growth.example.test",
    fetchImpl: transportRecorder.fetchImpl,
  });

  await assert.rejects(
    transportClient.createPdpVideo(payload, { traceId: "pdp-transport-fixture" }),
    /fixture connection reset/,
  );
  assert.equal(transportRecorder.calls.length, 1);
  assert.equal(new URL(transportRecorder.calls[0].url).pathname, "/openapi/v1/ecommerce_pdp/video");

  const unavailableRecorder = createRecordingFetch([
    jsonResponse({
      request_id: "pdp-request-503",
      error: {
        message: "PDP service is temporarily unavailable.",
        code: "TEMPORARILY_UNAVAILABLE",
        retryable: true,
      },
    }, {
      status: 503,
      headers: {
        "retry-after": "7",
        "x-request-id": "pdp-header-503",
      },
    }),
  ]);
  const unavailableClient = new GrowthStudioClient({
    ["api" + "Key"]: "growth-fixture-key",
    baseUrl: "https://growth.example.test",
    fetchImpl: unavailableRecorder.fetchImpl,
  });

  await assert.rejects(
    unavailableClient.createPdpVideo(payload, { traceId: "pdp-503-fixture" }),
    (error) => {
      assert.ok(error instanceof GrowthStudioApiError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "TEMPORARILY_UNAVAILABLE");
      assert.equal(error.retryable, true);
      assert.equal(error.requestId, "pdp-request-503");
      assert.equal(error.retryAfter, 7);
      return true;
    },
  );
  assert.equal(unavailableRecorder.calls.length, 1);
  assert.equal(new URL(unavailableRecorder.calls[0].url).pathname, "/openapi/v1/ecommerce_pdp/video");
});

test("Growth Studio wallet methods preserve formatted strings and validated pagination", async () => {
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({
      currency: "USD",
      available_amount: "1280.00",
      refund_pending_amount: "0.00",
      status: "normal",
      free_chances: 0,
    }),
    jsonResponse({
      data: [{
        ledger_id: "7412590000000000010",
        type: "video_consume",
        amount: "-1.00",
        source_type: "video",
        source_id: "627410861853514292",
      }],
      pagination: { offset: 20, limit: 10, total: 31 },
    }),
  ]);
  const client = new GrowthStudioClient({
    ["api" + "Key"]: "growth-fixture-key",
    baseUrl: "https://growth.example.test",
    fetchImpl,
  });

  const balance = await client.getWalletBalance({ traceId: "balance-fixture" });
  const ledger = await client.listWalletLedgers({ offset: 20, limit: 10, traceId: "ledger-fixture" });

  assert.equal(balance.body.available_amount, "1280.00");
  assert.equal(ledger.body.data[0].ledger_id, "7412590000000000010");
  assert.equal(ledger.body.data[0].amount, "-1.00");
  assert.equal(ledger.body.data[0].source_id, "627410861853514292");
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    "/openapi/v1/wallet/balance",
    "/openapi/v1/wallet/ledgers",
  ]);
  assert.equal(new URL(calls[1].url).search, "?offset=20&limit=10");
  assert.deepEqual(calls.map(({ headers }) => headers.get("Authorization")), [
    "Bearer growth-fixture-key",
    "Bearer growth-fixture-key",
  ]);
  assert.deepEqual(calls.map(({ headers }) => headers.has("API-KEY")), [false, false]);
  assert.deepEqual(calls.map(({ headers }) => headers.get("Ai-Trace-Id")), [
    "balance-fixture",
    "ledger-fixture",
  ]);
});

test("wallet ledger options default to the documented safe page", () => {
  assert.deepEqual(normalizeWalletLedgerOptions(), { offset: 0, limit: 20 });
  assert.deepEqual(normalizeWalletLedgerOptions({ traceId: "wallet-fixture" }), {
    offset: 0,
    limit: 20,
  });
  assert.deepEqual(normalizeWalletLedgerOptions({ offset: 20, limit: 100 }), {
    offset: 20,
    limit: 100,
  });
});

test("wallet ledger options reject coercion, unsafe numbers, bounds, and unknown fields", () => {
  const cases = [
    [{ offset: "20" }, /offset must be a safe integer/i],
    [{ offset: "+20" }, /offset must be a safe integer/i],
    [{ offset: -1 }, /offset must be at least 0/i],
    [{ offset: 1.5 }, /offset must be a safe integer/i],
    [{ offset: Number.NaN }, /offset must be a safe integer/i],
    [{ offset: Number.POSITIVE_INFINITY }, /offset must be a safe integer/i],
    [{ offset: Number.MAX_SAFE_INTEGER + 1 }, /offset must be a safe integer/i],
    [{ limit: "10" }, /limit must be a safe integer/i],
    [{ limit: "-10" }, /limit must be a safe integer/i],
    [{ limit: 0 }, /limit must be at least 1/i],
    [{ limit: 101 }, /limit must be at most 100/i],
    [{ limit: 2.5 }, /limit must be a safe integer/i],
    [{ limit: Number.NaN }, /limit must be a safe integer/i],
    [{ limit: Number.NEGATIVE_INFINITY }, /limit must be a safe integer/i],
    [{ cursor: "next" }, /Unknown wallet ledger option: cursor/i],
  ];

  for (const [options, message] of cases) {
    assert.throws(() => normalizeWalletLedgerOptions(options), message);
  }
});

test("Growth Studio successful responses reject malformed JSON as a protocol error", async () => {
  await assert.rejects(
    parseResponse(new Response("not-json", {
      status: 200,
      headers: { "x-request-id": "request_malformed" },
    })),
    (error) => {
      assert.ok(error instanceof GrowthStudioApiError);
      assert.equal(error.category, "protocol");
      assert.equal(error.code, "INVALID_JSON_RESPONSE");
      assert.equal(error.status, 200);
      assert.equal(error.retryable, false);
      assert.equal(error.requestId, "request_malformed");
      return true;
    },
  );
});

test("Growth Studio create sends folder_id inside video and the edit body unchanged", async () => {
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({ video_id: "627410861853514292", status: "processing" }, { status: 202 }),
    jsonResponse({ video_id: "627410861853514292", edit: { status: "processing" } }, { status: 202 }),
  ]);
  const client = new GrowthStudioClient({
    ["api" + "Key"]: "growth-fixture-key",
    baseUrl: "https://growth.example.test",
    fetchImpl,
  });

  await client.createVideo({
    product: { source_url: "https://shop.example.test/item" },
    video: { ...VIDEO, folder_id: "630251570268735431" },
  });
  await client.editVideo("627410861853514292", { clip_index: 2, instruction: "Make the expression more natural." });

  const created = await recordedJson(calls[0].body);
  assert.equal(created.folder_id, undefined);
  assert.equal(created.video.folder_id, "630251570268735431");
  assert.deepEqual(calls.map(({ method, url }) => `${method} ${new URL(url).pathname}`), [
    "POST /openapi/v1/videos",
    "POST /openapi/v1/videos/627410861853514292/edit",
  ]);
  assert.deepEqual(await recordedJson(calls[1].body), {
    clip_index: 2,
    instruction: "Make the expression more natural.",
  });
});

test("Growth Studio read requests retry 429 and 503 while writes stay single-attempt", async () => {
  const waits = [];
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({ error: { code: "RATE_LIMIT_EXCEEDED", message: "slow down", retryable: true } }, {
      status: 429,
      headers: { "retry-after": "30" },
    }),
    jsonResponse({ error: { code: "SERVICE_UNAVAILABLE", message: "later", retryable: true } }, { status: 503 }),
    jsonResponse({ folders: [{ folder_id: "630251570268735431", name: "ACME" }] }),
    jsonResponse({ error: { code: "SERVICE_UNAVAILABLE", message: "later", retryable: true } }, { status: 503 }),
  ]);
  const client = new GrowthStudioClient({
    ["api" + "Key"]: "growth-fixture-key",
    baseUrl: "https://growth.example.test",
    fetchImpl,
    sleep: async (ms) => waits.push(ms),
  });

  const folders = await client.listFolders();
  await assert.rejects(client.createFolder({ name: "ACME" }), (error) => error.status === 503);

  assert.equal(folders.body.folders[0].folder_id, "630251570268735431");
  assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET", "GET", "POST"]);
  assert.deepEqual(waits, [30_000, 2_000]);
});
