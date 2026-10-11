import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GrowthStudioApiError } from "../src/http.js";
import { resumeGrowthStudioJob, runVideoJob } from "../src/jobs.js";

test("runVideoJob writes durable job artifacts and returns final output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-job-"));
  const payload = {
    product: { source_url: "https://shop.example.com/products/running-shoes" },
    video: { aspect_ratio: "9:16" },
  };
  const client = {
    async createVideo(receivedPayload, options) {
      assert.deepEqual(receivedPayload, payload);
      assert.equal(options.traceId, "trace-123-create");
      return {
        body: {
          video_id: "627410861853514292",
          status: "processing",
          request_id: "create-request",
        },
      };
    },
    async pollVideo(videoId, options) {
      assert.equal(videoId, "627410861853514292");
      assert.equal(options.traceId, "trace-123-poll");
      await options.onSnapshot({ video_id: videoId, status: "processing" });
      await options.onSnapshot({
        video_id: videoId,
        status: "succeeded",
        output: { video_url: "https://media.pixverse.ai/videos/result.mp4" },
        request_id: "final-request",
      });
      return {
        video_id: videoId,
        status: "succeeded",
        output: {
          video_url: "https://media.pixverse.ai/videos/result.mp4",
          thumbnail_url: "https://media.pixverse.ai/videos/result.webp",
        },
        request_id: "final-request",
      };
    },
  };

  const result = await runVideoJob(client, payload, {
    jobsDir: root,
    jobName: "Running Shoes",
    traceId: "trace-123",
    initialDelaySeconds: 0,
  });

  assert.equal(result.video_id, "627410861853514292");
  assert.equal(result.status, "succeeded");
  assert.equal(result.video_url, "https://media.pixverse.ai/videos/result.mp4");
  assert.ok(result.job_dir.startsWith(root));

  const request = JSON.parse(await fs.readFile(path.join(result.job_dir, "request.json"), "utf8"));
  const videoId = JSON.parse(await fs.readFile(path.join(result.job_dir, "video-id.json"), "utf8"));
  const final = JSON.parse(await fs.readFile(path.join(result.job_dir, "final.json"), "utf8"));
  const pollingLines = (await fs.readFile(path.join(result.job_dir, "polling.jsonl"), "utf8")).trim().split("\n");

  assert.deepEqual(request.payload, payload);
  assert.deepEqual(videoId, { video_id: "627410861853514292" });
  assert.equal(final.status, "succeeded");
  assert.equal(pollingLines.length, 2);
});

test("runVideoJob can save create result without polling", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-job-"));
  const client = {
    async createVideo() {
      return { body: { video_id: "627410861853514292", status: "processing" } };
    },
    async pollVideo() {
      throw new Error("pollVideo should not be called");
    },
  };

  const result = await runVideoJob(client, {
    product: { source_url: "https://shop.example.com/products/running-shoes" },
    video: { aspect_ratio: "9:16" },
  }, {
    jobsDir: root,
    poll: false,
  });

  assert.equal(result.status, "processing");
  assert.equal(result.video_id, "627410861853514292");
  assert.equal(await fileExists(path.join(result.job_dir, "polling.jsonl")), false);
});

test("runVideoJob can inject a folder_id override into the submitted payload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-job-"));
  const originalPayload = {
    product: { source_url: "https://shop.example.com/products/running-shoes" },
    video: { aspect_ratio: "9:16" },
  };
  const client = {
    async createVideo(receivedPayload) {
      assert.deepEqual(receivedPayload, {
        ...originalPayload,
        video: { ...originalPayload.video, folder_id: "630251570268735431" },
      });
      return { body: { video_id: "627410861853514292", status: "processing" } };
    },
    async pollVideo() {
      throw new Error("pollVideo should not be called");
    },
  };

  const result = await runVideoJob(client, originalPayload, {
    jobsDir: root,
    folderId: "630251570268735431",
    poll: false,
  });
  const request = JSON.parse(await fs.readFile(path.join(result.job_dir, "request.json"), "utf8"));

  assert.equal(request.payload.video.folder_id, "630251570268735431");
  assert.equal(request.payload.folder_id, undefined);
  assert.equal(originalPayload.video.folder_id, undefined);
});

test("runVideoJob resolves an auto folder before creating the video", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-job-"));
  const originalPayload = {
    metadata: { customer: "REVOLVE" },
    product: { source_url: "https://www.revolve.com/item" },
    video: { aspect_ratio: "9:16" },
  };
  const client = {
    async listFolders() {
      return { body: { folders: [{ folder_id: "636771263750078906", name: "REVOLVE" }] } };
    },
    async createFolder() {
      throw new Error("createFolder should not be called");
    },
    async createVideo(receivedPayload) {
      assert.equal(receivedPayload.video.folder_id, "636771263750078906");
      assert.equal(receivedPayload.folder_id, undefined);
      return { body: { video_id: "627410861853514292", status: "processing" } };
    },
    async pollVideo() {
      throw new Error("pollVideo should not be called");
    },
  };

  const result = await runVideoJob(client, originalPayload, {
    jobsDir: root,
    autoFolder: true,
    poll: false,
  });
  const request = JSON.parse(await fs.readFile(path.join(result.job_dir, "request.json"), "utf8"));
  const folder = JSON.parse(await fs.readFile(path.join(result.job_dir, "folder.json"), "utf8"));

  assert.equal(request.payload.video.folder_id, "636771263750078906");
  assert.equal(result.folder_id, "636771263750078906");
  assert.equal(result.folder_name, "REVOLVE");
  assert.equal(folder.source, "existing-folder");
  assert.equal(originalPayload.video.folder_id, undefined);
});

test("runVideoJob keeps a payload video.folder_id without resolving another folder", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-job-"));
  const payload = {
    metadata: { customer: "REVOLVE" },
    product: { source_url: "https://www.revolve.com/item" },
    video: { aspect_ratio: "9:16", folder_id: "630251570268735431" },
  };
  const client = {
    async listFolders() {
      throw new Error("listFolders should not be called");
    },
    async createFolder() {
      throw new Error("createFolder should not be called");
    },
    async createVideo(receivedPayload) {
      assert.deepEqual(receivedPayload, payload);
      return { body: { video_id: "627410861853514292", status: "processing" } };
    },
  };

  const result = await runVideoJob(client, payload, { jobsDir: root, autoFolder: true, poll: false });

  assert.equal(result.folder_id, "630251570268735431");
});

test("runVideoJob writes private atomic artifacts with recursive credential redaction", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-job-"));
  const payload = {
    product: { source_url: "https://shop.example.com/item", api_key: "payload-" + "fixture" },
    video: { aspect_ratio: "9:16" },
    metadata: { authorization: "Bearer fixture-authorization-value" },
  };
  const client = {
    async createVideo() {
      return {
        body: {
          video_id: "627410861853514292",
          status: "processing",
          access_token: "response-secret",
        },
      };
    },
  };

  const result = await runVideoJob(client, payload, { jobsDir: root, poll: false });
  const request = JSON.parse(await fs.readFile(path.join(result.job_dir, "request.json"), "utf8"));
  const created = JSON.parse(await fs.readFile(path.join(result.job_dir, "create-response.json"), "utf8"));
  const entries = await fs.readdir(result.job_dir);

  assert.equal(request.payload.product.api_key, "[REDACTED]");
  assert.equal(request.payload.metadata.authorization, "[REDACTED]");
  assert.equal(created.access_token, "[REDACTED]");
  assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
  assert.equal((await fs.stat(result.job_dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(result.job_dir, "request.json"))).mode & 0o777, 0o600);
});

test("resumeGrowthStudioJob polls a saved video ID without resubmitting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-resume-"));
  const jobDir = path.join(root, "known-job");
  await fs.mkdir(jobDir);
  await fs.writeFile(path.join(jobDir, "request.json"), JSON.stringify({
    trace_id: "trace-known",
    payload: { product: { source_url: "https://shop.example.com/item" } },
  }));
  await fs.writeFile(path.join(jobDir, "video-id.json"), JSON.stringify({
    video_id: "627410861853514292",
  }));
  await fs.writeFile(path.join(jobDir, "final.json"), JSON.stringify({
    video_id: "627410861853514292",
    status: "processing",
  }));
  let creates = 0;
  const client = {
    async createVideo() { creates += 1; },
    async pollVideo(videoId, options) {
      assert.equal(videoId, "627410861853514292");
      assert.equal(options.traceId, "trace-known-poll");
      await options.onSnapshot({ video_id: videoId, status: "succeeded" });
      return { video_id: videoId, status: "succeeded" };
    },
  };

  const result = await resumeGrowthStudioJob(client, jobDir, { initialDelaySeconds: 0 });

  assert.equal(creates, 0);
  assert.equal(result.status, "succeeded");
  assert.equal(result.video_id, "627410861853514292");
  assert.equal(result.job_dir, jobDir);
  assert.equal(JSON.parse(await fs.readFile(path.join(jobDir, "final.json"), "utf8")).status, "succeeded");
  assert.equal(JSON.parse(await fs.readFile(path.join(jobDir, "final-prior-1.json"), "utf8")).status, "processing");
});

test("resumeGrowthStudioJob without a saved ID requires reconciliation and performs no request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-resume-"));
  const jobDir = path.join(root, "unknown-job");
  await fs.mkdir(jobDir);
  await fs.writeFile(path.join(jobDir, "request.json"), JSON.stringify({
    trace_id: "trace-unknown",
    payload: { product: { source_url: "https://shop.example.com/item" } },
  }));
  let calls = 0;
  const client = new Proxy({}, { get() { calls += 1; return async () => {}; } });

  const result = await resumeGrowthStudioJob(client, jobDir);

  assert.equal(calls, 0);
  assert.deepEqual(result, {
    provider: "growth-studio",
    trace_id: "trace-unknown",
    job_dir: jobDir,
    status: "reconciliation_required",
    retryable: false,
  });
});

test("runVideoJob persists a redacted recovery error without exposing upstream details", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-error-"));
  let jobDir;
  await assert.rejects(
    runVideoJob({
      async createVideo() {
        const error = new Error("upstream rejected api_key=super-secret");
        error.code = "UPSTREAM_REJECTED";
        throw error;
      },
    }, {
      product: { source_url: "https://shop.example.com/item" },
      video: { aspect_ratio: "9:16" },
    }, {
      jobsDir: root,
      traceId: "trace-error",
    }),
    /super-secret/,
  );
  [jobDir] = (await fs.readdir(root)).map((entry) => path.join(root, entry));
  const failure = JSON.parse(await fs.readFile(path.join(jobDir, "error.json"), "utf8"));

  assert.equal(failure.provider, "growth-studio");
  assert.equal(failure.code, "UPSTREAM_REJECTED");
  assert.equal(failure.trace_id, "trace-error");
  assert.equal(JSON.stringify(failure).includes("super-secret"), false);
});

test("runVideoJob persists request_id and redacted details in error.json", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-error-"));
  await assert.rejects(
    runVideoJob({
      async createVideo() {
        throw new GrowthStudioApiError("Insufficient balance.", {
          status: 402,
          code: "INSUFFICIENT_BALANCE",
          retryable: false,
          requestId: "req_402_fixture",
          details: { required: "1.00", api_key: "leaked-fixture-value" },
        });
      },
    }, {
      product: { source_url: "https://shop.example.com/item" },
      video: { aspect_ratio: "9:16" },
    }, { jobsDir: root, traceId: "trace-402" }),
    /Insufficient balance/,
  );
  const [jobDir] = (await fs.readdir(root)).map((entry) => path.join(root, entry));
  const failure = JSON.parse(await fs.readFile(path.join(jobDir, "error.json"), "utf8"));

  assert.equal(failure.status, 402);
  assert.equal(failure.code, "INSUFFICIENT_BALANCE");
  assert.equal(failure.request_id, "req_402_fixture");
  assert.deepEqual(failure.details, { required: "1.00", api_key: "[REDACTED]" });
  assert.equal(JSON.stringify(failure).includes("leaked-fixture-value"), false);
});

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
