import assert from "node:assert/strict";
import test from "node:test";

import { parseRetryAfter, requestHttp } from "../../src/core/http.js";

test("requestHttp parses unsafe JSON integers as strings", async () => {
  const result = await requestHttp({
    url: "https://example.test/video",
    fetchImpl: async () => new Response('{"video_id":627410861853514292,"count":2}'),
  });

  assert.equal(result.body.video_id, "627410861853514292");
  assert.equal(result.body.count, 2);
});

test("parseRetryAfter supports seconds and HTTP dates with an injected clock", () => {
  const nowMs = Date.parse("2026-09-18T12:00:00Z");
  assert.equal(parseRetryAfter("2.5", nowMs), 2.5);
  assert.equal(parseRetryAfter("Fri, 18 Sep 2026 12:00:05 GMT", nowMs), 5);
  assert.equal(parseRetryAfter("invalid", nowMs), undefined);
});

test("requestHttp retries bounded GET 429, 5xx, and transport failures", async () => {
  const responses = [
    new TypeError("network down"),
    new Response('{"error":"busy"}', { status: 503 }),
    new Response('{"error":"slow"}', { status: 429, headers: { "retry-after": "2" } }),
    new Response('{"ok":true}', { status: 200 }),
  ];
  const delays = [];
  let attempts = 0;

  const result = await requestHttp({
    url: "https://example.test/status",
    method: "GET",
    fetchImpl: async () => {
      const next = responses[attempts++];
      if (next instanceof Error) throw next;
      return next;
    },
    retry: { maxAttempts: 4, delayMs: 10 },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.equal(result.body.ok, true);
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [10, 20, 2_000]);
});

test("requestHttp never retries POST, even when an explicit retry policy is provided", async () => {
  let postAttempts = 0;
  await assert.rejects(
    requestHttp({
      url: "https://example.test/generate",
      method: "POST",
      fetchImpl: async () => {
        postAttempts += 1;
        return new Response('{"error":{"message":"busy"}}', { status: 503 });
      },
      retry: { maxAttempts: 5, delayMs: 1 },
      sleep: async () => {},
    }),
    (error) => error.status === 503 && error.retryable === true,
  );
  assert.equal(postAttempts, 1);
});

test("requestHttp rejects prototype-polluting JSON", async () => {
  await assert.rejects(
    requestHttp({
      url: "https://example.test/unsafe",
      fetchImpl: async () => new Response('{"__proto__":{"polluted":true}}'),
    }),
    /parse JSON response/i,
  );
  assert.equal({}.polluted, undefined);
});

test("requestHttp handles empty success bodies and rejects invalid retry bounds", async () => {
  const result = await requestHttp({
    url: "https://example.test/empty",
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  assert.equal(result.body, null);

  await assert.rejects(
    requestHttp({ url: "https://example.test/status", retry: { maxAttempts: 0 } }),
    /positive safe integer/i,
  );
});

test("requestHttp reports final GET transport and non-retryable HTTP failures", async () => {
  await assert.rejects(
    requestHttp({
      url: "https://example.test/status",
      retry: { maxAttempts: 1 },
      fetchImpl: async () => { throw new Error("offline"); },
    }),
    (error) => error.category === "transport" && error.retryable === false,
  );

  await assert.rejects(
    requestHttp({
      url: "https://example.test/status",
      retry: { maxAttempts: 3 },
      fetchImpl: async () => new Response('{"error":{"message":"bad request","code":"BAD"}}', { status: 400 }),
    }),
    (error) => error.status === 400 && error.code === "BAD" && error.retryable === false,
  );
});

test("requestHttp retries a read-only transient failure with a non-JSON body", async () => {
  let attempts = 0;
  const result = await requestHttp({
    url: "https://example.test/status",
    retry: { maxAttempts: 2, delayMs: 0 },
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("Bad Gateway", { status: 502 });
      return new Response('{"status":"ready"}');
    },
  });

  assert.equal(attempts, 2);
  assert.equal(result.body.status, "ready");
});

test("requestHttp does not retry an already-aborted request", async () => {
  const abortCause = new DOMException("The operation was aborted.", "AbortError");
  const controller = new AbortController();
  controller.abort(abortCause);
  const delays = [];
  let attempts = 0;

  await assert.rejects(requestHttp({
    url: "https://example.test/status",
    signal: controller.signal,
    retry: { maxAttempts: 3, delayMs: 10 },
    sleep: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async (_url, { signal }) => {
      attempts += 1;
      assert.equal(signal.aborted, true);
      throw signal.reason;
    },
  }), (error) => {
    assert.equal(error.category, "transport");
    assert.equal(error.retryable, false);
    assert.equal(error.cause, abortCause);
    assert.equal(error.cause.name, "AbortError");
    return true;
  });

  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test("requestHttp does not retry an AbortError raised during fetch", async () => {
  const abortCause = new DOMException("Fetch was aborted.", "AbortError");
  const delays = [];
  let attempts = 0;

  await assert.rejects(requestHttp({
    url: "https://example.test/status",
    retry: { maxAttempts: 3, delayMs: 10 },
    sleep: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      attempts += 1;
      throw abortCause;
    },
  }), (error) => {
    assert.equal(error.category, "transport");
    assert.equal(error.retryable, false);
    assert.equal(error.cause, abortCause);
    assert.equal(error.cause.name, "AbortError");
    return true;
  });

  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test("requestHttp gives each read-only retry attempt a fresh trace header", async () => {
  const seen = [];
  const traces = ["trace-2", "trace-3"];
  let attempts = 0;
  const result = await requestHttp({
    url: "https://example.test/status",
    headers: new Headers({ "Ai-trace-id": "trace-1", Accept: "application/json" }),
    traceId: "trace-1",
    nextTraceId: () => traces.shift(),
    retry: { maxAttempts: 3, delayMs: 0 },
    sleep: async () => {},
    fetchImpl: async (_url, { headers }) => {
      seen.push(headers.get("Ai-trace-id"));
      assert.equal(headers.get("Accept"), "application/json");
      attempts += 1;
      return attempts < 3 ? new Response("busy", { status: 503 }) : new Response('{"ok":true}');
    },
  });
  assert.deepEqual(seen, ["trace-1", "trace-2", "trace-3"]);
  assert.equal(result.traceId, "trace-3");

  // Plain-object headers are rewritten case-insensitively; failures report the attempt trace.
  const objectSeen = [];
  await assert.rejects(requestHttp({
    url: "https://example.test/status",
    headers: { "ai-trace-id": "first" },
    traceId: "first",
    nextTraceId: () => "second",
    retry: { maxAttempts: 2, delayMs: 0 },
    sleep: async () => {},
    fetchImpl: async (_url, { headers }) => {
      objectSeen.push(headers);
      return new Response("busy", { status: 503 });
    },
  }), (error) => error.traceId === "second");
  assert.deepEqual(objectSeen, [{ "ai-trace-id": "first" }, { "Ai-trace-id": "second" }]);
});

test("requestHttp keeps the supplied trace when no per-attempt factory is given and never retries POST", async () => {
  const seen = [];
  await requestHttp({
    url: "https://example.test/status",
    headers: new Headers({ "Ai-trace-id": "fixed" }),
    traceId: "fixed",
    retry: { maxAttempts: 2, delayMs: 0 },
    sleep: async () => {},
    fetchImpl: async (_url, { headers }) => {
      seen.push(headers.get("Ai-trace-id"));
      return seen.length === 1 ? new Response("busy", { status: 503 }) : new Response("{}");
    },
  });
  assert.deepEqual(seen, ["fixed", "fixed"]);

  let factoryCalls = 0;
  let posts = 0;
  await assert.rejects(requestHttp({
    url: "https://example.test/generate",
    method: "POST",
    traceId: "billable",
    nextTraceId: () => { factoryCalls += 1; return "other"; },
    retry: { maxAttempts: 3 },
    fetchImpl: async () => { posts += 1; return new Response("busy", { status: 503 }); },
  }), (error) => error.traceId === "billable");
  assert.equal(posts, 1);
  assert.equal(factoryCalls, 0);
});
