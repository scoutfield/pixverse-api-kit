import assert from "node:assert/strict";
import test from "node:test";

import { PlatformClient } from "../../src/platform/client.js";

const BASE_URL = "https://platform.example.test";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function recorder(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, trace: new Headers(init.headers).get("Ai-trace-id") });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("read-only GET retries send a unique Ai-trace-id per attempt and report the successful one", async () => {
  const fetch = recorder([
    new TypeError("socket closed"),
    new Response("busy", { status: 503 }),
    new Response('{"ErrCode":0,"ErrMsg":"success","Resp":{"id":"9","status":5}}'),
  ]);
  const client = new PlatformClient({
    apiKey: "fixture-credential", baseUrl: BASE_URL, fetchImpl: fetch.fetchImpl, sleep: async () => {},
  });
  const result = await client.execute("video.status", { video_id: "9" });
  const traces = fetch.calls.map(({ trace }) => trace);
  assert.equal(traces.length, 3);
  assert.equal(new Set(traces).size, 3);
  for (const trace of traces) assert.match(trace, UUID);
  assert.equal(result.traceId, traces.at(-1));
});

test("a billable submission is sent once with its recovery trace, even on 503 or a retryable ErrCode", async () => {
  const savedTrace = "11111111-1111-4111-8111-111111111111";
  for (const response of [
    new Response("busy", { status: 503 }),
    new Response('{"ErrCode":500069,"ErrMsg":"high load","Resp":null}'),
  ]) {
    const fetch = recorder([response, new Response('{"ErrCode":0,"Resp":{"video_id":"1"}}')]);
    const client = new PlatformClient({
      apiKey: "fixture-credential", baseUrl: BASE_URL, fetchImpl: fetch.fetchImpl, sleep: async () => {},
    });
    await assert.rejects(client.execute("video.text", {
      aspect_ratio: "16:9", duration: 5, model: "v6", prompt: "hello", quality: "720p",
    }, { recovery: true, traceId: savedTrace }), (error) => error.traceId === savedTrace);
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].method, "POST");
    assert.equal(fetch.calls[0].trace, savedTrace);
  }
});
