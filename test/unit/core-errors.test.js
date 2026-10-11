import assert from "node:assert/strict";
import test from "node:test";

import { PixverseCliError, serializeError } from "../../src/core/errors.js";

test("PixverseCliError and serialization expose stable redacted public fields", () => {
  const error = new PixverseCliError("Request failed", {
    category: "http",
    provider: "platform",
    operation: "video.create",
    status: 429,
    code: "RATE_LIMITED",
    retryable: true,
    retryAfter: 12,
    traceId: "trace-1",
    requestId: "request-fixture",
    details: { "API-KEY": "top-secret", video_id: "42" },
  });

  assert.deepEqual(serializeError(error), {
    name: "PixverseCliError",
    message: "Request failed",
    category: "http",
    provider: "platform",
    operation: "video.create",
    status: 429,
    code: "RATE_LIMITED",
    retryable: true,
    retry_after: 12,
    trace_id: "trace-1",
    request_id: "request-fixture",
    details: { "API-KEY": "[REDACTED]", video_id: "42" },
  });
  assert.doesNotMatch(JSON.stringify(serializeError(error)), /top-secret/);
});

test("serializeError accepts ordinary errors without unstable stack output", () => {
  assert.deepEqual(serializeError(new Error("boom")), {
    name: "Error",
    message: "boom",
  });
});

test("serializeError preserves an ordinary API error request ID", () => {
  const error = Object.assign(new Error("upstream failed"), {
    requestId: "request-fixture",
  });

  assert.deepEqual(serializeError(error), {
    name: "Error",
    message: "upstream failed",
    request_id: "request-fixture",
  });
});

test("PixverseCliError also accepts a single options object", () => {
  const error = new PixverseCliError({ message: "Invalid input", category: "validation", code: "BAD_INPUT" });
  assert.deepEqual(serializeError(error), {
    name: "PixverseCliError",
    message: "Invalid input",
    category: "validation",
    code: "BAD_INPUT",
  });
});

test("isTransientReadError classifies transport, 429, 5xx, and retryable provider codes", async () => {
  const { isTransientReadError, PixverseCliError } = await import("../../src/core/errors.js");
  const make = (fields) => new PixverseCliError("x", fields);
  assert.equal(isTransientReadError(make({ category: "transport" })), true);
  assert.equal(isTransientReadError(make({ category: "http", status: 429 })), true);
  assert.equal(isTransientReadError(make({ category: "http", status: 503 })), true);
  assert.equal(isTransientReadError(make({ category: "provider", status: 500, retryable: false })), true);
  assert.equal(isTransientReadError(make({ category: "response", status: 502 })), true);
  assert.equal(isTransientReadError(make({ category: "provider", status: 200, code: 500069, retryable: true })), true);
  assert.equal(isTransientReadError(make({ category: "provider", status: 200, code: 400017, retryable: false })), false);
  assert.equal(isTransientReadError(make({ category: "http", status: 400 })), false);
  assert.equal(isTransientReadError(make({ category: "response", status: 200 })), false);
  const abort = new DOMException("aborted", "AbortError");
  assert.equal(isTransientReadError(make({ category: "transport", cause: abort })), false);
  assert.equal(isTransientReadError(undefined), false);
});
