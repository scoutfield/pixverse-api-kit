import assert from "node:assert/strict";
import test from "node:test";

import { pollUntilTerminal } from "../../src/core/polling.js";

test("pollUntilTerminal uses injected time and sleep and preserves unknown statuses", async () => {
  let nowMs = 0;
  const snapshots = [{ status: 777, marker: "unknown" }, { status: 1, marker: "done" }];
  const seen = [];

  const result = await pollUntilTerminal({
    poll: async () => snapshots.shift(),
    isTerminal: (snapshot) => snapshot.status === 1,
    intervalMs: 250,
    timeoutMs: 1_000,
    now: () => nowMs,
    sleep: async (milliseconds) => { nowMs += milliseconds; },
    onSnapshot: async (snapshot) => seen.push(snapshot),
  });

  assert.deepEqual(seen[0], { status: 777, marker: "unknown" });
  assert.deepEqual(result, { status: 1, marker: "done" });
  assert.equal(nowMs, 250);
});

test("pollUntilTerminal throws a structured timeout with the last snapshot", async () => {
  let nowMs = 0;
  await assert.rejects(
    pollUntilTerminal({
      poll: async () => ({ status: "mystery" }),
      isTerminal: () => false,
      intervalMs: 100,
      timeoutMs: 250,
      now: () => nowMs,
      sleep: async (milliseconds) => { nowMs += milliseconds; },
      provider: "platform",
      operation: "video.poll",
    }),
    (error) => error.category === "timeout"
      && error.provider === "platform"
      && error.details.last_snapshot.status === "mystery",
  );
});

test("pollUntilTerminal validates callbacks and time bounds", async () => {
  await assert.rejects(pollUntilTerminal({ isTerminal: () => true }), /poll must be a function/i);
  await assert.rejects(pollUntilTerminal({ poll: async () => ({}), intervalMs: 0 }), /isTerminal must be a function/i);
  await assert.rejects(
    pollUntilTerminal({ poll: async () => ({}), isTerminal: () => false, intervalMs: 0 }),
    /intervalMs must be a positive number/i,
  );
  await assert.rejects(
    pollUntilTerminal({ poll: async () => ({}), isTerminal: () => false, timeoutMs: -1 }),
    /timeoutMs must be a non-negative number/i,
  );
});

function transient(fields = {}) {
  return Object.assign(new Error("transient"), { category: "transport", ...fields });
}

test("pollUntilTerminal keeps polling through retryable errors with backoff and Retry-After", async () => {
  let nowMs = 0;
  const delays = [];
  const outcomes = [
    transient(),
    transient({ category: "http", status: 503 }),
    transient({ category: "http", status: 429, retryAfter: 30 }),
    { status: 5 },
    transient(),
    { status: 1 },
  ];
  const errors = [];
  const result = await pollUntilTerminal({
    poll: async () => {
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    isTerminal: (snapshot) => snapshot.status === 1,
    isRetryableError: () => true,
    onPollError: async (error, { consecutiveErrors }) => errors.push(consecutiveErrors),
    intervalMs: 1_000,
    maxBackoffMs: 3_000,
    timeoutMs: 600_000,
    now: () => nowMs,
    sleep: async (milliseconds) => { delays.push(milliseconds); nowMs += milliseconds; },
  });
  assert.deepEqual(result, { status: 1 });
  // 1s, 2s backoff, then Retry-After 30s beats the 3s cap, success resets the streak.
  assert.deepEqual(delays, [1_000, 2_000, 30_000, 1_000, 1_000]);
  assert.deepEqual(errors, [1, 2, 3, 1]);
});

test("pollUntilTerminal rethrows non-retryable errors immediately", async () => {
  let polls = 0;
  const fatal = Object.assign(new Error("bad id"), { category: "provider", retryable: false });
  await assert.rejects(pollUntilTerminal({
    poll: async () => { polls += 1; throw fatal; },
    isTerminal: () => false,
    isRetryableError: (error) => error.retryable === true,
    sleep: async () => { throw new Error("must not sleep"); },
  }), (error) => error === fatal);
  assert.equal(polls, 1);

  // Without the opt-in classifier, any error still fails fast (backward compatible).
  await assert.rejects(pollUntilTerminal({
    poll: async () => { throw transient(); },
    isTerminal: () => false,
  }), /transient/);
});

test("pollUntilTerminal times out with the last error when transient failures persist", async () => {
  let nowMs = 0;
  await assert.rejects(pollUntilTerminal({
    poll: async () => { throw transient({ status: 502, traceId: "t-1" }); },
    isTerminal: () => false,
    isRetryableError: () => true,
    intervalMs: 100,
    timeoutMs: 1_000,
    now: () => nowMs,
    sleep: async (milliseconds) => { nowMs += milliseconds; },
    provider: "platform",
  }), (error) => error.category === "timeout"
    && error.details.last_error.category === "transport"
    && error.details.last_error.status === 502
    && error.details.last_error.trace_id === "t-1");
  assert.ok(nowMs <= 1_000);

  // A Retry-After longer than the remaining budget stops instead of polling early.
  nowMs = 0;
  let polls = 0;
  await assert.rejects(pollUntilTerminal({
    poll: async () => { polls += 1; throw transient({ retryAfter: 5 }); },
    isTerminal: () => false,
    isRetryableError: () => true,
    intervalMs: 100,
    timeoutMs: 1_000,
    now: () => nowMs,
    sleep: async (milliseconds) => { nowMs += milliseconds; },
  }), (error) => error.category === "timeout");
  assert.equal(polls, 1);

  await assert.rejects(
    pollUntilTerminal({ poll: async () => ({}), isTerminal: () => true, isRetryableError: true }),
    /isRetryableError must be a function/i,
  );
});
