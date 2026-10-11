import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PlatformClient } from "../../src/platform/client.js";
import { resumePlatformJob, submitPlatformJob } from "../../src/platform/jobs.js";
import { createMockApiServer, sendJson } from "../helpers/mock-api-server.js";
import { createTempJobRoot, readJobArtifacts } from "../helpers/temp-job-dir.js";

test("ambiguous agent acceptance is resumable without a second billable POST", async (t) => {
  const root = await createTempJobRoot(t);
  let accepted = 0;
  const server = await createMockApiServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/openapi/v2/video/agent/generate");
    accepted += 1;
    response.destroy();
  });
  t.after(() => server.close());
  const client = new PlatformClient({ apiKey: "test-key", baseUrl: server.baseUrl, fetchImpl: globalThis.fetch });
  await assert.rejects(submitPlatformJob(client, "agent.viral-recreation", {
    agent_id: "414562414124109",
    prompt: "Recreate pacing.",
    quality: "720p",
    img_references: [{ img_id: "1" }],
    video_references: [{ video_media_id: "2" }],
  }, { jobRoot: root, traceIdFactory: () => "11111111-1111-4111-8111-111111111111" }),
  (error) => error.category === "transport");
  const [jobName] = await fs.readdir(root);
  const result = await resumePlatformJob(client, path.join(root, jobName));
  assert.equal(accepted, 1);
  assert.equal(server.requests.length, 1);
  assert.equal(result.status, "reconciliation_required");
});

test("ambiguous Music MV acceptance stops for reconciliation without a second POST", async (t) => {
  const root = await createTempJobRoot(t);
  let accepted = 0;
  const server = await createMockApiServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/openapi/v2/video/music_mv_agent/generate");
    accepted += 1;
    response.destroy();
  });
  t.after(() => server.close());
  const client = new PlatformClient({ apiKey: "test-key", baseUrl: server.baseUrl, fetchImpl: globalThis.fetch });
  await assert.rejects(submitPlatformJob(client, "agent.music-mv", {
    mv_agent_type: "vibe_mv_v3_custom",
    audio_media_id: "405833376854443",
    aspect_ratio: "16:9",
    quality: "720p",
  }, { jobRoot: root, traceIdFactory: () => "11111111-1111-4111-8111-111111111111" }),
  (error) => error.category === "transport");
  const [jobName] = await fs.readdir(root);
  const result = await resumePlatformJob(client, path.join(root, jobName));
  assert.equal(accepted, 1);
  assert.equal(server.requests.length, 1);
  assert.equal(result.status, "reconciliation_required");
});

test("unknown status is preserved until timeout with final and error artifacts", async (t) => {
  const root = await createTempJobRoot(t);
  let clock = 0;
  const client = { execute: async (id) => id === "video.text"
    ? { operation: id, traceId: "11111111-1111-4111-8111-111111111111", envelope: { ErrCode: 0, Resp: { video_id: "9" } }, data: { video_id: "9" } }
    : { operation: id, traceId: "status", envelope: { ErrCode: 0, Resp: { id: "9", status: 777 } }, data: { id: "9", status: 777 } } };
  await assert.rejects(submitPlatformJob(client, "video.text", { prompt: "x", model: "v6", duration: 5, quality: "720p", aspect_ratio: "16:9" }, {
    jobRoot: root, poll: true, intervalMs: 5, timeoutMs: 5, now: () => clock, sleep: async (ms) => { clock += ms; },
  }), (error) => error.category === "timeout");
  const [jobName] = await fs.readdir(root);
  const artifacts = await readJobArtifacts(path.join(root, jobName));
  assert.equal(artifacts["polling.jsonl"].at(-1).status, "unknown");
  assert.equal(artifacts["polling.jsonl"].at(-1).raw_status, 777);
  assert.equal(artifacts["final.json"].status, "unknown");
  assert.equal(artifacts["final.json"].trace_id, artifacts["request.json"].trace_id);
  assert.equal(artifacts["final.json"].status_trace_id, "status");
  assert.equal(artifacts["error.json"].category, "timeout");

  const calls = [];
  const resumed = await resumePlatformJob({ execute: async (id, input) => {
    calls.push([id, input]);
    return {
      operation: id, traceId: "resume-status",
      envelope: { ErrCode: 0, Resp: { id: "9", status: 1 } },
      data: { id: "9", status: 1 },
    };
  } }, path.join(root, jobName), { sleep: async () => {} });
  assert.deepEqual(calls, [["video.status", { video_id: "9" }]]);
  assert.equal(resumed.status, "succeeded");
  const recoveredArtifacts = await readJobArtifacts(path.join(root, jobName));
  assert.equal(recoveredArtifacts["final-timeout-1.json"].status, "unknown");
  assert.equal(recoveredArtifacts["final.json"].status, "succeeded");
});

test("over real HTTP, transient status failures keep polling with fresh traces and one billable POST", async (t) => {
  const root = await createTempJobRoot(t);
  const savedTrace = "11111111-1111-4111-8111-111111111111";
  let statusReads = 0;
  const server = await createMockApiServer((request, response) => {
    if (request.method === "POST") {
      sendJson(response, { ErrCode: 0, ErrMsg: "success", Resp: { video_id: 627410861853514292 } });
      return;
    }
    statusReads += 1;
    // Each status call exhausts the client's 3 in-call GET retries first.
    if (statusReads <= 3) {
      sendJson(response, { error: { message: "busy" } }, 503);
      return;
    }
    if (statusReads === 4) {
      sendJson(response, { ErrCode: 500069, ErrMsg: "System is currently experiencing high load.", Resp: null });
      return;
    }
    sendJson(response, { ErrCode: 0, ErrMsg: "success", Resp: { id: 627410861853514292, status: 1, url: "https://cdn.example.test/v.mp4" } });
  });
  t.after(() => server.close());
  const client = new PlatformClient({
    apiKey: "test-key", baseUrl: server.baseUrl, fetchImpl: globalThis.fetch, sleep: async () => {},
  });
  const final = await submitPlatformJob(client, "video.text", {
    prompt: "x", model: "v6", duration: 5, quality: "720p", aspect_ratio: "16:9",
  }, { jobRoot: root, traceIdFactory: () => savedTrace, poll: true, sleep: async () => {} });

  assert.equal(final.status, "succeeded");
  const posts = server.requests.filter(({ method }) => method === "POST");
  const reads = server.requests.filter(({ method }) => method === "GET");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers["ai-trace-id"], savedTrace);
  assert.equal(reads.length, 5);
  const readTraces = reads.map(({ headers }) => headers["ai-trace-id"]);
  assert.equal(new Set(readTraces).size, readTraces.length);
  assert.equal(readTraces.includes(savedTrace), false);
  assert.equal(final.trace_id, savedTrace);
  assert.equal(final.status_trace_id, readTraces.at(-1));
  const artifacts = await readJobArtifacts(final.job_dir);
  assert.deepEqual(
    artifacts["polling.jsonl"].filter(({ status }) => status === "poll_error").map(({ error }) => error.code ?? error.status),
    [503, 500069],
  );
});
