import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  createMemoryNonceStore,
  createPlatformWebhookHandler,
  DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  parsePlatformWebhook,
  verifyPlatformWebhook,
} from "../../src/platform/webhooks.js";

const SIGNING_KEY = "unit-test-webhook-key";
const VECTOR_KEY = "official-vector-key";
const TIMESTAMP = 1_800_000_000;
const RAW_BODY = JSON.stringify({ event: "video.completed", video_id: "9007199254740993123" });

function signedHeaders(rawBody = RAW_BODY, overrides = {}) {
  const timestamp = String(overrides.timestamp ?? TIMESTAMP);
  const nonce = overrides.nonce ?? "nonce-1";
  const signingKey = overrides.signingKey ?? SIGNING_KEY;
  const payload = JSON.parse(rawBody);
  const entries = Object.entries(payload).map(([key, value]) => [key, String(value)]);
  if (overrides.sortKeys) entries.sort(([left], [right]) => left.localeCompare(right));
  const signed = `${timestamp}\n${nonce}\n${new URLSearchParams(entries)}`;
  return {
    "Webhook-Timestamp": timestamp,
    "Webhook-Nonce": nonce,
    "Webhook-Signature": createHmac("sha256", signingKey).update(signed).digest("base64"),
    "Ai-Trace-Id": "trace-1",
  };
}

test("verifies the documented Base64 HMAC-SHA256 formula and normalizes header case", async () => {
  const headers = signedHeaders();
  const result = await verifyPlatformWebhook({
    rawBody: RAW_BODY,
    headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
    secret: SIGNING_KEY,
    now: () => TIMESTAMP,
    nonceStore: createMemoryNonceStore(),
  });
  assert.deepEqual({
    timestamp: result.timestamp,
    nonce: result.nonce,
    signature: result.signature,
    traceId: result.traceId,
  }, {
    timestamp: String(TIMESTAMP),
    nonce: "nonce-1",
    signature: headers["Webhook-Signature"],
    traceId: "trace-1",
  });
  assert.deepEqual({ ...result.payload }, JSON.parse(RAW_BODY));
  assert.equal(typeof result.commit, "function");
  assert.equal(typeof result.release, "function");
  assert.equal(await result.release(), true);
});

for (const [name, configure] of [
  ["altered payload field", () => ({
    rawBody: JSON.stringify({ event: "video.failed", video_id: "9007199254740993123" }),
    headers: signedHeaders(),
  })],
  ["wrong signing key", () => ({ rawBody: RAW_BODY, headers: signedHeaders(RAW_BODY, { signingKey: "other" }) })],
  ["missing required header", () => {
    const headers = signedHeaders();
    delete headers["Webhook-Nonce"];
    return { rawBody: RAW_BODY, headers };
  }],
  ["duplicate differently-cased header", () => ({
    rawBody: RAW_BODY,
    headers: { ...signedHeaders(), "webhook-nonce": "nonce-2" },
  })],
  ["duplicate raw header", () => {
    const headers = signedHeaders();
    return {
      rawBody: RAW_BODY,
      headers: Object.entries(headers).flatMap(([key, value]) => [key, value]).concat(["Webhook-Nonce", "again"]),
    };
  }],
  ["non-string raw body", () => ({ rawBody: {}, headers: signedHeaders() })],
  ["oversized raw body", () => {
    const rawBody = "x".repeat(1_048_577);
    return { rawBody, headers: signedHeaders() };
  }],
  ["oversized nonce", () => ({ rawBody: RAW_BODY, headers: signedHeaders(RAW_BODY, { nonce: "n".repeat(257) }) })],
]) {
  test(`rejects ${name}`, async () => {
    const input = configure();
    await assert.rejects(verifyPlatformWebhook({
      ...input,
      secret: SIGNING_KEY,
      now: () => TIMESTAMP,
      nonceStore: createMemoryNonceStore(),
    }), (error) => error.code && !error.message.includes(SIGNING_KEY));
  });
}

for (const [name, timestamp, options] of [
  ["stale (default 6h window)", TIMESTAMP - (6 * 60 * 60) - 1, {}],
  ["stale (configured window)", TIMESTAMP - 301, { timestampToleranceSeconds: 300 }],
  ["future", TIMESTAMP + 301, {}],
]) {
  test(`rejects a ${name} timestamp`, async () => {
    await assert.rejects(verifyPlatformWebhook({
      rawBody: RAW_BODY,
      headers: signedHeaders(RAW_BODY, { timestamp }),
      secret: SIGNING_KEY,
      now: () => TIMESTAMP,
      nonceStore: createMemoryNonceStore(),
      ...options,
    }), (error) => error.code === "WEBHOOK_TIMESTAMP_OUT_OF_RANGE");
  });
}

test("default timestamp window accepts the documented retry schedule reusing the original timestamp", async () => {
  // 2s + 10s + 30s + 1m + 5m + 15m + 1h + 4h after the original attempt.
  const lastRetryAge = 2 + 10 + 30 + 60 + 300 + 900 + 3_600 + 14_400;
  const verified = await verifyPlatformWebhook({
    rawBody: RAW_BODY,
    headers: signedHeaders(RAW_BODY, { timestamp: TIMESTAMP - lastRetryAge }),
    secret: SIGNING_KEY,
    now: () => TIMESTAMP,
    nonceStore: createMemoryNonceStore(),
  });
  assert.equal(await verified.release(), true);
  assert.equal(DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS, 6 * 60 * 60);
  assert.ok(DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS > lastRetryAge);
});

test("timestamp tolerance is configurable and validated", async () => {
  const input = {
    rawBody: RAW_BODY,
    headers: signedHeaders(RAW_BODY, { timestamp: TIMESTAMP - 100 }),
    secret: SIGNING_KEY,
    now: () => TIMESTAMP,
    nonceStore: createMemoryNonceStore(),
  };
  await assert.rejects(
    verifyPlatformWebhook({ ...input, timestampToleranceSeconds: 99 }),
    (error) => error.code === "WEBHOOK_TIMESTAMP_OUT_OF_RANGE",
  );
  const verified = await verifyPlatformWebhook({ ...input, timestampToleranceSeconds: 100 });
  assert.equal(await verified.release(), true);
  for (const invalid of [0, -1, 1.5, "300", 8 * 24 * 60 * 60]) {
    await assert.rejects(
      verifyPlatformWebhook({ ...input, timestampToleranceSeconds: invalid }),
      (error) => error.code === "WEBHOOK_CONFIGURATION_INVALID",
    );
    assert.throws(
      () => createPlatformWebhookHandler({
        secret: SIGNING_KEY, onDelivery: async () => {}, timestampToleranceSeconds: invalid,
      }),
      (error) => error.code === "WEBHOOK_CONFIGURATION_INVALID",
    );
  }
});

test("nonce is held for the whole timestamp window", async () => {
  const nonceStore = createMemoryNonceStore();
  const first = await verifyPlatformWebhook({
    rawBody: RAW_BODY, headers: signedHeaders(), secret: SIGNING_KEY, now: () => TIMESTAMP, nonceStore,
  });
  assert.equal(await first.commit(), true);
  await assert.rejects(verifyPlatformWebhook({
    rawBody: RAW_BODY,
    headers: signedHeaders(),
    secret: SIGNING_KEY,
    now: () => TIMESTAMP + DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    nonceStore,
  }), (error) => error.code === "WEBHOOK_REPLAY" && error.duplicate === true);
});

test("blocks concurrent verification of an in-flight nonce and flags committed replays as duplicates", async () => {
  const nonceStore = createMemoryNonceStore();
  const attempt = () => verifyPlatformWebhook({
    rawBody: RAW_BODY, headers: signedHeaders(), secret: SIGNING_KEY, now: () => TIMESTAMP, nonceStore,
  });
  const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status, reason }) => status === "rejected"
    && reason.code === "WEBHOOK_DELIVERY_IN_PROGRESS" && reason.statusCode === 409).length, 2);
  const [{ value }] = results.filter(({ status }) => status === "fulfilled");
  assert.equal(await value.commit(), true);
  await assert.rejects(attempt(), (error) => error.code === "WEBHOOK_REPLAY"
    && error.duplicate === true && error.statusCode === 200);
});

test("deduplicates a redelivered event by payload id and status even with a fresh nonce", async () => {
  const nonceStore = createMemoryNonceStore();
  const success = JSON.stringify({ id: "123456789", status: 1, url: "https://example.test/v.mp4" });
  const verify = (rawBody, nonce) => verifyPlatformWebhook({
    rawBody, headers: signedHeaders(rawBody, { nonce }), secret: SIGNING_KEY, now: () => TIMESTAMP, nonceStore,
  });
  const first = await verify(success, "nonce-a");
  assert.equal(await first.commit(), true);
  await assert.rejects(verify(success, "nonce-b"), (error) => error.code === "WEBHOOK_DUPLICATE_EVENT"
    && error.duplicate === true && error.statusCode === 200);
  // The rejected redelivery released its own nonce reservation.
  await assert.rejects(verify(success, "nonce-b"), (error) => error.code === "WEBHOOK_DUPLICATE_EVENT");

  // A different status for the same id is a new event.
  const failed = JSON.stringify({ id: "123456789", status: 8, url: null });
  const next = await verify(failed, "nonce-c");
  assert.equal(await next.commit(), true);

  // A released (failed) delivery leaves the event open for the retry.
  const other = JSON.stringify({ id: "987", status: 1 });
  const attempt = await verify(other, "nonce-d");
  assert.equal(await attempt.release(), true);
  const retry = await verify(other, "nonce-e");
  assert.equal(await retry.commit(), true);
});

test("an in-flight event blocks a concurrent redelivery with a different nonce", async () => {
  const nonceStore = createMemoryNonceStore();
  const rawBody = JSON.stringify({ id: "55", status: 1 });
  const verify = (nonce) => verifyPlatformWebhook({
    rawBody, headers: signedHeaders(rawBody, { nonce }), secret: SIGNING_KEY, now: () => TIMESTAMP, nonceStore,
  });
  const first = await verify("first");
  await assert.rejects(verify("second"), (error) => error.code === "WEBHOOK_DELIVERY_IN_PROGRESS");
  assert.equal(await first.release(), true);
  // The losing attempt released its nonce, so its retry proceeds normally.
  const retry = await verify("second");
  assert.equal(await retry.commit(), true);
});

test("bounds and expires the in-memory nonce store", () => {
  const store = createMemoryNonceStore({ maxEntries: 1 });
  assert.equal(store.consume("old", TIMESTAMP + 1, TIMESTAMP), true);
  assert.throws(
    () => store.consume("blocked", TIMESTAMP + 2, TIMESTAMP),
    (error) => error.code === "WEBHOOK_NONCE_STORE_FULL",
  );
  assert.equal(store.consume("new", TIMESTAMP + 3, TIMESTAMP + 2), true);
});

test("supports byte bodies, Headers, Date clocks, and Set replay stores", async () => {
  const nonceStore = new Set();
  const input = {
    rawBody: Buffer.from(RAW_BODY),
    headers: new Headers(signedHeaders()),
    secret: SIGNING_KEY,
    now: () => new Date(TIMESTAMP * 1_000),
    nonceStore,
  };
  const reserved = await verifyPlatformWebhook(input);
  assert.equal(reserved.nonce, "nonce-1");
  await assert.rejects(verifyPlatformWebhook(input), (error) => error.code === "WEBHOOK_DELIVERY_IN_PROGRESS");
  assert.equal(await reserved.release(), true);
  const committed = await verifyPlatformWebhook(input);
  assert.equal(await committed.commit(), true);
  await assert.rejects(verifyPlatformWebhook(input), (error) => error.code === "WEBHOOK_REPLAY");
});

test("standalone verification requires an explicit commit or release", async () => {
  const nonceStore = createMemoryNonceStore();
  const input = {
    rawBody: RAW_BODY,
    headers: signedHeaders(),
    secret: SIGNING_KEY,
    now: () => TIMESTAMP,
    nonceStore,
  };
  const first = await verifyPlatformWebhook(input);
  await assert.rejects(verifyPlatformWebhook(input), (error) => error.code === "WEBHOOK_DELIVERY_IN_PROGRESS");
  assert.equal(await first.release(), true);
  const retry = await verifyPlatformWebhook(input);
  assert.equal(await retry.commit(), true);
  assert.equal(await retry.release(), false);
  await assert.rejects(verifyPlatformWebhook(input), (error) => error.code === "WEBHOOK_REPLAY");
});

test("standalone commit errors remain explicit and do not implicitly release", async () => {
  let releases = 0;
  const commitError = new Error("durable nonce store unavailable");
  const verified = await verifyPlatformWebhook({
    rawBody: RAW_BODY,
    headers: signedHeaders(RAW_BODY, { nonce: "commit-error" }),
    secret: SIGNING_KEY,
    now: () => TIMESTAMP,
    nonceStore: {
      reserve: () => ({
        commit: async () => { throw commitError; },
        release: async () => { releases += 1; return true; },
      }),
    },
  });
  await assert.rejects(verified.commit(), (error) => error === commitError);
  assert.equal(releases, 0);
});

test("matches independent official-style insertion-order and sorted signature vectors", async () => {
  const rawBody = '{"z":"a b&=+~!*\u0027()","a":true,"none":"null","num":10.5}';
  const common = {
    "Webhook-Timestamp": String(TIMESTAMP),
    "Webhook-Nonce": "0123456789abcdef0123456789abcdef",
  };
  for (const signature of [
    "Z7ncfqZaszY/Y6k5NKWvSmdu333nClL51kgYgYFrhoQ=",
    "Yk/kgd9aBU9xdWaM97rylL+P4/Dw5iN3T80C0Em1Lo8=",
  ]) {
    const verified = await verifyPlatformWebhook({
      rawBody,
      headers: { ...common, "Webhook-Signature": signature },
      secret: VECTOR_KEY,
      now: () => TIMESTAMP,
      nonceStore: createMemoryNonceStore(),
    });
    assert.equal(verified.nonce, common["Webhook-Nonce"]);
    assert.equal(await verified.release(), true);
  }
});

test("rejects composite values absent from the official canonicalization", async () => {
  for (const [nonce, rawBody] of [
    ["array-value", '{"id":"1","value":[1,2]}'],
    ["object-value", '{"id":"1","value":{"nested":true}}'],
  ]) {
    await assert.rejects(verifyPlatformWebhook({
      rawBody,
      headers: signedHeaders(RAW_BODY, { nonce }),
      secret: SIGNING_KEY,
      now: () => TIMESTAMP,
      nonceStore: createMemoryNonceStore(),
    }), (error) => error.code === "WEBHOOK_PAYLOAD_UNSUPPORTED");
  }
});

test("accepts null values signed as the official Node example serializes them", async () => {
  const rawBody = '{"id":"123456789","status":8,"url":null,"has_audio":false}';
  // Node example: new URLSearchParams(entries.map(([k, v]) => [k, String(v)])) -> url=null
  const query = "id=123456789&status=8&url=null&has_audio=false";
  const signature = createHmac("sha256", SIGNING_KEY)
    .update(`${TIMESTAMP}\nnull-node\n${query}`)
    .digest("base64");
  const verified = await verifyPlatformWebhook({
    rawBody,
    headers: { "Webhook-Timestamp": String(TIMESTAMP), "Webhook-Nonce": "null-node", "Webhook-Signature": signature },
    secret: SIGNING_KEY,
    now: () => TIMESTAMP,
    nonceStore: createMemoryNonceStore(),
  });
  assert.equal(verified.payload.url, null);
  assert.equal(await verified.release(), true);

  // Go url.Values.Encode (sorted, fmt %v -> <nil>) is accepted too.
  const goQuery = "has_audio=false&id=123456789&status=8&url=%3Cnil%3E";
  const goSignature = createHmac("sha256", SIGNING_KEY)
    .update(`${TIMESTAMP}\nnull-go\n${goQuery}`)
    .digest("base64");
  const goVerified = await verifyPlatformWebhook({
    rawBody,
    headers: { "Webhook-Timestamp": String(TIMESTAMP), "Webhook-Nonce": "null-go", "Webhook-Signature": goSignature },
    secret: SIGNING_KEY,
    now: () => TIMESTAMP,
    nonceStore: createMemoryNonceStore(),
  });
  assert.equal(await goVerified.release(), true);

  // A null cannot be swapped for a different value under the same signature.
  await assert.rejects(verifyPlatformWebhook({
    rawBody: '{"id":"123456789","status":8,"url":"null","has_audio":false}',
    headers: { "Webhook-Timestamp": String(TIMESTAMP), "Webhook-Nonce": "null-swap", "Webhook-Signature": goSignature },
    secret: SIGNING_KEY,
    now: () => TIMESTAMP,
    nonceStore: createMemoryNonceStore(),
  }), (error) => error.code === "WEBHOOK_SIGNATURE_INVALID");
});

test("sorted signatures use code-point key order, not locale order", async () => {
  // localeCompare sorts "a" before "B"; Go/Java byte order sorts "B" first.
  const rawBody = '{"a":"1","B":"2","_c":"3"}';
  const byteOrderQuery = "B=2&_c=3&a=1";
  assert.notEqual(["a", "B", "_c"].sort((l, r) => l.localeCompare(r)).join(), "B,_c,a");
  const signature = createHmac("sha256", SIGNING_KEY)
    .update(`${TIMESTAMP}\nbyte-order\n${byteOrderQuery}`)
    .digest("base64");
  const verified = await verifyPlatformWebhook({
    rawBody,
    headers: { "Webhook-Timestamp": String(TIMESTAMP), "Webhook-Nonce": "byte-order", "Webhook-Signature": signature },
    secret: SIGNING_KEY,
    now: () => TIMESTAMP,
    nonceStore: createMemoryNonceStore(),
  });
  assert.equal(await verified.release(), true);
});

test("fails closed for invalid replay, clock, and header inputs", async () => {
  const base = { rawBody: RAW_BODY, secret: SIGNING_KEY, now: () => TIMESTAMP };
  await assert.rejects(
    verifyPlatformWebhook({ ...base, headers: signedHeaders(), nonceStore: {} }),
    (error) => error.code === "WEBHOOK_NONCE_STORE_INVALID",
  );
  await assert.rejects(
    verifyPlatformWebhook({ ...base, headers: signedHeaders(), now: () => Number.NaN, nonceStore: new Set() }),
    (error) => error.code === "WEBHOOK_CONFIGURATION_INVALID",
  );
  await assert.rejects(
    verifyPlatformWebhook({ ...base, headers: null, nonceStore: new Set() }),
    (error) => error.code === "WEBHOOK_HEADER_MISSING",
  );
  await assert.rejects(
    verifyPlatformWebhook({ ...base, headers: ["Webhook-Timestamp"], nonceStore: new Set() }),
    (error) => error.code === "WEBHOOK_HEADER_INVALID",
  );
  await assert.rejects(
    verifyPlatformWebhook({
      ...base,
      headers: { ...signedHeaders(), "Ai-Trace-Id": "x".repeat(257) },
      nonceStore: new Set(),
    }),
    (error) => error.code === "WEBHOOK_HEADER_INVALID",
  );
});

test("uses a timing-safe comparison with malformed signatures rejected uniformly", async () => {
  for (const signature of ["not-base64", "YQ==", "A".repeat(44)]) {
    await assert.rejects(verifyPlatformWebhook({
      rawBody: RAW_BODY,
      headers: { ...signedHeaders(), "Webhook-Signature": signature },
      secret: SIGNING_KEY,
      now: () => TIMESTAMP,
      nonceStore: createMemoryNonceStore(),
    }), (error) => error.code === "WEBHOOK_SIGNATURE_INVALID" && !error.message.includes(signature));
  }
});

test("parses valid JSON without losing large integer identifiers", () => {
  const parsed = parsePlatformWebhook('{"video_id":9007199254740993123}');
  assert.equal(parsed.video_id, "9007199254740993123");
});

test("returns ordinary plain objects and rejects prototype-pollution keys", () => {
  const parsed = parsePlatformWebhook('{"delivery":{"status":"ready","items":[{"id":1}]}}');
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.getPrototypeOf(parsed.delivery), Object.prototype);
  assert.equal(Object.getPrototypeOf(parsed.delivery.items[0]), Object.prototype);
  assert.throws(
    () => parsePlatformWebhook('{"__proto__":{"polluted":true}}'),
    (error) => error.code === "WEBHOOK_PAYLOAD_INVALID",
  );
  assert.equal({}.polluted, undefined);
});

test("requires safe handler configuration", () => {
  assert.throws(
    () => createPlatformWebhookHandler({ secret: "", onDelivery: async () => {} }),
    (error) => error.code === "WEBHOOK_CONFIGURATION_INVALID",
  );
  assert.throws(
    () => createPlatformWebhookHandler({ secret: SIGNING_KEY }),
    (error) => error.code === "WEBHOOK_CONFIGURATION_INVALID",
  );
});

test("rejects malformed and non-object payloads", () => {
  for (const rawBody of ["{", "null", "[]", "\"string\""]) {
    assert.throws(() => parsePlatformWebhook(rawBody), (error) => error.code === "WEBHOOK_PAYLOAD_INVALID");
  }
});
