import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import test from "node:test";

import { createPlatformWebhookHandler } from "../../src/platform/webhooks.js";

const SIGNING_KEY = "e2e-webhook-key";
const TIMESTAMP = 1_800_000_000;

function headersFor(rawBody, { nonce = "e2e-nonce", signatureBody = rawBody } = {}) {
  const payload = JSON.parse(signatureBody);
  const query = new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, String(value)]));
  const signed = `${TIMESTAMP}\n${nonce}\n${query}`;
  return {
    "Webhook-Timestamp": String(TIMESTAMP),
    "Webhook-Nonce": nonce,
    "Webhook-Signature": createHmac("sha256", SIGNING_KEY).update(signed).digest("base64"),
  };
}

async function startHandler(t, options) {
  const server = http.createServer(createPlatformWebhookHandler({
    secret: SIGNING_KEY,
    now: () => TIMESTAMP,
    ...options,
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

test("returns exact plain ok only after verified delivery completes", async (t) => {
  const events = [];
  const rawBody = JSON.stringify({ event: "video.completed", id: "123" });
  const url = await startHandler(t, {
    onDelivery: async (payload, context) => events.push({ payload, context }),
  });
  const response = await fetch(url, { method: "POST", headers: headersFor(rawBody), body: rawBody });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await response.text(), "ok");
  assert.equal(events.length, 1);
  assert.deepEqual({ ...events[0].payload }, { event: "video.completed", id: "123" });
  assert.deepEqual(events[0].context, {
    timestamp: String(TIMESTAMP),
    nonce: "e2e-nonce",
    signature: headersFor(rawBody)["Webhook-Signature"],
    traceId: undefined,
  });
});

test("rejects invalid signatures and malformed payloads before delivery", async (t) => {
  let mutations = 0;
  const url = await startHandler(t, { onDelivery: async () => { mutations += 1; } });

  const invalidBody = JSON.stringify({ event: "forged" });
  const invalidSignature = await fetch(url, {
    method: "POST", headers: headersFor(invalidBody, { signatureBody: '{"event":"different"}' }), body: invalidBody,
  });
  assert.equal(invalidSignature.status, 401);

  const malformedPayload = await fetch(url, {
    method: "POST", headers: headersFor('{"event":"placeholder"}', { nonce: "malformed" }), body: "{",
  });
  assert.equal(malformedPayload.status, 400);

  const goodBody = JSON.stringify({ event: "ready" });
  const failedDeliveryUrl = await startHandler(t, { onDelivery: async () => { throw new Error(`private ${SIGNING_KEY}`); } });
  const failedDelivery = await fetch(failedDeliveryUrl, {
    method: "POST", headers: headersFor(goodBody, { nonce: "delivery-error" }), body: goodBody,
  });
  assert.equal(failedDelivery.status, 500);
  assert.equal((await failedDelivery.text()).includes(SIGNING_KEY), false);
  assert.equal(mutations, 0);
});

test("acknowledges a verified replay with ok without redelivery; rejects non-POST or oversized requests", async (t) => {
  let deliveries = 0;
  const rawBody = JSON.stringify({ event: "ready" });
  const url = await startHandler(t, { onDelivery: async () => { deliveries += 1; } });
  const options = { method: "POST", headers: headersFor(rawBody), body: rawBody };
  assert.equal((await fetch(url, options)).status, 200);
  const replay = await fetch(url, options);
  // PixVerse resends until it receives exact `ok`, so a duplicate is acknowledged.
  assert.equal(replay.status, 200);
  assert.equal(await replay.text(), "ok");
  assert.equal((await fetch(url)).status, 405);

  const oversized = "x".repeat(1_048_577);
  const oversizedResponse = await fetch(url, {
    method: "POST", headers: headersFor('{"event":"large"}', { nonce: "large" }), body: oversized,
  });
  assert.equal(oversizedResponse.status, 413);
  assert.equal(deliveries, 1);
});

test("a redelivery of the same id and status with a fresh nonce is acknowledged once", async (t) => {
  const events = [];
  const url = await startHandler(t, { onDelivery: async (payload) => events.push(payload) });
  const success = JSON.stringify({ id: "123456789", status: 1, url: "https://example.test/v.mp4", has_audio: true });
  for (const nonce of ["first-delivery", "redelivery-1", "redelivery-2"]) {
    const response = await fetch(url, { method: "POST", headers: headersFor(success, { nonce }), body: success });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  }
  assert.equal(events.length, 1);

  const later = JSON.stringify({ id: "123456789", status: 8, url: null });
  const response = await fetch(url, { method: "POST", headers: headersFor(later, { nonce: "status-8" }), body: later });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(events.length, 2);
  assert.equal(events[1].url, null);
});

test("blocks a concurrent duplicate while the first delivery is in progress", async (t) => {
  let releaseDelivery;
  let deliveries = 0;
  const gate = new Promise((resolve) => { releaseDelivery = resolve; });
  const rawBody = JSON.stringify({ event: "processing", id: "concurrent" });
  const url = await startHandler(t, {
    onDelivery: async () => {
      deliveries += 1;
      await gate;
    },
  });
  const options = { method: "POST", headers: headersFor(rawBody, { nonce: "concurrent" }), body: rawBody };
  const firstResponse = fetch(url, options);
  while (deliveries === 0) await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await fetch(url, options);
  assert.equal(duplicate.status, 409);
  releaseDelivery();
  assert.equal((await firstResponse).status, 200);
  assert.equal(deliveries, 1);
});

test("releases a nonce after transient delivery failure so the retry can succeed", async (t) => {
  let attempts = 0;
  const rawBody = JSON.stringify({ event: "retry", id: "retryable" });
  const url = await startHandler(t, {
    onDelivery: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient storage outage");
    },
  });
  const options = { method: "POST", headers: headersFor(rawBody, { nonce: "retry-nonce" }), body: rawBody };
  assert.equal((await fetch(url, options)).status, 500);
  const retry = await fetch(url, options);
  assert.equal(retry.status, 200);
  assert.equal(await retry.text(), "ok");
  assert.equal(attempts, 2);
});

test("returns non-200 without ok or release when durable nonce commit throws", async (t) => {
  let deliveries = 0;
  let releases = 0;
  const rawBody = JSON.stringify({ event: "commit", id: "commit-throws" });
  const url = await startHandler(t, {
    nonceStore: {
      reserve: () => ({
        commit: async () => { throw new Error(`private ${SIGNING_KEY}`); },
        release: async () => { releases += 1; return true; },
      }),
    },
    onDelivery: async () => { deliveries += 1; },
  });
  const response = await fetch(url, {
    method: "POST", headers: headersFor(rawBody, { nonce: "commit-throws" }), body: rawBody,
  });
  const responseBody = await response.text();
  assert.equal(response.status, 500);
  assert.notEqual(responseBody, "ok");
  assert.equal(responseBody.includes(SIGNING_KEY), false);
  assert.equal(deliveries, 1);
  assert.equal(releases, 0);
});

test("returns non-200 without release when durable nonce commit times out", async (t) => {
  let releases = 0;
  const rawBody = JSON.stringify({ event: "commit", id: "commit-timeout" });
  const url = await startHandler(t, {
    commitTimeoutMs: 5,
    nonceStore: {
      reserve: () => ({
        commit: async () => new Promise(() => {}),
        release: async () => { releases += 1; return true; },
      }),
    },
    onDelivery: async () => {},
  });
  const response = await fetch(url, {
    method: "POST", headers: headersFor(rawBody, { nonce: "commit-timeout" }), body: rawBody,
  });
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "webhook delivery failed");
  assert.equal(releases, 0);
});
