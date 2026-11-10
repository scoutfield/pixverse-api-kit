import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli } from "../helpers/cli-process.js";
import { createMockApiServer, sendJson } from "../helpers/mock-api-server.js";
import { payloads } from "../helpers/growth-workflow-fixtures.js";

test("executable creates a suite once, resumes its task ID, and reports partial image failures", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-suite-e2e-"));
  const payload = payloads()["product-suite"];
  await fs.writeFile(path.join(root, "suite.json"), JSON.stringify(payload));
  const server = await createMockApiServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer mh_live_fixture");
    if (request.method === "POST" && request.url === "/openapi/v1/product-suite/images/generations") {
      assert.deepEqual(JSON.parse(request.body.toString()), payload);
      return sendJson(response, { task_id: "7412583960987654321", status: "processing" }, 202);
    }
    if (request.method === "GET" && request.url === "/openapi/v1/product-suite/images/generations/7412583960987654321") {
      return sendJson(response, { task_id: "7412583960987654321", status: "completed", images: [{ image_id: "1", status: "succeeded", url: "https://media.pixverse.ai/a.png" }, { image_id: "2", status: "failed" }] });
    }
    return sendJson(response, { error: { message: "unexpected request" } }, 404);
  });
  t.after(async () => { await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const options = { cwd: root, env: { PIXVERSE_GROWTH_API_KEY: "mh_live_fixture", PIXVERSE_GROWTH_BASE_URL: server.baseUrl } };
  const created = await runCli(["growth-studio", "product-suite", "create", "--payload", "suite.json", "--confirm-billable", "--no-poll"], options);
  assert.equal(created.exitCode, 0, created.stderr);
  const accepted = JSON.parse(created.stdout);
  assert.equal(accepted.status, "processing");
  const resumed = await runCli(["growth-studio", "product-suite", "resume", accepted.job_dir], options);
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  const result = JSON.parse(resumed.stdout);
  assert.equal(result.status, "completed");
  assert.equal(result.images[1].status, "failed");
  assert.deepEqual(server.requests.map((r) => r.method), ["POST", "GET"]);
});

test("real dry run and missing-ID resume never read credential files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-no-credentials-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // A child preload detects real file reads without inspecting any saved keys.
  const guard = path.join(root, "guard.mjs");
  await fs.writeFile(guard, `import fs from 'node:fs';
const original = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (/(?:credentials\\.env|\\/\\.env)$/.test(String(file))) throw new Error('credential file read forbidden');
  return original.call(this, file, ...args);
};`);
  await fs.writeFile(path.join(root, "template.json"), JSON.stringify(payloads().template));
  const options = { cwd: root, env: { NODE_OPTIONS: `--import=${guard}` } };
  const dry = await runCli(["growth-studio", "template", "create", "--payload", "template.json", "--dry-run"], options);
  assert.equal(dry.exitCode, 0, dry.stderr);
  const job = path.join(root, "job"); await fs.mkdir(job);
  await fs.writeFile(path.join(job, "request.json"), JSON.stringify({ provider: "growth-studio", workflow: "template" }));
  const resumed = await runCli(["growth-studio", "template", "resume", job], options);
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "reconciliation_required");
});
