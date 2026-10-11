import assert from "node:assert/strict";
import test from "node:test";

import { parsePlatformEnvelope } from "../../src/platform/envelope.js";

test("parsePlatformEnvelope unwraps ErrCode zero and retains the raw envelope", () => {
  const body = Object.freeze({
    ErrCode: 0,
    ErrMsg: "success",
    Resp: Object.freeze({ video_id: "627410861853514292" }),
  });

  const parsed = parsePlatformEnvelope(body, {
    operation: "video.status",
    traceId: "trace-fixture",
  });

  assert.equal(parsed.data, body.Resp);
  assert.equal(parsed.envelope, body);
});

test("parsePlatformEnvelope treats nonzero ErrCode as failure even on HTTP success", () => {
  const body = { ErrCode: 10005, ErrMsg: "insufficient credit", Resp: null };

  assert.throws(
    () => parsePlatformEnvelope(body, {
      operation: "video.text",
      traceId: "trace-fixture",
      httpStatus: 200,
    }),
    (error) => error.category === "provider"
      && error.provider === "platform"
      && error.operation === "video.text"
      && error.status === 200
      && error.code === 10005
      && error.traceId === "trace-fixture"
      && error.details === body,
  );
});

test("parsePlatformEnvelope rejects malformed response bodies", () => {
  for (const body of [null, [], {}, { ErrCode: "wat" }]) {
    assert.throws(() => parsePlatformEnvelope(body), /Platform API response envelope/i);
  }
});

test("parsePlatformEnvelope marks documented transient ErrCodes retryable and others not", () => {
  for (const [code, retryable] of [[500069, true], ["500069", true], [500044, true], [10005, false], [500063, false]]) {
    assert.throws(
      () => parsePlatformEnvelope({ ErrCode: code, ErrMsg: "x", Resp: null }, { retryAfter: 3 }),
      (error) => error.retryable === retryable && error.retryAfter === 3,
    );
  }
});
