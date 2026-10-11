import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { serializeError } from "../../src/core/errors.js";
import { runPlatformCommand } from "../../src/platform/cli.js";
import { submitPlatformJob, resumePlatformJob } from "../../src/platform/jobs.js";
import { PLATFORM_OPERATIONS } from "../../src/platform/operations.js";
import { createTempJobRoot, readJobArtifacts } from "../helpers/temp-job-dir.js";

const TRACE = "11111111-1111-4111-8111-111111111111";
const SENSITIVE_FIELD = ["api", "key"].join("_");
const INPUT = Object.freeze({
  prompt: "safe product shot", model: "v6", duration: 5, quality: "720p", aspect_ratio: "16:9",
  [SENSITIVE_FIELD]: "never persist",
});
const AGENT_INPUT = Object.freeze({
  agent_id: "414562414124109",
  prompt: "Recreate pacing.",
  quality: "720p",
  img_references: Object.freeze([{ img_id: "1" }]),
  video_references: Object.freeze([{ video_media_id: "2" }]),
});
const MUSIC_MV_INPUT = Object.freeze({
  mv_agent_type: "vibe_mv_v3_custom",
  audio_media_id: "405833376854443",
  image_references: Object.freeze([Object.freeze({
    img_id: "164913710",
    ref_name: "Character Image",
  })]),
  mv_style: "Custom",
  aspect_ratio: "16:9",
  quality: "720p",
});

test("submit follows validate, durable request, one submit, ID, snapshots, final order", async (t) => {
  const root = await createTempJobRoot(t);
  const events = [];
  const client = {
    async execute(id, input, options) {
      events.push(id);
      if (id === "video.text") {
        const names = await fs.readdir(root, { recursive: true });
        assert.equal(names.some((name) => name.endsWith("request.json")), true);
        assert.equal(options.recovery, true);
        assert.equal(options.traceId, TRACE);
        return {
          operation: id, traceId: TRACE,
          envelope: { ErrCode: 0, Resp: { video_id: "627410861853514292" } },
          data: { video_id: "627410861853514292" },
        };
      }
      const status = events.filter((event) => event === "video.status").length === 1 ? 5 : 1;
      return { operation: id, traceId: `${TRACE}-status`, envelope: { ErrCode: 0, Resp: { id: "627410861853514292", status } }, data: { id: "627410861853514292", status } };
    },
  };

  const result = await submitPlatformJob(client, "video.text", INPUT, {
    jobRoot: root, traceIdFactory: () => TRACE, poll: true, sleep: async () => {}, now: () => 0,
    validate: async (_operation, input) => { events.push("validate"); return { payload: { ...input }, query: {}, pathParams: {}, files: {}, validationSummary: {} }; },
  });

  assert.deepEqual(events, ["validate", "video.text", "video.status", "video.status"]);
  assert.equal(result.id, "627410861853514292");
  assert.equal(result.status, "succeeded");
  const artifacts = await readJobArtifacts(result.job_dir);
  assert.equal(artifacts["request.json"].input.payload[SENSITIVE_FIELD], "[REDACTED]");
  assert.equal(artifacts["request.json"].trace_id, TRACE);
  assert.equal(artifacts["create-response.json"].Resp.video_id, "627410861853514292");
  assert.deepEqual(artifacts["video-id.json"], { video_id: "627410861853514292" });
  assert.deepEqual(artifacts["polling.jsonl"].map(({ status }) => status), ["processing", "succeeded"]);
  assert.equal(artifacts["final.json"].status, "succeeded");
  assert.equal(artifacts["final.json"].trace_id, TRACE);
  assert.equal(artifacts["final.json"].status_trace_id, `${TRACE}-status`);
  assert.equal(JSON.stringify(artifacts).includes("never persist"), false);
  assert.equal(Object.hasOwn(INPUT, "payload"), false);
});

test("ambiguous submit is attempted once and writes a safe recoverable error", async (t) => {
  const root = await createTempJobRoot(t);
  let posts = 0;
  const client = { execute: async () => { posts += 1; throw new TypeError("socket closed with token=secret-value"); } };
  await assert.rejects(submitPlatformJob(client, "agent.viral-recreation", AGENT_INPUT, {
    jobRoot: root, traceIdFactory: () => TRACE,
  }), /socket closed/);
  assert.equal(posts, 1);
  const [jobName] = await fs.readdir(root);
  const artifacts = await readJobArtifacts(path.join(root, jobName));
  assert.equal(artifacts["request.json"].trace_id, TRACE);
  assert.equal(artifacts["error.json"].category, "transport");
  assert.doesNotMatch(JSON.stringify(artifacts), /secret-value/);
});

test("Music MV uses the durable video job lifecycle and persists canonical input", async (t) => {
  const root = await createTempJobRoot(t);
  const calls = [];
  let statusReads = 0;
  const result = await submitPlatformJob({ execute: async (id, input) => {
    calls.push([id, input]);
    if (id === "agent.music-mv") {
      return {
        operation: id,
        traceId: TRACE,
        envelope: { ErrCode: 0, Resp: { video_id: "629000000000000023" } },
        data: { video_id: "629000000000000023" },
      };
    }
    statusReads += 1;
    const status = statusReads === 1 ? 5 : 1;
    return {
      operation: id,
      traceId: `${TRACE}-status`,
      envelope: { ErrCode: 0, Resp: { id: "629000000000000023", status } },
      data: { id: "629000000000000023", status },
    };
  } }, "agent.music-mv", MUSIC_MV_INPUT, {
    jobRoot: root,
    traceIdFactory: () => TRACE,
    poll: true,
    sleep: async () => {},
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(calls.map(([id]) => id), ["agent.music-mv", "video.status", "video.status"]);
  assert.equal(Object.hasOwn(calls[0][1].payload, "image_references"), false);
  assert.deepEqual(calls[0][1].payload.img_references, [
    { img_id: "164913710", ref_name: "Character Image" },
  ]);
  assert.deepEqual(calls[1][1], { video_id: "629000000000000023" });
  const artifacts = await readJobArtifacts(result.job_dir);
  assert.deepEqual(artifacts["video-id.json"], { video_id: "629000000000000023" });
  assert.equal(Object.hasOwn(artifacts["request.json"].input.payload, "image_references"), false);
  assert.deepEqual(artifacts["request.json"].input.payload.img_references, [
    { img_id: "164913710", ref_name: "Character Image" },
  ]);
  assert.deepEqual(artifacts["request.json"].headers, {
    "API-KEY": "[REDACTED]",
    "Ai-trace-id": TRACE,
  });
});

test("resume reads artifacts first, polls known IDs, and never submits a generation", async (t) => {
  const root = await createTempJobRoot(t);
  const submitted = await submitPlatformJob({
    execute: async (id) => ({ operation: id, traceId: TRACE, envelope: { ErrCode: 0, Resp: { video_id: "42" } }, data: { video_id: "42" } }),
  }, "video.text", INPUT, { jobRoot: root, traceIdFactory: () => TRACE, poll: false });
  const calls = [];
  const resumed = await resumePlatformJob({ execute: async (id, input) => {
    calls.push([id, input]);
    return { operation: id, traceId: "22222222-2222-4222-8222-222222222222", envelope: { ErrCode: 0, Resp: { id: "42", status: 1 } }, data: { id: "42", status: 1 } };
  } }, submitted.job_dir, { sleep: async () => {}, now: () => 0 });
  assert.deepEqual(calls, [["video.status", { video_id: "42" }]]);
  assert.equal(resumed.status, "succeeded");
  assert.equal(resumed.trace_id, TRACE);
  assert.equal(resumed.status_trace_id, "22222222-2222-4222-8222-222222222222");
});

test("resume without a saved ID performs no network request and returns reconciliation evidence", async (t) => {
  const root = await createTempJobRoot(t);
  await assert.rejects(submitPlatformJob({ execute: async () => { throw new TypeError("timeout"); } }, "agent.viral-recreation", AGENT_INPUT, {
    jobRoot: root, traceIdFactory: () => TRACE,
  }), /timeout/);
  const [jobName] = await fs.readdir(root);
  let calls = 0;
  const resumed = await resumePlatformJob({ execute: async () => { calls += 1; } }, path.join(root, jobName));
  assert.equal(calls, 0);
  assert.equal(resumed.status, "reconciliation_required");
  assert.equal(resumed.trace_id, TRACE);
});

test("a polling timeout exposes the durable job directory and accepted result ID", async (t) => {
  const root = await createTempJobRoot(t);
  const acceptedId = "627410861853514292";
  let jobDir;

  await assert.rejects(submitPlatformJob({ execute: async (id) => {
    if (id === "video.text") return {
      operation: id,
      traceId: TRACE,
      envelope: { ErrCode: 0, Resp: { video_id: acceptedId } },
      data: { video_id: acceptedId },
    };
    return {
      operation: id,
      traceId: `${TRACE}-status`,
      envelope: { ErrCode: 0, Resp: { id: acceptedId, status: 5 } },
      data: { id: acceptedId, status: 5 },
    };
  } }, "video.text", INPUT, {
    jobRoot: root,
    traceIdFactory: () => TRACE,
    poll: true,
    timeoutMs: 0,
    sleep: async () => {},
    now: () => 0,
  }), (error) => {
    const serialized = serializeError(error);
    jobDir = serialized.details?.job_dir;
    assert.equal(serialized.category, "timeout");
    assert.equal(serialized.details?.id, acceptedId);
    assert.match(jobDir, /video-text$/);
    return true;
  });

  assert.deepEqual(await fs.readFile(path.join(jobDir, "video-id.json"), "utf8")
    .then(JSON.parse), { video_id: acceptedId });
});

test("every billable catalog command delegates through the durable job layer", async (t) => {
  const root = await createTempJobRoot(t);
  const calls = [];
  for (const operation of PLATFORM_OPERATIONS.filter(({ billing }) => billing === "billable")) {
    const fixture = JSON.parse(await fs.readFile(path.join(
      process.cwd(), "test", "fixtures", "platform", operation.id, "request.json",
    ), "utf8"));
    const payloadPath = path.join(root, `${operation.id}.json`);
    await fs.writeFile(payloadPath, JSON.stringify(fixture.input));
    await runPlatformCommand([...operation.command, "--payload", payloadPath], {
      client: {}, cwd: root, jobRoot: root,
      submitPlatformJob: async (client, operationId, input, options) => {
        calls.push({ client, operationId, input, options });
        return { operation: operationId, status: "submitted" };
      },
    });
  }
  assert.deepEqual(calls.map(({ operationId }) => operationId),
    PLATFORM_OPERATIONS.filter(({ billing }) => billing === "billable").map(({ id }) => id));
  assert.equal(calls.every(({ options }) => options.poll === true && options.jobRoot === root), true);
});

test("Platform commands wait by default and expose explicit asynchronous execution", async (t) => {
  const root = await createTempJobRoot(t);
  const payloadPath = path.join(root, "payload.json");
  await fs.writeFile(payloadPath, JSON.stringify({
    prompt: "safe product shot", model: "v6", duration: 5,
    quality: "720p", aspect_ratio: "16:9",
  }));
  const calls = [];
  const context = {
    client: {}, cwd: root, jobRoot: root,
    submitPlatformJob: async (...args) => {
      calls.push(args);
      return { status: args[3].poll ? "succeeded" : "submitted" };
    },
  };

  await runPlatformCommand(["video", "text", "--payload", payloadPath], context);
  await runPlatformCommand(["video", "text", "--payload", payloadPath, "--no-wait"], context);
  await runPlatformCommand([
    "run-job", "--operation", "video.text", "--payload", payloadPath,
    "--interval-ms", "25", "--timeout-ms", "500",
  ], context);
  await runPlatformCommand([
    "run-job", "--operation", "video.text", "--payload", payloadPath, "--poll",
  ], context);

  assert.deepEqual(calls.map(([, , , options]) => options.poll), [true, false, true, true]);
  assert.equal(calls[2][3].intervalMs, 25);
  assert.equal(calls[2][3].timeoutMs, 500);
});

test("run-job opts into polling and resume delegates without a new generation", async (t) => {
  const root = await createTempJobRoot(t);
  const payloadPath = path.join(root, "payload.json");
  await fs.writeFile(payloadPath, JSON.stringify({
    prompt: "safe product shot", model: "v6", duration: 5, quality: "720p", aspect_ratio: "16:9",
  }));
  const calls = [];
  const context = {
    client: {}, cwd: root, jobRoot: root,
    submitPlatformJob: async (...args) => { calls.push(["submit", ...args]); return { status: "submitted" }; },
    resumePlatformJob: async (...args) => { calls.push(["resume", ...args]); return { status: "succeeded" }; },
  };
  await runPlatformCommand(["run-job", "--operation", "video.text", "--payload", payloadPath, "--poll"], context);
  await runPlatformCommand(["resume", path.join(root, "known-job")], context);
  assert.equal(calls[0][0], "submit");
  assert.equal(calls[0][2], "video.text");
  assert.equal(calls[0][4].poll, true);
  assert.equal(calls[1][0], "resume");
  assert.equal(calls[1][2], path.join(root, "known-job"));
});

test("synchronous billable work is finalized and completed resumes are network-free", async (t) => {
  const root = await createTempJobRoot(t);
  const client = { execute: async (id) => ({
    operation: id, traceId: TRACE,
    envelope: { ErrCode: 0, Resp: { keyframe_id: "mask-7", mask_info: [] } },
    data: { keyframe_id: "mask-7", mask_info: [] },
  }) };
  const result = await submitPlatformJob(client, "video.swap-mask", {}, {
    jobRoot: root, traceIdFactory: () => TRACE,
    validate: async () => ({ payload: {}, query: {}, pathParams: {}, files: {}, validationSummary: {} }),
  });
  let calls = 0;
  const resumed = await resumePlatformJob({ execute: async () => { calls += 1; } }, result.job_dir);
  assert.equal(result.status, "succeeded");
  assert.equal(resumed.status, "succeeded");
  assert.equal(calls, 0);
});

test("polling requires the documented result ID and rejects non-billable operations", async (t) => {
  const root = await createTempJobRoot(t);
  await assert.rejects(submitPlatformJob({}, "account.balance", {}, { jobRoot: root }),
    (error) => error.code === "INVALID_PLATFORM_JOB_OPERATION");
  await assert.rejects(submitPlatformJob({ execute: async (id) => ({
    operation: id, traceId: TRACE, envelope: { ErrCode: 0, Resp: {} }, data: {},
  }) }, "video.text", {}, {
    jobRoot: root, traceIdFactory: () => TRACE, poll: true,
    validate: async () => ({ payload: {}, query: {}, pathParams: {}, files: {}, validationSummary: {} }),
  }), (error) => error.code === "MISSING_PLATFORM_JOB_ID");
});

test("image jobs persist string image IDs and poll the image status operation", async (t) => {
  const root = await createTempJobRoot(t);
  const calls = [];
  const result = await submitPlatformJob({ execute: async (id, input) => {
    calls.push([id, input]);
    return id === "image.template"
      ? { operation: id, traceId: TRACE, envelope: { ErrCode: 0, Resp: { image_id: 27 } }, data: { image_id: 27 } }
      : { operation: id, traceId: "status", envelope: { ErrCode: 0, Resp: { image_id: "27", status: 1 } }, data: { image_id: "27", status: 1 } };
  } }, "image.template", {}, {
    jobRoot: root, traceIdFactory: () => TRACE, poll: true,
    validate: async () => ({ payload: {}, query: {}, pathParams: {}, files: {}, validationSummary: {} }),
  });
  assert.deepEqual(calls.map(([id]) => id), ["image.template", "image.status"]);
  assert.deepEqual(calls[1][1], { image_id: "27" });
  assert.deepEqual((await readJobArtifacts(result.job_dir))["image-id.json"], { image_id: "27" });
});

test("job command boundary rejects unsafe or incomplete recovery controls", async (t) => {
  const root = await createTempJobRoot(t);
  let submissions = 0;
  const context = {
    client: {}, cwd: root,
    submitPlatformJob: async () => { submissions += 1; return {}; },
  };
  const invalid = [
    ["run-job"],
    ["run-job", "--operation", "account.balance", "--payload", "x.json"],
    ["run-job", "--operation", "video.text"],
    ["run-job", "--operation", "video.text", "--trace-id", TRACE],
    ["run-job", "--operation", "video.text", "--unknown"],
    ["run-job", "--operation", "video.text", "--interval-ms", "0"],
    ["run-job", "--operation", "video.text", "--timeout-ms", "-1"],
    ["run-job", "--operation", "video.text", "--payload", "x.json", "--poll", "--no-wait"],
    ["video", "text", "--payload", "x.json", "--poll", "--no-wait"],
    ["account", "balance", "--no-wait"],
    ["video", "status", "42", "--poll"],
    ["resume"],
    ["resume", "one", "two"],
    ["resume", "one", "--unknown"],
  ];
  for (const argv of invalid) await assert.rejects(runPlatformCommand(argv, context),
    (error) => error.provider === "platform" && error.category === "validation");
  assert.equal(submissions, 0);
});

test("polling respects a successful response Retry-After hint", async (t) => {
  const root = await createTempJobRoot(t);
  const delays = [];
  let reads = 0;
  await submitPlatformJob({ execute: async (id) => {
    if (id === "video.text") return {
      operation: id, traceId: TRACE, envelope: { ErrCode: 0, Resp: { video_id: "9" } }, data: { video_id: "9" },
    };
    reads += 1;
    const status = reads === 1 ? 5 : 1;
    return {
      operation: id, traceId: "status", retryAfter: reads === 1 ? 2 : undefined,
      envelope: { ErrCode: 0, Resp: { id: "9", status } }, data: { id: "9", status },
    };
  } }, "video.text", INPUT, {
    jobRoot: root, traceIdFactory: () => TRACE, poll: true, intervalMs: 100,
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  assert.deepEqual(delays, [2_000]);
});

function transientStatusClient(outcomes, counters) {
  return {
    execute: async (id) => {
      if (id === "video.text") {
        counters.submits += 1;
        return { operation: id, traceId: TRACE, envelope: { ErrCode: 0, Resp: { video_id: "9" } }, data: { video_id: "9" } };
      }
      counters.reads += 1;
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return {
        operation: id, traceId: `status-${counters.reads}`,
        envelope: { ErrCode: 0, Resp: { id: "9", status: next } }, data: { id: "9", status: next },
      };
    },
  };
}

test("status polling survives transient read errors and keeps a single billable submit", async (t) => {
  const { PixverseCliError } = await import("../../src/core/errors.js");
  const root = await createTempJobRoot(t);
  const counters = { submits: 0, reads: 0 };
  const delays = [];
  let clock = 0;
  const final = await submitPlatformJob(transientStatusClient([
    5,
    new PixverseCliError("socket closed", { category: "transport", provider: "platform", traceId: "t-a" }),
    new PixverseCliError("busy", { category: "http", status: 503, retryAfter: 7 }),
    new PixverseCliError("high load", { category: "provider", status: 200, code: 500069, retryable: true }),
    1,
  ], counters), "video.text", INPUT, {
    jobRoot: root, traceIdFactory: () => TRACE, poll: true,
    now: () => clock,
    sleep: async (milliseconds) => { delays.push(milliseconds); clock += milliseconds; },
  });
  assert.equal(final.status, "succeeded");
  assert.equal(counters.submits, 1);
  assert.equal(counters.reads, 5);
  // Default 5s cadence; then error backoff 5s, max(10s backoff, 7s Retry-After), 20s.
  assert.deepEqual(delays, [5_000, 5_000, 10_000, 20_000]);
  const artifacts = await readJobArtifacts(final.job_dir);
  const errors = artifacts["polling.jsonl"].filter((entry) => entry.status === "poll_error");
  assert.deepEqual(errors.map((entry) => entry.error.category), ["transport", "http", "provider"]);
  assert.equal(errors[2].error.code, 500069);
  assert.equal(artifacts["polling.jsonl"].at(-1).status, "succeeded");
  assert.equal(artifacts["error.json"], undefined);
});

test("status polling fails immediately on a non-retryable read error", async (t) => {
  const { PixverseCliError } = await import("../../src/core/errors.js");
  const root = await createTempJobRoot(t);
  const counters = { submits: 0, reads: 0 };
  await assert.rejects(submitPlatformJob(transientStatusClient([
    5,
    new PixverseCliError("invalid id", { category: "provider", status: 200, code: 400017, retryable: false }),
    1,
  ], counters), "video.text", INPUT, {
    jobRoot: root, traceIdFactory: () => TRACE, poll: true, sleep: async () => {}, now: () => 0,
  }), (error) => error.code === 400017);
  assert.equal(counters.submits, 1);
  assert.equal(counters.reads, 2);
});

test("status polling stops retrying transient errors once the caller aborts", async (t) => {
  const { PixverseCliError } = await import("../../src/core/errors.js");
  const root = await createTempJobRoot(t);
  const counters = { submits: 0, reads: 0 };
  const controller = new AbortController();
  const client = transientStatusClient([], counters);
  const execute = client.execute;
  client.execute = async (id, input, options) => {
    if (id !== "video.text") {
      controller.abort();
      throw new PixverseCliError("socket closed", { category: "transport" });
    }
    return execute(id, input, options);
  };
  await assert.rejects(submitPlatformJob(client, "video.text", INPUT, {
    jobRoot: root, traceIdFactory: () => TRACE, poll: true, signal: controller.signal,
    sleep: async () => {}, now: () => 0,
  }), (error) => error.category === "transport");
});

test("default polling uses a 5s cadence and a resumable 30 minute timeout", async (t) => {
  const root = await createTempJobRoot(t);
  const counters = { submits: 0, reads: 0 };
  const delays = [];
  let clock = 0;
  const outcomes = new Array(1_000).fill(5);
  await assert.rejects(submitPlatformJob(transientStatusClient(outcomes, counters), "video.text", INPUT, {
    jobRoot: root, traceIdFactory: () => TRACE, poll: true,
    now: () => clock,
    sleep: async (milliseconds) => { delays.push(milliseconds); clock += milliseconds; },
  }), (error) => error.category === "timeout" && error.details.timeout_ms === 30 * 60 * 1_000
    && error.details.id === "9");
  assert.ok(delays.every((delay) => delay === 5_000));
  assert.equal(clock, 30 * 60 * 1_000);
  assert.equal(counters.submits, 1);
});
