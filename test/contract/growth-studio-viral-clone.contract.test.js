import assert from "node:assert/strict";
import test from "node:test";

import { GrowthStudioApiError, GrowthStudioClient } from "../../src/growth-studio/client.js";
import { createRecordingFetch, describeRecordedBody, jsonResponse } from "../helpers/recording-fetch.js";

const KEY = "growth-fixture-key";

function client(fetchImpl, extra = {}) {
  return new GrowthStudioClient({
    ["api" + "Key"]: KEY,
    baseUrl: "https://growth.example.test",
    fetchImpl,
    sleep: async () => {},
    ...extra,
  });
}

async function recordedJson(body) {
  return JSON.parse(JSON.stringify(await describeRecordedBody(body), (_key, value) => (
    typeof value === "bigint" ? value.toString() : value
  )));
}

function assertAuth(call, traceId) {
  assert.equal(call.headers.get("Authorization"), `Bearer ${KEY}`);
  assert.equal(call.headers.get("Accept"), "application/json");
  assert.equal(call.headers.get("Ai-Trace-Id"), traceId);
  assert.equal(call.headers.has("API-KEY"), false);
}

function payload() {
  return {
    source_video_id: "643056093269852242",
    model: "plus",
    script_language: "en-US",
    listing: {
      title: "Example Travel Mug",
      image_info: { items: [{ url: "https://media.pixverse.ai/example/mug.webp" }] },
    },
    video: { aspect_ratio: "9:16", resolution: "480p", language: "en-US" },
    avatar: { mode: "disabled" },
  };
}

function apiError(status, code, retryable, extra = {}) {
  return jsonResponse({
    request_id: `req-${status}`,
    error: { code, message: `${code} fixture`, ...(retryable === undefined ? {} : { retryable }), ...extra },
  }, { status });
}

test("Viral Clone create posts the exact wire body once with bearer auth and trace", async () => {
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({ run_id: "25388", status: "processing", request_id: "vc-create" }, {
      status: 202,
      headers: { location: "/openapi/v1/viral-clone/runs/25388" },
    }),
  ]);
  const result = await client(fetchImpl).createViralCloneRun(payload(), { traceId: "vc-trace" });

  assert.equal(result.body.run_id, "25388");
  assert.equal(result.headers.get("location"), "/openapi/v1/viral-clone/runs/25388");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://growth.example.test/openapi/v1/viral-clone/runs");
  assert.equal(calls[0].headers.get("Content-Type"), "application/json");
  assertAuth(calls[0], "vc-trace");
  assert.deepEqual(await recordedJson(calls[0].body), payload());
  assert.equal(typeof (await describeRecordedBody(calls[0].body)).source_video_id, "string");
});

test("Viral Clone create is never retried on 5xx, 429, or transport errors", async () => {
  for (const response of [
    apiError(503, "TEMPORARILY_UNAVAILABLE", true),
    apiError(429, "CONCURRENCY_LIMIT_EXCEEDED", true),
    new TypeError("fixture connection reset"),
  ]) {
    const { calls, fetchImpl } = createRecordingFetch([response, jsonResponse({ run_id: "1" })]);
    await assert.rejects(client(fetchImpl).createViralCloneRun(payload()));
    assert.equal(calls.length, 1);
  }

  const { calls, fetchImpl } = createRecordingFetch([apiError(429, "CONCURRENCY_LIMIT_EXCEEDED", true)]);
  await assert.rejects(client(fetchImpl).createViralCloneRun(payload()), (error) => {
    assert.ok(error instanceof GrowthStudioApiError);
    assert.equal(error.code, "CONCURRENCY_LIMIT_EXCEEDED");
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("Viral Clone validation fails before any network request", async () => {
  const { calls, fetchImpl } = createRecordingFetch();
  const c = client(fetchImpl);
  await assert.rejects(c.createViralCloneRun({ ...payload(), video: { language: "en-US", duration_seconds: 30 } }), /server-managed/);
  await assert.rejects(c.getViralCloneRun(25388), /run_id must be a decimal string/);
  await assert.rejects(c.getViralCloneRun("../videos"), /run_id must be a decimal string/);
  await assert.rejects(c.importVideoFromUrl("not a url"), /HTTP or HTTPS/);
  await assert.rejects(c.listVideos({ kind: "product" }), /kind must be one of: uploaded/);
  await assert.rejects(c.listImages({ limit: 101 }), /limit must be/);
  await assert.rejects(c.listImages({ offset: -1 }), /offset must be/);
  assert.equal(calls.length, 0);
});

test("Viral Clone status GET retries transient reads and polls to a terminal state", async () => {
  const { calls, fetchImpl } = createRecordingFetch([
    apiError(503, "TEMPORARILY_UNAVAILABLE", true),
    jsonResponse({ run_id: "25388", status: "processing", request_id: "p1" }),
    apiError(429, "RATE_LIMITED", true),
    jsonResponse({
      run_id: "25388",
      status: "succeeded",
      output: { video_url: "https://media.pixverse.ai/o.mp4", thumbnail_url: "https://media.pixverse.ai/o.jpg", mime_type: "video/mp4" },
      request_id: "p2",
    }),
  ]);
  const sleeps = [];
  const snapshots = [];
  const final = await client(fetchImpl, { sleep: async (ms) => { sleeps.push(ms); } }).pollViralCloneRun("25388", {
    traceId: "vc-poll",
    onSnapshot: (snapshot) => snapshots.push(snapshot.status),
  });

  assert.equal(final.status, "succeeded");
  assert.equal(final.output.mime_type, "video/mp4");
  assert.deepEqual(snapshots, ["processing", "succeeded"]);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.url, "https://growth.example.test/openapi/v1/viral-clone/runs/25388");
    assertAuth(call, "vc-poll");
    assert.equal(call.body, undefined);
  }
  assert.equal(sleeps[0], 5_000, "initial wait is five seconds");
  assert.ok(sleeps.includes(5_000));
});

test("Viral Clone poll returns a failed run and does not retry RUN_NOT_FOUND", async () => {
  const failed = createRecordingFetch([
    jsonResponse({ run_id: "7", status: "failed", error: { code: "GENERATION_FAILED", message: "x" }, request_id: "f" }),
  ]);
  const final = await client(failed.fetchImpl).pollViralCloneRun("7");
  assert.equal(final.status, "failed");
  assert.equal(final.error.code, "GENERATION_FAILED");

  const missing = createRecordingFetch([apiError(404, "RUN_NOT_FOUND", false)]);
  await assert.rejects(client(missing.fetchImpl).pollViralCloneRun("999"), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.code, "RUN_NOT_FOUND");
    return true;
  });
  assert.equal(missing.calls.length, 1);
});

test("video import posts exactly {url} once and is never retried", async () => {
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({
      video_id: "643056093269852241",
      url: "https://media.pixverse.ai/u.mp4",
      duration: 5.04,
      width: 720,
      height: 1280,
      file_size: 1234567,
      request_id: "imp",
    }),
  ]);
  const result = await client(fetchImpl).importVideoFromUrl("https://cdn.example.test/ref.mp4", { traceId: "imp-trace" });
  assert.equal(result.body.video_id, "643056093269852241");
  assert.equal(result.body.duration, 5.04);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://growth.example.test/openapi/v1/video/upload");
  assertAuth(calls[0], "imp-trace");
  assert.equal(calls[0].body, '{"url":"https://cdn.example.test/ref.mp4"}');

  for (const response of [
    apiError(503, "UPLOAD_FAILED", false, { details: { stage: "persist_unknown" } }),
    apiError(502, "BAD_GATEWAY", true),
    new TypeError("fixture reset"),
  ]) {
    const recorder = createRecordingFetch([response, jsonResponse({ video_id: "1" })]);
    await assert.rejects(client(recorder.fetchImpl).importVideoFromUrl("https://cdn.example.test/ref.mp4"));
    assert.equal(recorder.calls.length, 1);
  }

  const staged = createRecordingFetch([apiError(422, "UPLOAD_FAILED", false, { details: { stage: "fetch" } })]);
  await assert.rejects(client(staged.fetchImpl).importVideoFromUrl("https://cdn.example.test/ref.mp4"), (error) => {
    assert.equal(error.code, "UPLOAD_FAILED");
    assert.equal(error.retryable, false);
    assert.deepEqual(error.details, { stage: "fetch" });
    return true;
  });
});

test("video list sends kind=uploaded", async () => {
  const { calls, fetchImpl } = createRecordingFetch([jsonResponse({ videos: [] })]);
  await client(fetchImpl).listVideos({ kind: "uploaded", limit: 5, traceId: "list-trace" });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/openapi/v1/videos");
  assert.equal(url.searchParams.get("kind"), "uploaded");
  assert.equal(url.searchParams.get("limit"), "5");
  assertAuth(calls[0], "list-trace");
});

test("wallet discount, models, and images are bearer GETs with read retry", async () => {
  const { calls, fetchImpl } = createRecordingFetch([
    apiError(502, "BAD_GATEWAY", true),
    jsonResponse({ discount: "70", source: "default", expires_at: null, request_id: "disc" }),
    jsonResponse({ catalog_version: "2026-10-23-voiceover-v1", price_unit: "milli_credit", video_models: [{ model: "GS200" }], image_models: [] }),
    jsonResponse('{"data":[{"image_id":"22887","task_id":"643056093269852299","source":"generated"}],"pagination":{"offset":10,"limit":5,"total":11}}'),
  ]);
  const c = client(fetchImpl);
  const discount = await c.getWalletDiscount({ traceId: "disc-trace" });
  const models = await c.listModels({ traceId: "models-trace" });
  const images = await c.listImages({ offset: 10, limit: 5, traceId: "images-trace" });

  assert.deepEqual(discount.body, { discount: "70", source: "default", expires_at: null, request_id: "disc" });
  assert.equal(models.body.price_unit, "milli_credit");
  assert.equal(images.body.data[0].image_id, "22887");
  assert.equal(images.body.data[0].task_id, "643056093269852299");
  assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET", "GET", "GET"]);
  assert.deepEqual(calls.map(({ url }) => `${new URL(url).pathname}${new URL(url).search}`), [
    "/openapi/v1/wallet/discount",
    "/openapi/v1/wallet/discount",
    "/openapi/v1/models",
    "/openapi/v1/images?offset=10&limit=5",
  ]);
  assertAuth(calls[0], "disc-trace");
  assertAuth(calls[2], "models-trace");
  assertAuth(calls[3], "images-trace");
});

test("wallet ledgers preserve documented signed decimal string fields", async () => {
  const ledger = {
    ledger_id: "7412590000000000010",
    type: "consume",
    amount: "-0.48",
    original_amount: "-1.60",
    currency: "USD",
    balance_before: "10.00",
    balance_after: "9.52",
    source_type: "video",
    source_id: "643056093269852242",
    created_at: "2026-10-23T00:00:00Z",
  };
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({ data: [ledger], pagination: { offset: 0, limit: 20, total: 1 }, request_id: "l" }),
  ]);
  const result = await client(fetchImpl).listWalletLedgers({ traceId: "ledger-trace" });
  assert.deepEqual(result.body.data[0], ledger);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("offset"), "0");
  assert.equal(url.searchParams.get("limit"), "20");
  assertAuth(calls[0], "ledger-trace");
  await assert.rejects(client(fetchImpl).listWalletLedgers({ limit: 101 }), /at most 100/);
});
