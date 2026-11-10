import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGrowthStudioCommand } from "../../src/growth-studio/cli.js";
import { runWorkflowJob, resumeWorkflowJob } from "../../src/growth-studio/workflow-jobs.js";
import { payloads } from "../helpers/growth-workflow-fixtures.js";
import { runCli } from "../helpers/cli-process.js";

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-workflows-"));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
const noClient = () => { throw new Error("must not load credentials or access client"); };

test("CLI dry runs for every new creation are credential-free and artifact-free", async (t) => {
  const root = await temp(t);
  for (const [name, body] of Object.entries(payloads())) {
    if (name === "video-import") continue;
    await fs.writeFile(path.join(root, `${name}.json`), JSON.stringify(body));
    const context = { cwd: root, get client() { return noClient(); } };
    const result = await runGrowthStudioCommand([name, "create", "--payload", `${name}.json`, "--dry-run"], context);
    assert.deepEqual(result.body, body);
    assert.equal(result.billable, false);
    await assert.rejects(runGrowthStudioCommand([name, "create", "--payload", `${name}.json`], context), /confirm-billable/);
    await assert.rejects(runGrowthStudioCommand([name, "create", "--payload", `${name}.json`, "--dry-run", "--confirm-billable"], context), /not both/);
    await assert.rejects(runGrowthStudioCommand([name, "create", "--payload", `${name}.json`, "--dry-run", "--no-poll"], context), /job or polling/);
  }
  assert.equal((await fs.readdir(root)).length, 4);
  const imported = await runGrowthStudioCommand(["upload", "video", payloads()["video-import"].url, "--dry-run"], { get client() { return noClient(); } });
  assert.equal(imported.path, "/openapi/v1/video/upload");
  const result = await runCli(["growth-studio", "template", "create", "--payload", path.join(root, "template.json"), "--dry-run"], { cwd: root });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).body.template_id, 0);
});

test("CLI validates IDs, duplicate options, and unsupported flags before accessing credentials", async () => {
  const context = { get client() { return noClient(); } };
  for (const args of [
    ["viral-clone", "get", "not-id"], ["product-suite", "poll", "1", "--timeout-minutes", "NaN"],
    ["template", "create", "--payload", "x", "--dry-run", "--dry-run"],
    ["template", "get", "1", "--timeout-minutes", "2"], ["templates", "list", "extra"],
    ["wallet", "discount", "extra"], ["upload", "video", "https://example.test/video", "--payload", "x"],
  ]) await assert.rejects(runGrowthStudioCommand(args, context), (e) => !/must not load/.test(e.message));
});

test("variation recovery preserves input mapping, batch ledger ID, finished videos and resumes only unfinished reads", async (t) => {
  const root = await temp(t);
  let submissions = 0;
  const polled = [];
  let interrupt = true;
  const client = {
    async createWorkflow() {
      submissions++;
      return { body: { ledger_source_id: "7412583960987654320", videos: [
        { video_id: "7412583960987654321", status: "processing", input_indices: [0, 2] },
        { video_id: "7412583960987654322", status: "processing", input_indices: [1] },
      ] } };
    },
    async pollWorkflow(name, id, options) {
      assert.equal(name, "variation"); polled.push(id);
      if (id.endsWith("2") && interrupt) throw new Error("poll interrupted");
      const result = { video_id: id, status: id.endsWith("2") ? "failed" : "succeeded", error: id.endsWith("2") ? { code: "GENERATION_FAILED" } : null };
      await options.onSnapshot(result); return result;
    },
  };
  let jobDir;
  await assert.rejects(runWorkflowJob(client, "variation", payloads().variation, { jobsDir: root }), (error) => {
    jobDir = error.details.job_dir; return /poll interrupted/.test(error.message);
  });
  assert.equal(submissions, 1);
  interrupt = false;
  const result = await resumeWorkflowJob(() => client, "variation", jobDir);
  assert.equal(submissions, 1);
  assert.deepEqual(polled, ["7412583960987654321", "7412583960987654322", "7412583960987654322"]);
  assert.equal(result.ledger_source_id, "7412583960987654320");
  assert.deepEqual(result.videos[0].input_indices, [0, 2]);
  assert.equal(result.videos[1].error.code, "GENERATION_FAILED");
  assert.equal(result.status, "completed");
  assert.deepEqual(await resumeWorkflowJob(noClient, "variation", jobDir), result);
});

test("lost or malformed acceptance persists evidence and resume returns reconciliation without credentials", async (t) => {
  const root = await temp(t);
  for (const malformed of [false, true]) {
    const jobsDir = path.join(root, String(malformed));
    let count = 0;
    const client = { async createWorkflow() { count++; if (!malformed) throw new TypeError("lost response"); return { body: { status: "processing" } }; } };
    let jobDir;
    await assert.rejects(runWorkflowJob(client, "viral-clone", payloads()["viral-clone"], { jobsDir }), (e) => { jobDir = e.details.job_dir; return true; });
    assert.equal(count, 1);
    assert.equal((await resumeWorkflowJob(noClient, "viral-clone", jobDir)).status, "reconciliation_required");
    const files = await fs.readdir(jobDir);
    assert.ok(files.includes("request.json"));
    assert.equal(files.includes("create-response.json"), malformed);
  }
});

test("no-poll acceptance resumes with the correct run/task endpoint and retains mixed suite results", async (t) => {
  const root = await temp(t);
  for (const [name, idField, status] of [["viral-clone", "run_id", "failed"], ["product-suite", "task_id", "completed"], ["template", "video_id", "succeeded"]]) {
    const final = { [idField]: "7412583960987654321", status, images: [{ status: "failed" }, { status: "audit_rejected" }] };
    const client = {
      async createWorkflow() { return { body: { [idField]: "7412583960987654321", status: "processing" } }; },
      async pollWorkflow(actual, id) { assert.equal(actual, name); assert.equal(id, "7412583960987654321"); return final; },
    };
    const accepted = await runWorkflowJob(client, name, payloads()[name], { jobsDir: root, poll: false });
    assert.equal(accepted.status, "processing");
    const result = await resumeWorkflowJob(() => client, name, accepted.job_dir);
    assert.deepEqual(result.images, final.images);
    assert.equal(result.status, status);
    await assert.rejects(resumeWorkflowJob(noClient, "variation", accepted.job_dir), /not a Growth Studio/);
  }
});

test("synchronous imports submit once, never poll, and redact signed URL credentials in saved evidence", async (t) => {
  const root = await temp(t);
  let creates = 0;
  const payload = payloads()["video-import"];
  const result = await runWorkflowJob({
    async createWorkflow(name, body) { creates++; assert.equal(name, "video-import"); assert.deepEqual(body, payload); return { body: { video_id: "123", url: payload.url, duration: 30.2 } }; },
    pollWorkflow: noClient,
  }, "video-import", payload, { jobsDir: root });
  assert.equal(creates, 1);
  const request = await fs.readFile(path.join(result.job_dir, "request.json"), "utf8");
  assert.ok(!request.includes("private-fixture"));
  assert.ok(request.includes("[REDACTED]"));
  assert.equal((await fs.stat(path.join(result.job_dir, "request.json"))).mode & 0o777, 0o600);
  assert.equal((await resumeWorkflowJob(noClient, "video-import", result.job_dir)).video_id, "123");
});
