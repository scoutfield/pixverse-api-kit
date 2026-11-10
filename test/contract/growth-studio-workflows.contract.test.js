import test from "node:test";
import assert from "node:assert/strict";
import { GrowthStudioClient } from "../../src/growth-studio/client.js";
import { createRecordingFetch, jsonResponse } from "../helpers/recording-fetch.js";
import { payloads } from "../helpers/growth-workflow-fixtures.js";

function client(recorder, options = {}) {
  return new GrowthStudioClient({ apiKey: "fixture", baseUrl: "https://growth.example.test", fetchImpl: recorder.fetchImpl, sleep: async () => {}, ...options });
}

test("every new workflow uses its documented POST route and exact body; uploads are JSON", async () => {
  const routes = {
    template: "/template/videos/generations", "viral-clone": "/viral-clone/runs",
    variation: "/variation/videos/generations", "product-suite": "/product-suite/images/generations", "video-import": "/video/upload",
  };
  for (const [name, payload] of Object.entries(payloads())) {
    const recorder = createRecordingFetch([jsonResponse({ status: "processing" }, { status: 202 })]);
    await client(recorder).createWorkflow(name, payload, { traceId: "fixture-trace" });
    const [call] = recorder.calls;
    assert.equal(call.method, "POST");
    assert.equal(new URL(call.url).pathname, `/openapi/v1${routes[name]}`);
    assert.equal(call.headers.get("Authorization"), "Bearer fixture");
    assert.equal(call.headers.get("Ai-Trace-Id"), "fixture-trace");
    assert.equal(call.headers.get("Content-Type"), "application/json");
    assert.equal(call.headers.has("API-KEY"), false);
    assert.deepEqual(JSON.parse(call.body), payload);
  }
});

test("new submissions never retry transport errors, HTTP 429/503, or malformed acceptance", async () => {
  for (const [name, payload] of Object.entries(payloads())) {
    for (const response of [new TypeError("lost connection"),
      ...[429, 503].map((status) => jsonResponse({ error: { retryable: true } }, { status })),
      new Response("broken-json", { status: 202 })]) {
      const recorder = createRecordingFetch([response]);
      await assert.rejects(client(recorder).createWorkflow(name, payload));
      assert.equal(recorder.calls.length, 1);
    }
  }
});

test("catalog, discount, kind filters, and identifiers use their distinct read contracts", async () => {
  const recorder = createRecordingFetch([
    jsonResponse({ templates: [{ id: 0, price_per_video: 3000, layout: { name: "Example" } }] }),
    jsonResponse({ discount: "70", source: "workspace", expires_at: null }),
    ...Array.from({ length: 5 }, () => jsonResponse({ status: "succeeded" })),
  ]);
  const api = client(recorder);
  assert.equal((await api.listVideoTemplates()).body.templates[0].id, 0);
  assert.equal((await api.getWalletDiscount()).body.discount, "70");
  await api.listVideos({ kind: "uploaded", cursor: "opaque+/=", limit: 10 });
  await api.getWorkflow("viral-clone", "7412583960987654321");
  await api.getWorkflow("product-suite", "7412583960987654322");
  await api.getWorkflow("variation", "7412583960987654323");
  assert.deepEqual(recorder.calls.map((c) => new URL(c.url).pathname), [
    "/openapi/v1/video-templates", "/openapi/v1/wallet/discount", "/openapi/v1/videos",
    "/openapi/v1/viral-clone/runs/7412583960987654321", "/openapi/v1/product-suite/images/generations/7412583960987654322",
    "/openapi/v1/videos/7412583960987654323",
  ]);
  assert.equal(new URL(recorder.calls[2].url).searchParams.get("kind"), "uploaded");
  assert.equal(new URL(recorder.calls[2].url).searchParams.get("cursor"), "opaque+/=");
  await assert.rejects(api.listVideos({ kind: "product" }), /kind/);
  await assert.rejects(api.getWorkflow("viral-clone", 123), /numeric string/);
  assert.equal(recorder.calls.length, 6);
});

test("polling follows Retry-After and stops on completed suites without hiding individual image failures", async () => {
  const finished = { task_id: "123", status: "completed", images: [{ image_id: "1", status: "succeeded", url: "https://media.pixverse.ai/a.png" }, { image_id: "2", status: "failed" }] };
  const recorder = createRecordingFetch([
    jsonResponse({ status: "processing" }, { headers: { "Retry-After": "9" } }), jsonResponse(finished),
  ]);
  const waits = [];
  const api = client(recorder, { sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await api.pollWorkflow("product-suite", "123", { initialDelaySeconds: 0 }), finished);
  assert.deepEqual(waits, [5000, 9000]);
});

test("polling keeps failed run errors, enforces timeout, and retries only safe reads", async () => {
  const recorder = createRecordingFetch([
    jsonResponse({ error: { retryable: true } }, { status: 429, headers: { "Retry-After": "7" } }),
    jsonResponse({ run_id: "123", status: "failed", error: { code: "GENERATION_FAILED", message: "Refund pending" } }),
  ]);
  const waits = [];
  const api = client(recorder, { sleep: async (ms) => waits.push(ms) });
  assert.equal((await api.pollWorkflow("viral-clone", "123")).error.code, "GENERATION_FAILED");
  assert.deepEqual(waits, [5000, 7000]);
  assert.ok(recorder.calls.every((c) => c.method === "GET"));
  await assert.rejects(api.pollWorkflow("viral-clone", "123", { timeoutMs: 1 }), /timed out/);
  assert.equal(recorder.calls.length, 2);
});
