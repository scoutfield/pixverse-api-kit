import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resumeGrowthStudioJob,
  resumeViralCloneJob,
  runViralCloneJob,
} from "../../src/growth-studio/jobs.js";
import {
  MAX_VIRAL_CLONE_BODY_BYTES,
  describeViralCloneDryRun,
  normalizeViralClonePayload,
  readRunIdentifier,
  runIdFromLocation,
  validateViralClonePayload,
  validateVideoImportUrl,
} from "../../src/growth-studio/viral-clone.js";
import { validateListVideosOptions } from "../../src/growth-studio/validation.js";

function validPayload() {
  return {
    source_video_id: "627410861853514292",
    model: "plus",
    script_language: "en-US",
    listing: {
      title: "Example Travel Mug",
      image_info: { items: [{ url: "https://media.pixverse.ai/example/mug.webp", sort: 0 }] },
    },
    video: { aspect_ratio: "9:16", resolution: "720p", language: "en-US" },
  };
}

function withChange(mutate) {
  const payload = validPayload();
  mutate(payload);
  return payload;
}

test("Viral Clone accepts the documented payload and normalizes without mutation", () => {
  const payload = validPayload();
  const snapshot = structuredClone(payload);
  assert.deepEqual(normalizeViralClonePayload(payload), snapshot);
  assert.deepEqual(payload, snapshot);

  const full = withChange((p) => {
    p.model = "standard";
    p.video = { aspect_ratio: "21:9", resolution: "1440p", language: "ja-JP", bgm_mode: "independent" };
    p.listing.description = "d";
    p.listing.brand = "b";
    p.listing.image_info.items.push({ url: "http://images.example.test/2.png" });
    p.avatar = { mode: "custom", avatar_id: "123" };
  });
  validateViralClonePayload(full);
  validateViralClonePayload(withChange((p) => { p.avatar = { mode: "custom", url: "https://media.pixverse.ai/a.png" }; }));
  validateViralClonePayload(withChange((p) => { p.avatar = { mode: "disabled" }; }));
  validateViralClonePayload(withChange((p) => { p.listing = { listing_id: "8812" }; }));
  validateViralClonePayload(withChange((p) => { p.model = "pro"; p.video = { aspect_ratio: "1:1", resolution: "1080p", language: "en-US" }; }));

  const dryRun = describeViralCloneDryRun(payload);
  assert.equal(dryRun.capability, "viral-clone");
  assert.equal(dryRun.billable, false);
  assert.equal(dryRun.method, "POST");
  assert.equal(dryRun.path, "/openapi/v1/viral-clone/runs");
});

test("Viral Clone rejects invalid payloads before any request", () => {
  const cases = [
    [(p) => { p.source_video_id = 627410861853514292; }, /source_video_id must be a decimal string/],
    [(p) => { p.source_video_id = "abc"; }, /source_video_id must be a decimal string/],
    [(p) => { delete p.source_video_id; }, /source_video_id/],
    [(p) => { p.model = "Plus"; }, /model must be one of: standard, plus, pro/],
    [(p) => { delete p.model; }, /model must be one of/],
    [(p) => { delete p.script_language; }, /script_language must be a BCP 47/],
    [(p) => { p.script_language = "english"; }, /script_language must be a BCP 47/],
    [(p) => { delete p.listing; }, /listing must be a plain object/],
    [(p) => { delete p.listing.title; }, /listing.title is required/],
    [(p) => { p.listing.title = "x".repeat(256); }, /at most 255/],
    [(p) => { p.listing.description = "x".repeat(5121); }, /listing.description/],
    [(p) => { p.listing.brand = "x".repeat(256); }, /listing.brand/],
    [(p) => { delete p.listing.image_info; }, /image_info.items is required/],
    [(p) => { p.listing.image_info.items = []; }, /1 to 10 images/],
    [(p) => { p.listing.image_info.items = Array.from({ length: 11 }, () => ({ url: "https://a.test/i.png" })); }, /1 to 10 images/],
    [(p) => { p.listing.image_info.items[0].url = "ftp://a.test/i.png"; }, /HTTP or HTTPS URL/],
    [(p) => { delete p.listing.image_info.items[0].url; }, /url must be a non-empty/],
    [(p) => { p.listing.image_info.items[0].sort = 1.5; }, /sort must be an integer/],
    [(p) => { p.listing.image_info.items[0].alt = "x"; }, /Unknown listing.image_info.items\[0\] field: alt/],
    [(p) => { p.listing.source_url = "https://shop.test"; }, /Unknown listing field: source_url/],
    [(p) => { delete p.video; }, /video must be a plain object/],
    [(p) => { delete p.video.language; }, /video.language must be a BCP 47/],
    [(p) => { p.video.aspect_ratio = "2:1"; }, /video.aspect_ratio is required and must be one of/],
    [(p) => { delete p.video.aspect_ratio; }, /video.aspect_ratio is required/],
    [(p) => { delete p.video.resolution; }, /video.resolution is required/],
    [(p) => { p.video.resolution = "1440p"; }, /for model plus use one of: 480p, 720p, 1080p/],
    [(p) => { p.model = "standard"; }, /for model standard use one of: 768p, 1440p/],
    [(p) => { p.video.resolution = "720P"; }, /lowercase/],
    [(p) => { p.video.bgm_mode = "auto"; }, /bgm_mode must be one of/],
    [(p) => { p.video.duration_seconds = 30; }, /server-managed/],
    [(p) => { p.video.voiceover = true; }, /server-managed/],
    [(p) => { p.video.captions = true; }, /server-managed/],
    [(p) => { p.avatar = { mode: "auto" }; }, /avatar.mode must be one of: custom, disabled/],
    [(p) => { p.avatar = { mode: "custom" }; }, /exactly one of avatar.url or avatar.avatar_id/],
    [(p) => { p.avatar = { mode: "custom", url: "https://a.test/a.png", avatar_id: "1" }; }, /exactly one/],
    [(p) => { p.avatar = { mode: "disabled", avatar_id: "1" }; }, /must be omitted when avatar.mode is disabled/],
    [(p) => { p.avatar = { mode: "disabled", url: "https://a.test/a.png" }; }, /must be omitted/],
    [(p) => { p.folder_id = "1"; }, /Unknown Viral Clone field: folder_id/],
  ];
  for (const [mutate, message] of cases) {
    assert.throws(() => normalizeViralClonePayload(withChange(mutate)), message, String(mutate));
  }
  assert.throws(() => validateViralClonePayload([]), /plain object/);
});

test("Viral Clone enforces the 1 MiB request body limit", () => {
  const payload = withChange((p) => {
    p.listing.image_info.items = Array.from({ length: 10 }, (_, index) => ({
      url: `https://media.pixverse.ai/${"a".repeat(110_000)}-${index}.webp`,
    }));
  });
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > MAX_VIRAL_CLONE_BODY_BYTES);
  assert.throws(() => normalizeViralClonePayload(payload), /at most 1048576 bytes/);
});

test("run ID helpers keep decimal strings and read the Location header", () => {
  assert.equal(readRunIdentifier("25388"), "25388");
  assert.equal(readRunIdentifier(25388), "25388");
  assert.equal(readRunIdentifier("25a"), undefined);
  assert.equal(readRunIdentifier(-1), undefined);
  assert.equal(readRunIdentifier(undefined), undefined);
  assert.equal(runIdFromLocation("/openapi/v1/viral-clone/runs/25388"), "25388");
  assert.equal(runIdFromLocation("https://h.test/openapi/v1/viral-clone/runs/7/"), "7");
  assert.equal(runIdFromLocation("/openapi/v1/videos/1"), undefined);
});

test("video import URL and list kind validation", () => {
  validateVideoImportUrl("https://cdn.example.test/reference.mp4");
  assert.throws(() => validateVideoImportUrl("file:///tmp/a.mp4"), /HTTP or HTTPS/);
  assert.throws(() => validateVideoImportUrl(""), /non-empty/);
  validateListVideosOptions({ kind: "uploaded" });
  for (const kind of ["product", "creation", "Uploaded", "viral_clone"]) {
    assert.throws(() => validateListVideosOptions({ kind }), /kind must be one of: uploaded/);
  }
});

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-viral-clone-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function readJson(jobDir, name) {
  return JSON.parse(await fs.readFile(path.join(jobDir, name), "utf8"));
}

test("Viral Clone job writes durable artifacts and submits once", async (t) => {
  const root = await tempRoot(t);
  let creates = 0;
  const result = await runViralCloneJob({
    async createViralCloneRun(payload, options) {
      creates += 1;
      assert.equal(options.traceId, "vc-trace-create");
      assert.deepEqual(payload, validPayload());
      return { body: { run_id: "25388", status: "processing", request_id: "req-create" }, headers: new Headers() };
    },
    async pollViralCloneRun(runId, options) {
      assert.equal(runId, "25388");
      await options.onSnapshot({ run_id: runId, status: "processing" });
      await options.onSnapshot({ run_id: runId, status: "succeeded" });
      return {
        run_id: runId,
        status: "succeeded",
        output: { video_url: "https://media.pixverse.ai/o.mp4", thumbnail_url: "https://media.pixverse.ai/o.jpg", mime_type: "video/mp4" },
        request_id: "req-final",
      };
    },
  }, validPayload(), { jobsDir: root, traceId: "vc-trace" });

  assert.equal(creates, 1);
  assert.equal(result.workflow, "viral-clone");
  assert.equal(result.run_id, "25388");
  assert.equal(result.status, "succeeded");
  assert.equal(result.mime_type, "video/mp4");
  const request = await readJson(result.job_dir, "request.json");
  assert.equal(request.workflow, "viral-clone");
  assert.equal(request.endpoint, "/openapi/v1/viral-clone/runs");
  assert.deepEqual(await readJson(result.job_dir, "run-id.json"), { run_id: "25388" });
  assert.equal((await readJson(result.job_dir, "create-response.json")).request_id, "req-create");
  assert.equal((await readJson(result.job_dir, "final.json")).status, "succeeded");
  const polling = (await fs.readFile(path.join(result.job_dir, "polling.jsonl"), "utf8")).trim().split("\n");
  assert.equal(polling.length, 2);
});

test("Viral Clone job recovers run_id from Location and supports --no-poll", async (t) => {
  const root = await tempRoot(t);
  const result = await runViralCloneJob({
    async createViralCloneRun() {
      return {
        body: { status: "processing", request_id: "r" },
        headers: new Headers({ location: "/openapi/v1/viral-clone/runs/991" }),
      };
    },
    async pollViralCloneRun() { throw new Error("must not poll"); },
  }, validPayload(), { jobsDir: root, poll: false });
  assert.equal(result.run_id, "991");
  assert.equal(result.status, "processing");
  assert.deepEqual(await readJson(result.job_dir, "run-id.json"), { run_id: "991" });
});

test("Viral Clone job failure without run_id records error and never retries", async (t) => {
  const root = await tempRoot(t);
  let creates = 0;
  await assert.rejects(runViralCloneJob({
    async createViralCloneRun() {
      creates += 1;
      throw new TypeError("fixture connection reset");
    },
  }, validPayload(), { jobsDir: root }), /fixture connection reset/);
  assert.equal(creates, 1);
  const [jobName] = await fs.readdir(root);
  const jobDir = path.join(root, jobName);
  const entries = await fs.readdir(jobDir);
  assert.ok(entries.includes("request.json"));
  assert.ok(entries.includes("error.json"));
  assert.equal(entries.includes("run-id.json"), false);

  const resumed = await resumeViralCloneJob({
    async createViralCloneRun() { throw new Error("resume must not create"); },
    async pollViralCloneRun() { throw new Error("resume must not poll without run_id"); },
  }, jobDir);
  assert.equal(resumed.status, "reconciliation_required");
  assert.equal(resumed.workflow, "viral-clone");
  assert.equal(resumed.retryable, false);
});

test("invalid Viral Clone payload creates no job directory", async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(runViralCloneJob({
    async createViralCloneRun() { throw new Error("must not create"); },
  }, withChange((p) => { p.video.captions = true; }), { jobsDir: root }), /server-managed/);
  assert.deepEqual(await fs.readdir(root), []);
});

test("Viral Clone resume polls a saved run_id, preserves prior final, and never creates", async (t) => {
  const root = await tempRoot(t);
  const jobDir = path.join(root, "job");
  await fs.mkdir(jobDir);
  await fs.writeFile(path.join(jobDir, "request.json"), JSON.stringify({ workflow: "viral-clone", trace_id: "vc" }));
  await fs.writeFile(path.join(jobDir, "run-id.json"), JSON.stringify({ run_id: "25388" }));
  await fs.writeFile(path.join(jobDir, "final.json"), JSON.stringify({ status: "processing" }));
  let creates = 0;
  const client = {
    async createViralCloneRun() { creates += 1; },
    async pollViralCloneRun(runId, options) {
      assert.equal(options.traceId, "vc-poll");
      return { run_id: runId, status: "failed", error: { code: "GENERATION_FAILED", message: "x" }, request_id: "rq" };
    },
  };
  const result = await resumeGrowthStudioJob(client, jobDir, { expectedWorkflow: "viral-clone" });
  assert.equal(creates, 0);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "GENERATION_FAILED");
  assert.equal((await readJson(jobDir, "final-prior-1.json")).status, "processing");

  // A terminal final.json short-circuits without any network access.
  const again = await resumeViralCloneJob({
    async pollViralCloneRun() { throw new Error("terminal job must not poll"); },
  }, jobDir);
  assert.equal(again.status, "failed");

  await assert.rejects(
    resumeGrowthStudioJob(client, jobDir, { expectedWorkflow: "pdp" }),
    /not a pdp workflow/,
  );
});
