import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../../src/cli.js";
import { runGrowthStudioCommand } from "../../src/growth-studio/cli.js";
import { createRecordingFetch, describeRecordedBody, jsonResponse } from "../helpers/recording-fetch.js";

const ENV = Object.freeze({
  PIXVERSE_GROWTH_API_KEY: "mh_live_fixture",
  PIXVERSE_GROWTH_BASE_URL: "http://127.0.0.1:1",
});

function payload() {
  return {
    source_video_id: "643056093269852241",
    model: "plus",
    script_language: "en-US",
    listing: {
      title: "Example Travel Mug",
      image_info: { items: [{ url: "https://media.pixverse.ai/example/mug.webp", sort: 0 }] },
    },
    video: { aspect_ratio: "9:16", resolution: "480p", language: "en-US" },
    avatar: { mode: "disabled" },
  };
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-vc-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "vc.json"), JSON.stringify(payload()));
  return root;
}

function captureOutput() {
  let stdout = "";
  let stderr = "";
  return {
    context: {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

test("viral-clone create --dry-run makes no network call and creates no job", async (t) => {
  const root = await tempRoot(t);
  const output = captureOutput();
  const exitCode = await main(["growth-studio", "viral-clone", "create", "--payload", "vc.json", "--dry-run"], {
    cwd: root,
    env: {},
    fetchImpl: async () => { throw new Error("dry run must not use the network"); },
    ...output.context,
  });
  assert.equal(exitCode, 0, output.stderr());
  const result = JSON.parse(output.stdout());
  assert.equal(result.capability, "viral-clone");
  assert.equal(result.billable, false);
  assert.equal(result.path, "/openapi/v1/viral-clone/runs");
  assert.deepEqual(result.body, payload());
  assert.deepEqual(await fs.readdir(root), ["vc.json"]);
});

test("viral-clone create requires exactly one of --dry-run or --confirm-billable", async (t) => {
  const root = await tempRoot(t);
  const context = {
    cwd: root,
    env: {},
    get client() { throw new Error("client must not load"); },
  };
  const cases = [
    [["viral-clone", "create", "--payload", "vc.json"], /requires --confirm-billable/],
    [["viral-clone", "create", "--payload", "vc.json", "--dry-run", "--confirm-billable"], /either --dry-run or --confirm-billable/],
    [["viral-clone", "create", "--payload", "vc.json", "--dry-run", "--no-poll"], /does not accept job or polling options/],
    [["viral-clone", "create", "--dry-run"], /requires --payload/],
    [["viral-clone", "create", "--payload", "a", "--payload", "b"], /Duplicate viral-clone option: --payload/],
    [["viral-clone", "create", "--payload", "vc.json", "--bogus"], /Unknown viral-clone create option: --bogus/],
    [["viral-clone", "get", "abc"], /run_id must be a decimal string/],
    [["viral-clone", "get"], /exactly one run_id/],
    [["viral-clone", "poll", "x1", "--initial-delay-seconds", "0"], /run_id must be a decimal string/],
    [["viral-clone", "poll", "1", "--timeout-minutes", "1", "--timeout-minutes", "2"], /Duplicate viral-clone option/],
    [["viral-clone", "resume"], /viral-clone resume requires exactly one job directory/],
    [["video", "list", "--kind", "product"], /--kind accepts only: uploaded/],
    [["video", "import-url"], /exactly one URL/],
    [["video", "import-url", "https://a.test/a.mp4", "extra"], /exactly one URL/],
    [["wallet", "discount", "--x"], /does not accept arguments/],
    [["models", "list", "--x"], /does not accept arguments/],
    [["images", "list", "--limit", "101"], /--limit must be a safe integer from 1 through 100/],
    [["images", "list", "--offset", "-1"], /--offset/],
    [["images", "list", "--limit", "1", "--limit", "2"], /Duplicate images list option: --limit/],
  ];
  for (const [args, message] of cases) {
    await assert.rejects(runGrowthStudioCommand(args, context), message, args.join(" "));
  }
});

test("viral-clone create --confirm-billable posts exactly once and writes durable artifacts", async (t) => {
  const root = await tempRoot(t);
  const output = captureOutput();
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({ run_id: "25388", status: "processing", request_id: "vc-create" }, {
      status: 202,
      headers: { location: "/openapi/v1/viral-clone/runs/25388" },
    }),
    jsonResponse({ run_id: "25388", status: "processing", request_id: "p1" }),
    jsonResponse({
      run_id: "25388",
      status: "succeeded",
      output: { video_url: "https://media.pixverse.ai/o.mp4", thumbnail_url: "https://media.pixverse.ai/o.jpg", mime_type: "video/mp4" },
      request_id: "p2",
    }),
  ]);
  const exitCode = await main([
    "growth-studio", "viral-clone", "create", "--payload", "vc.json", "--confirm-billable",
    "--jobs-dir", "jobs", "--initial-delay-seconds", "0", "--fallback-delay-seconds", "0",
  ], { cwd: root, env: ENV, fetchImpl, sleep: async () => {}, ...output.context });

  assert.equal(exitCode, 0, output.stderr());
  const result = JSON.parse(output.stdout());
  assert.equal(result.run_id, "25388");
  assert.equal(result.status, "succeeded");
  assert.equal(result.video_url, "https://media.pixverse.ai/o.mp4");
  assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/openapi/v1/viral-clone/runs");
  assert.equal(calls[0].headers.get("Authorization"), "Bearer mh_live_fixture");
  assert.match(calls[0].headers.get("Ai-Trace-Id"), /^viral-clone-job-.*-create$/);
  assert.deepEqual(JSON.parse(JSON.stringify(await describeRecordedBody(calls[0].body))), payload());
  assert.deepEqual(calls.slice(1).map(({ method, url }) => `${method} ${new URL(url).pathname}`), [
    "GET /openapi/v1/viral-clone/runs/25388",
    "GET /openapi/v1/viral-clone/runs/25388",
  ]);
  const entries = (await fs.readdir(result.job_dir)).sort();
  assert.deepEqual(entries, ["create-response.json", "final.json", "polling.jsonl", "request.json", "run-id.json"]);
});

test("viral-clone create does not retry a failed submission", async (t) => {
  const root = await tempRoot(t);
  const output = captureOutput();
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({ request_id: "r", error: { code: "TEMPORARILY_UNAVAILABLE", message: "x", retryable: true } }, { status: 503 }),
    jsonResponse({ run_id: "1" }),
  ]);
  const exitCode = await main([
    "growth-studio", "viral-clone", "create", "--payload", "vc.json", "--confirm-billable", "--jobs-dir", "jobs",
  ], { cwd: root, env: ENV, fetchImpl, sleep: async () => {}, ...output.context });
  assert.notEqual(exitCode, 0);
  assert.equal(calls.length, 1);
  const [jobName] = await fs.readdir(path.join(root, "jobs"));
  const error = JSON.parse(await fs.readFile(path.join(root, "jobs", jobName, "error.json"), "utf8"));
  assert.equal(error.code, "TEMPORARILY_UNAVAILABLE");
});

test("viral-clone resume polls only and never posts", async (t) => {
  const root = await tempRoot(t);
  const jobDir = path.join(root, "job");
  await fs.mkdir(jobDir);
  await fs.writeFile(path.join(jobDir, "request.json"), JSON.stringify({ workflow: "viral-clone", trace_id: "vc" }));
  await fs.writeFile(path.join(jobDir, "run-id.json"), JSON.stringify({ run_id: "25388" }));
  const output = captureOutput();
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({ run_id: "25388", status: "succeeded", output: { video_url: "https://media.pixverse.ai/o.mp4" }, request_id: "p" }),
  ]);
  const exitCode = await main(["growth-studio", "viral-clone", "resume", "job"], {
    cwd: root, env: ENV, fetchImpl, sleep: async () => {}, ...output.context,
  });
  assert.equal(exitCode, 0, output.stderr());
  assert.equal(JSON.parse(output.stdout()).status, "succeeded");
  assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
  assert.equal(calls[0].headers.get("Ai-Trace-Id"), "vc-poll");

  // Without a saved run_id resume stops at reconciliation and makes no request.
  await fs.rm(path.join(jobDir, "run-id.json"));
  await fs.rm(path.join(jobDir, "final.json"));
  const second = captureOutput();
  const none = createRecordingFetch();
  const code = await main(["growth-studio", "viral-clone", "resume", "job"], {
    cwd: root, env: ENV, fetchImpl: none.fetchImpl, ...second.context,
  });
  assert.equal(code, 0, second.stderr());
  assert.equal(JSON.parse(second.stdout()).status, "reconciliation_required");
  assert.equal(none.calls.length, 0);
});

test("viral-clone get and poll read the run resource", async () => {
  const output = captureOutput();
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({ run_id: "25388", status: "processing", request_id: "g" }),
  ]);
  const exitCode = await main(["growth-studio", "viral-clone", "get", "25388"], { env: ENV, fetchImpl, ...output.context });
  assert.equal(exitCode, 0, output.stderr());
  assert.equal(JSON.parse(output.stdout()).run_id, "25388");
  assert.equal(calls[0].method, "GET");
  assert.equal(new URL(calls[0].url).pathname, "/openapi/v1/viral-clone/runs/25388");

  const pollOutput = captureOutput();
  const poll = createRecordingFetch([jsonResponse({ run_id: "25388", status: "failed", error: { code: "E", message: "m" } })]);
  const pollCode = await main(["growth-studio", "viral-clone", "poll", "25388", "--initial-delay-seconds", "0"], {
    env: ENV, fetchImpl: poll.fetchImpl, sleep: async () => {}, ...pollOutput.context,
  });
  assert.equal(pollCode, 0, pollOutput.stderr());
  assert.equal(JSON.parse(pollOutput.stdout()).status, "failed");
});

test("video import-url posts once and prints the imported asset", async () => {
  const output = captureOutput();
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse('{"video_id":643056093269852241,"url":"https://media.pixverse.ai/u.mp4","duration":5.04,"width":720,"height":1280,"file_size":1234,"request_id":"i"}'),
  ]);
  const exitCode = await main(["growth-studio", "video", "import-url", "https://cdn.example.test/ref.mp4"], {
    env: ENV, fetchImpl, ...output.context,
  });
  assert.equal(exitCode, 0, output.stderr());
  const result = JSON.parse(output.stdout());
  assert.equal(result.video_id, "643056093269852241");
  assert.equal(result.duration, 5.04);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(new URL(calls[0].url).pathname, "/openapi/v1/video/upload");
  assert.equal(calls[0].body, '{"url":"https://cdn.example.test/ref.mp4"}');
});

test("read commands: video list --kind, wallet discount, models list, images list", async () => {
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({ videos: [{ video_id: "1", kind: "uploaded" }] }),
    jsonResponse({ discount: "70", source: "workspace", expires_at: null }),
    jsonResponse({ catalog_version: "2026-10-23-voiceover-v1", video_models: [], image_models: [] }),
    jsonResponse({ data: [{ image_id: "22887" }], pagination: { offset: 5, limit: 2, total: 9 } }),
  ]);
  const results = [];
  for (const args of [
    ["growth-studio", "video", "list", "--kind", "uploaded"],
    ["growth-studio", "wallet", "discount"],
    ["growth-studio", "models", "list"],
    ["growth-studio", "images", "list", "--offset", "5", "--limit", "2"],
  ]) {
    const output = captureOutput();
    assert.equal(await main(args, { env: ENV, fetchImpl, ...output.context }), 0, output.stderr());
    results.push(JSON.parse(output.stdout()));
  }
  assert.equal(results[1].discount, "70");
  assert.equal(results[2].catalog_version, "2026-10-23-voiceover-v1");
  assert.equal(results[3].data[0].image_id, "22887");
  assert.deepEqual(calls.map(({ method, url }) => `${method} ${new URL(url).pathname}${new URL(url).search}`), [
    "GET /openapi/v1/videos?kind=uploaded",
    "GET /openapi/v1/wallet/discount",
    "GET /openapi/v1/models",
    "GET /openapi/v1/images?offset=5&limit=2",
  ]);
  for (const call of calls) {
    assert.equal(call.headers.get("Authorization"), "Bearer mh_live_fixture");
    assert.ok(call.headers.get("Ai-Trace-Id"));
  }
});
