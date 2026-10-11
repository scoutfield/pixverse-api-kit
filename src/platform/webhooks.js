import { createHmac, timingSafeEqual } from "node:crypto";

import JSONBigFactory from "json-bigint";

import { PixverseCliError } from "../core/errors.js";

const JSON_BIG = JSONBigFactory({
  storeAsString: true,
  protoAction: "error",
  constructorAction: "error",
});
const MAX_BODY_BYTES = 1_048_576;
const MAX_SECRET_BYTES = 4_096;
const MAX_NONCE_BYTES = 256;
const MAX_TRACE_ID_BYTES = 256;
// PixVerse retries a failed delivery after 2s, 10s, 30s, 1m, 5m, 15m, 1h and
// 4h (about 5h22m in total), and the docs do not say whether a retry is
// re-signed with a fresh Webhook-Timestamp. A 300s window could therefore
// reject PixVerse's own late retries and lose the result. The default accepts
// the whole documented schedule plus margin. Widening the window is safe
// because replays are still stopped by the nonce store (each nonce is held
// for the full window) and by (payload id, status) event deduplication.
export const DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 6 * 60 * 60;
const MAX_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 7 * 24 * 60 * 60;
// Clock skew allowed for timestamps in the future; deliveries are never
// legitimately signed far ahead of the receiver's clock.
const MAX_FUTURE_SKEW_SECONDS = 300;
const MAX_NONCES = 100_000;
const EVENT_KEY_PREFIX = "pixverse-webhook-event:";
const DEFAULT_COMMIT_TIMEOUT_MS = 5_000;
const MAX_COMMIT_TIMEOUT_MS = 60_000;
const REQUIRED_HEADERS = new Map([
  ["webhook-timestamp", "timestamp"],
  ["webhook-nonce", "nonce"],
  ["webhook-signature", "signature"],
]);

export function createMemoryNonceStore(options = {}) {
  const maxEntries = positiveInteger(options.maxEntries, MAX_NONCES);
  const entries = new Map();
  function reserve(nonce, expiresAt, nowSeconds) {
    for (const [storedNonce, entry] of entries) {
      if (entry.expiresAt < nowSeconds) entries.delete(storedNonce);
    }
    const existing = entries.get(nonce);
    // A committed key is an already-processed delivery: report a duplicate.
    // An in-flight reservation must not be acknowledged, because the first
    // attempt may still fail and release it; ask the sender to retry later.
    if (existing?.state === "committed") return undefined;
    if (existing) throw inProgressError();
    if (entries.size >= maxEntries) throw webhookError(
      "Webhook replay protection is temporarily unavailable.",
      "WEBHOOK_NONCE_STORE_FULL",
      503,
    );
    const token = Symbol("webhook-nonce-reservation");
    entries.set(nonce, { expiresAt, state: "reserved", token });
    return Object.freeze({
      commit() {
        const entry = entries.get(nonce);
        if (entry?.state !== "reserved" || entry.token !== token) return false;
        entries.set(nonce, { expiresAt: entry.expiresAt, state: "committed" });
        return true;
      },
      release() {
        const entry = entries.get(nonce);
        if (entry?.state !== "reserved" || entry.token !== token) return false;
        entries.delete(nonce);
        return true;
      },
    });
  }
  return Object.freeze({
    reserve,
    consume(nonce, expiresAt, nowSeconds) {
      const reservation = reserve(nonce, expiresAt, nowSeconds);
      return reservation ? reservation.commit() : false;
    },
  });
}

export async function verifyPlatformWebhook(options = {}) {
  const rawBody = normalizeRawBody(options.rawBody);
  const secret = requireBoundedString(options.secret, "webhook secret", MAX_SECRET_BYTES, {
    code: "WEBHOOK_CONFIGURATION_INVALID",
    statusCode: 500,
  });
  const headers = normalizeHeaders(options.headers);
  const timestamp = requiredHeader(headers, "webhook-timestamp");
  const nonce = requiredHeader(headers, "webhook-nonce");
  const signature = requiredHeader(headers, "webhook-signature");
  const traceId = optionalHeader(headers, "ai-trace-id", MAX_TRACE_ID_BYTES);

  requireBoundedString(nonce, "webhook nonce", MAX_NONCE_BYTES, {
    code: "WEBHOOK_HEADER_INVALID", statusCode: 401,
  });
  if (!/^[0-9]{1,13}$/.test(timestamp)) {
    throw webhookError("Webhook authentication failed.", "WEBHOOK_TIMESTAMP_INVALID", 401);
  }
  const toleranceSeconds = normalizeTimestampTolerance(options.timestampToleranceSeconds);
  const timestampSeconds = unixSeconds(Number(timestamp));
  const nowSeconds = unixSeconds(resolveNow(options.now));
  const ageSeconds = nowSeconds - timestampSeconds;
  if (ageSeconds > toleranceSeconds || -ageSeconds > Math.min(MAX_FUTURE_SKEW_SECONDS, toleranceSeconds)) {
    throw webhookError("Webhook authentication failed.", "WEBHOOK_TIMESTAMP_OUT_OF_RANGE", 401);
  }

  const payload = parsePlatformWebhook(rawBody);
  const supplied = decodeSha256Signature(signature);
  let matched = 0;
  for (const query of canonicalWebhookQueries(payload)) {
    matched |= Number(timingSafeEqual(signWebhookQuery(secret, timestamp, nonce, query), supplied));
  }
  if (matched === 0) {
    throw webhookError("Webhook authentication failed.", "WEBHOOK_SIGNATURE_INVALID", 401);
  }

  const nonceStore = options.nonceStore;
  if (!nonceStore || (typeof nonceStore.reserve !== "function"
    && !(typeof nonceStore.has === "function"
      && typeof nonceStore.add === "function"
      && typeof nonceStore.delete === "function"))) {
    throw webhookError(
      "Webhook replay protection is not configured.",
      "WEBHOOK_NONCE_STORE_INVALID",
      500,
    );
  }
  // The nonce must stay reserved for as long as its timestamp is acceptable.
  const nonceReservation = await reserveKey(nonceStore, nonce, timestampSeconds + toleranceSeconds, nowSeconds);
  if (!nonceReservation) {
    throw duplicateError("Webhook delivery was already received.", "WEBHOOK_REPLAY");
  }

  // PixVerse recommends idempotency by payload `id`. A redelivery can carry a
  // fresh nonce, so also deduplicate on (id, status); a later status for the
  // same id is a distinct event and still delivered.
  const eventKey = webhookEventKey(payload);
  let eventReservation;
  if (eventKey !== undefined) {
    try {
      eventReservation = await reserveKey(nonceStore, eventKey, nowSeconds + toleranceSeconds, nowSeconds);
    } catch (error) {
      await safeRelease(nonceReservation);
      throw error;
    }
    if (!eventReservation) {
      await safeRelease(nonceReservation);
      throw duplicateError("Webhook event was already processed.", "WEBHOOK_DUPLICATE_EVENT");
    }
  }
  const reservations = eventReservation ? [nonceReservation, eventReservation] : [nonceReservation];

  return {
    timestamp,
    nonce,
    signature,
    traceId,
    payload,
    commit: async () => {
      const results = await Promise.all(reservations.map((reservation) => reservation.commit()));
      return results.every((result) => result === true);
    },
    release: async () => {
      const results = await Promise.all(reservations.map((reservation) => reservation.release()));
      return results.every((result) => result === true);
    },
  };
}

async function reserveKey(store, key, expiresAt, nowSeconds) {
  const reservation = typeof store.reserve === "function"
    ? await store.reserve(key, expiresAt, nowSeconds)
    : reserveSetLikeNonceStore(store, key);
  if (!reservation) return undefined;
  if (typeof reservation.commit !== "function" || typeof reservation.release !== "function") {
    throw webhookError(
      "Webhook replay protection returned an invalid reservation.",
      "WEBHOOK_NONCE_STORE_INVALID",
      500,
    );
  }
  return reservation;
}

async function safeRelease(reservation) {
  try {
    await reservation.release();
  } catch {
    // Never disclose store internals; the original outcome is reported.
  }
}

function webhookEventKey(payload) {
  const { id } = payload;
  if (!((typeof id === "string" && id !== "") || (typeof id === "number" && Number.isFinite(id)))) {
    return undefined;
  }
  const status = payload.status;
  const statusPart = status === undefined || status === null || typeof status === "object" ? "" : String(status);
  return `${EVENT_KEY_PREFIX}${JSON.stringify([String(id), statusPart])}`;
}

export function parsePlatformWebhook(rawBody) {
  const normalized = normalizeRawBody(rawBody);
  let payload;
  try {
    payload = JSON_BIG.parse(normalized);
  } catch (cause) {
    throw webhookError("Webhook payload is not valid JSON.", "WEBHOOK_PAYLOAD_INVALID", 400, cause);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw webhookError("Webhook payload must be a JSON object.", "WEBHOOK_PAYLOAD_INVALID", 400);
  }
  return toPlainJsonValue(payload);
}

export function createPlatformWebhookHandler(options = {}) {
  requireBoundedString(options.secret, "webhook secret", MAX_SECRET_BYTES, {
    code: "WEBHOOK_CONFIGURATION_INVALID", statusCode: 500,
  });
  if (typeof options.onDelivery !== "function") {
    throw webhookError("A webhook delivery callback is required.", "WEBHOOK_CONFIGURATION_INVALID", 500);
  }
  const nonceStore = options.nonceStore ?? createMemoryNonceStore();
  const commitTimeoutMs = normalizeCommitTimeout(options.commitTimeoutMs);
  const timestampToleranceSeconds = normalizeTimestampTolerance(options.timestampToleranceSeconds);

  return async function platformWebhookHandler(request, response) {
    let verification;
    let commitStarted = false;
    try {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        throw webhookError("Method not allowed.", "WEBHOOK_METHOD_NOT_ALLOWED", 405);
      }
      const rawBody = await readRawBody(request);
      verification = await verifyPlatformWebhook({
        rawBody,
        headers: request.rawHeaders ?? request.headers,
        secret: options.secret,
        now: options.now,
        nonceStore,
        timestampToleranceSeconds,
      });
      const context = {
        timestamp: verification.timestamp,
        nonce: verification.nonce,
        signature: verification.signature,
        traceId: verification.traceId,
      };
      await options.onDelivery(verification.payload, context);
      commitStarted = true;
      await commitNonceReservation(verification, commitTimeoutMs);
      verification = undefined;
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok");
    } catch (error) {
      if (error?.duplicate === true && !response.headersSent) {
        // A verified redelivery of an already-processed event. PixVerse keeps
        // resending until it receives exact `ok`, so acknowledge it without
        // invoking onDelivery again.
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("ok");
        return;
      }
      if (verification && !commitStarted) {
        try {
          await verification.release();
        } catch {
          // The response remains a failure; never disclose nonce-store internals.
        }
      }
      // A started durable commit has an ambiguous outcome. Releasing here could
      // admit a duplicate delivery, so only pre-commit failures are released.
      if (response.headersSent) {
        response.end();
        return;
      }
      const statusCode = safeStatusCode(error?.statusCode);
      response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
      response.end(statusCode === 500 ? "webhook delivery failed" : "webhook rejected");
    }
  };
}

async function readRawBody(request) {
  const declaredLength = Number(request.headers?.["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    request.resume();
    throw webhookError("Webhook body is too large.", "WEBHOOK_BODY_TOO_LARGE", 413);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      request.resume();
      throw webhookError("Webhook body is too large.", "WEBHOOK_BODY_TOO_LARGE", 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function normalizeRawBody(rawBody) {
  let value;
  if (typeof rawBody === "string") value = rawBody;
  else if (Buffer.isBuffer(rawBody)) value = rawBody.toString("utf8");
  else throw webhookError("Webhook body must be raw text or bytes.", "WEBHOOK_BODY_INVALID", 400);
  if (Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES) {
    throw webhookError("Webhook body is too large.", "WEBHOOK_BODY_TOO_LARGE", 413);
  }
  return value;
}

function normalizeHeaders(input) {
  if (!input || typeof input !== "object") {
    throw webhookError("Webhook authentication failed.", "WEBHOOK_HEADER_MISSING", 401);
  }
  const entries = Array.isArray(input)
    ? rawHeaderEntries(input)
    : typeof input.entries === "function"
      ? [...input.entries()]
      : Object.entries(input);
  const normalized = new Map();
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName).toLowerCase();
    if (!REQUIRED_HEADERS.has(name) && name !== "ai-trace-id") continue;
    if (normalized.has(name) || Array.isArray(rawValue)) {
      throw webhookError("Webhook authentication failed.", "WEBHOOK_HEADER_DUPLICATE", 401);
    }
    if (typeof rawValue !== "string") {
      throw webhookError("Webhook authentication failed.", "WEBHOOK_HEADER_INVALID", 401);
    }
    normalized.set(name, rawValue);
  }
  return normalized;
}

function rawHeaderEntries(headers) {
  if (headers.length % 2 !== 0) {
    throw webhookError("Webhook authentication failed.", "WEBHOOK_HEADER_INVALID", 401);
  }
  const entries = [];
  for (let index = 0; index < headers.length; index += 2) {
    entries.push([headers[index], headers[index + 1]]);
  }
  return entries;
}

function requiredHeader(headers, name) {
  const value = headers.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw webhookError("Webhook authentication failed.", "WEBHOOK_HEADER_MISSING", 401);
  }
  return value;
}

function optionalHeader(headers, name, maxBytes) {
  const value = headers.get(name);
  if (value === undefined) return undefined;
  return requireBoundedString(value, name, maxBytes, {
    code: "WEBHOOK_HEADER_INVALID", statusCode: 401, allowEmpty: true,
  });
}

function requireBoundedString(value, label, maxBytes, options = {}) {
  const isEmpty = typeof value !== "string" || (!options.allowEmpty && value.length === 0);
  if (isEmpty || Buffer.byteLength(value ?? "", "utf8") > maxBytes) {
    throw webhookError(
      options.statusCode === 401 ? "Webhook authentication failed." : `Invalid ${label}.`,
      options.code,
      options.statusCode,
    );
  }
  return value;
}

function decodeSha256Signature(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw webhookError("Webhook authentication failed.", "WEBHOOK_SIGNATURE_INVALID", 401);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw webhookError("Webhook authentication failed.", "WEBHOOK_SIGNATURE_INVALID", 401);
  }
  return decoded;
}

// The official Node example serializes each value with String(value), so a
// null (for example "url": null on a failure delivery) signs as "null". The Go
// (`fmt %v` -> "<nil>") and Python (`str` -> "None") examples differ, so those
// spellings are also accepted for null values; every candidate is still a full
// HMAC comparison. Rejecting null would return non-ok and lose the delivery.
const NULL_SPELLINGS = ["null", "<nil>", "None"];

function canonicalWebhookQueries(payload) {
  let hasNull = false;
  for (const value of Object.values(payload)) {
    if (value === null) hasNull = true;
    else if (typeof value === "object") {
      throw webhookError(
        "Webhook payload contains a value unsupported by the documented signature format.",
        "WEBHOOK_PAYLOAD_UNSUPPORTED",
        400,
      );
    }
  }
  const queries = [];
  for (const nullSpelling of hasNull ? NULL_SPELLINGS : [NULL_SPELLINGS[0]]) {
    const entries = Object.entries(payload).map(([key, value]) => [
      key, value === null ? nullSpelling : String(value),
    ]);
    // Code-point (byte) order, matching Go url.Values.Encode and Java TreeMap
    // for the documented keys; localeCompare is locale- and case-folding-aware.
    const sortedEntries = [...entries].sort(([left], [right]) => compareCodePoints(left, right));
    queries.push(new URLSearchParams(entries).toString(), new URLSearchParams(sortedEntries).toString());
  }
  return queries;
}

function compareCodePoints(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function signWebhookQuery(secret, timestamp, nonce, query) {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${nonce}\n${query}`)
    .digest();
}

const SET_LIKE_IN_FLIGHT = new WeakMap();

function reserveSetLikeNonceStore(store, nonce) {
  let inFlight = SET_LIKE_IN_FLIGHT.get(store);
  if (!inFlight) {
    inFlight = new Set();
    SET_LIKE_IN_FLIGHT.set(store, inFlight);
  }
  if (store.has(nonce)) {
    if (inFlight.has(nonce)) throw inProgressError();
    return undefined;
  }
  store.add(nonce);
  inFlight.add(nonce);
  let state = "reserved";
  return Object.freeze({
    commit() {
      if (state !== "reserved") return false;
      state = "committed";
      inFlight.delete(nonce);
      return true;
    },
    release() {
      if (state !== "reserved") return false;
      state = "released";
      inFlight.delete(nonce);
      return store.delete(nonce);
    },
  });
}

async function commitNonceReservation(verification, timeoutMs) {
  let timeout;
  try {
    const committed = await Promise.race([
      Promise.resolve().then(() => verification.commit()),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(webhookError(
          "Webhook replay protection commit timed out.",
          "WEBHOOK_NONCE_COMMIT_TIMEOUT",
          500,
        )), timeoutMs);
      }),
    ]);
    if (committed !== true) {
      throw webhookError(
        "Webhook replay protection commit failed.",
        "WEBHOOK_NONCE_COMMIT_FAILED",
        500,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

function resolveNow(now) {
  const value = typeof now === "function" ? now() : Date.now();
  if (value instanceof Date) return value.getTime();
  if (!Number.isFinite(value)) {
    throw webhookError("Webhook clock is invalid.", "WEBHOOK_CONFIGURATION_INVALID", 500);
  }
  return value;
}

function unixSeconds(value) {
  return Math.floor(Math.abs(value) >= 100_000_000_000 ? value / 1_000 : value);
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeTimestampTolerance(value) {
  if (value === undefined) return DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    throw webhookError(
      "Invalid webhook timestamp tolerance.",
      "WEBHOOK_CONFIGURATION_INVALID",
      500,
    );
  }
  return value;
}

function normalizeCommitTimeout(value) {
  if (value === undefined) return DEFAULT_COMMIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COMMIT_TIMEOUT_MS) {
    throw webhookError("Invalid webhook commit timeout.", "WEBHOOK_CONFIGURATION_INVALID", 500);
  }
  return value;
}

function safeStatusCode(value) {
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}

function toPlainJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => toPlainJsonValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toPlainJsonValue(entry)]));
  }
  return value;
}

function duplicateError(message, code) {
  // statusCode 200: the correct reply to a verified duplicate is exact `ok`.
  const error = webhookError(message, code, 200);
  error.duplicate = true;
  return error;
}

function inProgressError() {
  return webhookError(
    "Webhook delivery is already being processed.",
    "WEBHOOK_DELIVERY_IN_PROGRESS",
    409,
  );
}

function webhookError(message, code, statusCode, cause) {
  const error = new PixverseCliError(message, {
    category: "webhook",
    provider: "platform",
    operation: "webhook.verify",
    code,
    retryable: false,
    cause,
  });
  error.statusCode = statusCode;
  return error;
}
