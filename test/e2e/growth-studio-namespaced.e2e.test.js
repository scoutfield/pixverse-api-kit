import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../helpers/cli-process.js";
import { createMockApiServer, sendJson } from "../helpers/mock-api-server.js";

test("executable Growth Studio namespace resolves folders and completes create to poll offline", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-growth-e2e-"));
  const payloadPath = path.join(tempRoot, "payload.json");
  const jobsDir = path.join(tempRoot, "jobs");
  await fs.writeFile(payloadPath, JSON.stringify({
    product: { source_url: "https://product.example.invalid/item" },
    video: {
      aspect_ratio: "9:16",
      duration_seconds: 30,
      resolution: "1080p",
      language: "en-US",
      voiceover: true,
      captions: true,
      background_music: true,
      avatar: { mode: "auto" },
    },
  }));

  const server = await createMockApiServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer mh_live_fixture");
    assert.equal(request.headers["api-key"], undefined);

    if (request.method === "GET" && request.url === "/openapi/v1/folders") {
      return sendJson(response, { folders: [{ folder_id: "630251570268735430", name: "acme" }], request_id: "req-list" });
    }
    if (request.method === "POST" && request.url === "/openapi/v1/folders") {
      assert.deepEqual(JSON.parse(request.body.toString()), { name: "ACME" });
      return sendJson(response, { folder_id: "630251570268735431", request_id: "req-create" }, 201);
    }
    if (request.method === "POST" && request.url === "/openapi/v1/videos") {
      const payload = JSON.parse(request.body.toString());
      assert.equal(payload.folder_id, undefined);
      assert.equal(payload.video.folder_id, "630251570268735431");
      return sendJson(response, { video_id: "627410861853514292", status: "processing" });
    }
    if (request.method === "GET" && request.url === "/openapi/v1/videos/627410861853514292") {
      return sendJson(response, {
        video_id: "627410861853514292",
        status: "succeeded",
        output: { video_url: "https://media.example.invalid/final.mp4" },
      });
    }
    return sendJson(response, { error: { message: "unexpected request" } }, 404);
  });
  t.after(async () => {
    await server.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await runCli([
    "growth-studio",
    "run-job",
    "--payload",
    payloadPath,
    "--folder-name",
    "ACME",
    "--jobs-dir",
    jobsDir,
    "--initial-delay-seconds",
    "0",
    "--fallback-delay-seconds",
    "0",
  ], {
    cwd: tempRoot,
    env: {
      PIXVERSE_GROWTH_API_KEY: "mh_live_fixture",
      PIXVERSE_GROWTH_BASE_URL: server.baseUrl,
    },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.video_id, "627410861853514292");
  assert.equal(output.status, "succeeded");
  assert.equal(output.folder_id, "630251570268735431");
  assert.deepEqual(server.requests.map(({ method, url }) => `${method} ${url}`), [
    "GET /openapi/v1/folders",
    "POST /openapi/v1/folders",
    "POST /openapi/v1/videos",
    "GET /openapi/v1/videos/627410861853514292",
  ]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output.job_dir, "video-id.json"), "utf8")), {
    video_id: "627410861853514292",
  });
  assert.equal((await fs.readFile(path.join(output.job_dir, "polling.jsonl"), "utf8")).trim().length > 0, true);
});

test("executable PDP create submits once, polls once, and persists recovery artifacts", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-pdp-e2e-"));
  const payloadPath = path.join(tempRoot, "pdp.json");
  const jobsDir = path.join(tempRoot, "jobs");
  const publicPayload = {
    product: {
      title: "Linen Summer Shirt",
      images: [{ url: "https://media.pixverse.ai/example/front.webp" }],
    },
    video: {
      mode: "pro",
      duration: 10,
      quality: "high",
      aspect_ratio: "9:16",
    },
  };
  await fs.writeFile(payloadPath, JSON.stringify(publicPayload));

  const server = await createMockApiServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer mh_live_fixture");
    assert.equal(request.headers["api-key"], undefined);

    if (request.method === "POST" && request.url === "/openapi/v1/ecommerce_pdp/video") {
      assert.deepEqual(JSON.parse(request.body.toString()), publicPayload);
      return sendJson(response, {
        video_id: "627410861853514292",
        ledger_source_id: "627410861853514292",
        status: "processing",
        request_id: "pdp-create-fixture",
      }, 202, {
        location: "/openapi/v1/videos/627410861853514292",
      });
    }
    if (request.method === "GET" && request.url === "/openapi/v1/videos/627410861853514292") {
      return sendJson(response, {
        video_id: "627410861853514292",
        status: "succeeded",
        request_id: "pdp-status-fixture",
        output: { video_url: "https://media.example.invalid/pdp-final.mp4" },
      });
    }
    return sendJson(response, { error: { message: "unexpected PDP request" } }, 404);
  });
  t.after(async () => {
    await server.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await runCli([
    "growth-studio",
    "pdp",
    "create",
    "--payload", payloadPath,
    "--confirm-billable",
    "--jobs-dir", "jobs",
    "--initial-delay-seconds", "0",
    "--fallback-delay-seconds", "0",
  ], {
    cwd: tempRoot,
    env: {
      PIXVERSE_GROWTH_API_KEY: "mh_live_fixture",
      PIXVERSE_GROWTH_BASE_URL: server.baseUrl,
    },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.workflow, "pdp");
  assert.equal(output.video_id, "627410861853514292");
  assert.equal(output.ledger_source_id, "627410861853514292");
  assert.equal(output.status, "succeeded");
  assert.equal(output.folder_id, undefined);
  assert.ok(output.job_dir.startsWith(await fs.realpath(jobsDir)));
  assert.deepEqual(server.requests.map(({ method, url }) => `${method} ${url}`), [
    "POST /openapi/v1/ecommerce_pdp/video",
    "GET /openapi/v1/videos/627410861853514292",
  ]);
  assert.equal(server.requests.filter(({ method }) => method === "POST").length, 1);

  const requestArtifact = JSON.parse(await fs.readFile(path.join(output.job_dir, "request.json"), "utf8"));
  assert.equal(requestArtifact.provider, "growth-studio");
  assert.equal(requestArtifact.workflow, "pdp");
  assert.equal(requestArtifact.endpoint, "/openapi/v1/ecommerce_pdp/video");
  assert.equal("type" in requestArtifact.payload, false);
  assert.equal(requestArtifact.payload.product.source_url, undefined);
  assert.equal(requestArtifact.payload.folder_id, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output.job_dir, "video-id.json"), "utf8")), {
    video_id: "627410861853514292",
  });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output.job_dir, "ledger-source-id.json"), "utf8")), {
    ledger_source_id: "627410861853514292",
  });
  assert.equal(
    JSON.parse(await fs.readFile(path.join(output.job_dir, "create-response.json"), "utf8")).status,
    "processing",
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(output.job_dir, "final.json"), "utf8")).status,
    "succeeded",
  );
  assert.equal((await fs.readFile(path.join(output.job_dir, "polling.jsonl"), "utf8")).trim().length > 0, true);
});
