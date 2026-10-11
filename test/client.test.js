import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GrowthStudioClient,
  createProductUrlPayload,
  validateCreatePayload,
  validateEditPayload,
  validateFolderPayload,
  validateListVideosOptions,
} from "../src/client.js";
import { GrowthStudioApiError, buildUrl, parseResponse } from "../src/http.js";

test("buildUrl joins base path and omits empty query values", () => {
  const url = buildUrl("https://growth-api.pixverse.ai", "/openapi/v1/videos", {
    limit: 20,
    cursor: "",
    status: "succeeded",
  });

  assert.equal(url.toString(), "https://growth-api.pixverse.ai/openapi/v1/videos?limit=20&status=succeeded");
});

test("createProductUrlPayload follows default guide settings", () => {
  const payload = createProductUrlPayload("https://shop.example.com/products/running-shoes");

  assert.deepEqual(payload, {
    product: {
      source_url: "https://shop.example.com/products/running-shoes",
    },
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
  });
});

test("createProductUrlPayload can target a Growth Studio folder", () => {
  const payload = createProductUrlPayload("https://shop.example.com/products/running-shoes", {
    folderId: "630251570268735431",
  });

  assert.equal(payload.video.folder_id, "630251570268735431");
  assert.equal("folder_id" in payload, false);
  assert.doesNotThrow(() => validateCreatePayload(payload));
});

function validVideo(overrides = {}) {
  return {
    aspect_ratio: "9:16",
    duration_seconds: 30,
    resolution: "1080p",
    language: "en-US",
    voiceover: true,
    captions: true,
    background_music: true,
    avatar: { mode: "auto" },
    ...overrides,
  };
}

const UPLOADED_IMAGE = "https://media.pixverse.ai/marketing_hub_website/openapi_video_inputs/uploads/22/11/product.webp";

test("validateCreatePayload keeps folder_id at video.folder_id as a numeric string", () => {
  assert.doesNotThrow(() => validateCreatePayload({
    product: { source_url: "https://shop.example.com/products/running-shoes" },
    video: validVideo({ folder_id: "630251570268735431" }),
  }));
  assert.throws(() => validateCreatePayload({
    product: { source_url: "https://shop.example.com/products/running-shoes" },
    video: validVideo({ folder_id: 630251570268735431 }),
  }), /folder_id must be a numeric string/);
  assert.throws(() => validateCreatePayload({
    folder_id: "630251570268735431",
    product: { source_url: "https://shop.example.com/products/running-shoes" },
    video: validVideo(),
  }), /video\.folder_id/);
});

test("validateCreatePayload accepts uploaded PixVerse image URLs", () => {
  assert.doesNotThrow(() => validateCreatePayload({
    product: {
      title: "Shoes",
      description: "Lightweight running shoes.",
      brand: "ACME",
      price: { amount: "89.99", currency: "USD" },
      images: [{ url: UPLOADED_IMAGE }],
    },
    video: validVideo({ resolution: "720P", avatar: { mode: "custom", url: "https://media.pixverse.ai/asset/avatar/urban.webp" } }),
    metadata: { order_id: "order_123456" },
  }));
});

test("validateCreatePayload rejects arbitrary image URLs", () => {
  assert.throws(() => validateCreatePayload({
    product: {
      title: "Shoes",
      images: [{ url: "https://shop.example.com/product.webp" }],
    },
    video: validVideo(),
  }), /Product images must use URLs returned by the image upload endpoint/);
});

test("validateCreatePayload enforces the documented product contract", () => {
  const cases = [
    [{ source_url: "ftp://shop.example.com/item" }, /source_url must be an HTTP or HTTPS URL/],
    [{ source_url: `https://shop.example.com/${"a".repeat(2048)}` }, /source_url must be .*2048/],
    [{ images: [{ url: UPLOADED_IMAGE }] }, /product\.title is required/],
    [{ title: "x".repeat(256), images: [{ url: UPLOADED_IMAGE }] }, /product\.title must be at most 255/],
    [{ title: "Shoes" }, /product\.source_url or product\.images/],
    [{ title: "Shoes", images: [] }, /at least one uploaded image/],
    [{ title: "Shoes", images: Array.from({ length: 7 }, () => ({ url: UPLOADED_IMAGE })) }, /at most 6 images/],
    [{ title: "Shoes", images: [{ url: UPLOADED_IMAGE }], description: "d".repeat(5121) }, /description must be at most 5120/],
    [{ title: "Shoes", images: [{ url: UPLOADED_IMAGE }], brand: "b".repeat(256) }, /brand must be at most 255/],
    [{ title: "Shoes", images: [{ url: UPLOADED_IMAGE }], price: { amount: 89.99, currency: "USD" } }, /price\.amount/],
    [{ title: "Shoes", images: [{ url: UPLOADED_IMAGE }], price: { amount: "89.99" } }, /price\.currency/],
    [{ title: "Shoes", images: [{ url: UPLOADED_IMAGE }], price: { amount: "89.99", currency: "US" } }, /price\.currency/],
  ];
  for (const [product, message] of cases) {
    assert.throws(() => validateCreatePayload({ product, video: validVideo() }), message);
  }
});

test("validateCreatePayload enforces the documented video and metadata contract", () => {
  const product = { source_url: "https://shop.example.com/products/running-shoes" };
  const cases = [
    [undefined, /requires video/],
    [validVideo({ aspect_ratio: undefined }), /aspect_ratio is required/],
    [validVideo({ duration_seconds: 20 }), /duration_seconds must be one of: 15, 30, 45, 60/],
    [validVideo({ duration_seconds: "30" }), /duration_seconds/],
    [validVideo({ resolution: "4k" }), /resolution must be one of/],
    [validVideo({ language: "en" }), /language must be one of/],
    [validVideo({ voiceover: "yes" }), /voiceover must be a boolean/],
    [validVideo({ captions: undefined }), /captions must be a boolean/],
    [validVideo({ background_music: 1 }), /background_music must be a boolean/],
    [validVideo({ avatar: undefined }), /avatar must be an object/],
    [validVideo({ avatar: { mode: "random" } }), /avatar\.mode must be one of/],
    [validVideo({ avatar: { mode: "custom" } }), /avatar\.url is required/],
    [validVideo({ avatar: { mode: "auto", url: "https://media.pixverse.ai/a.webp" } }), /avatar\.url must be omitted/],
    [validVideo({ avatar: { mode: "disabled", url: "https://media.pixverse.ai/a.webp" } }), /avatar\.url must be omitted/],
    [validVideo({ creative_ad_clone: 1 }), /creative_ad_clone must be a string/],
    [validVideo({ subtitles_size_mode: true }), /subtitles_size_mode must be a string/],
  ];
  for (const [video, message] of cases) {
    assert.throws(() => validateCreatePayload({ product, video }), message);
  }
  assert.doesNotThrow(() => validateCreatePayload({
    product,
    video: validVideo({ duration_seconds: 15, avatar: { mode: "disabled" }, creative_ad_clone: "Hook first.", subtitles_size_mode: "large" }),
  }));
  assert.throws(
    () => validateCreatePayload({ product, video: validVideo(), metadata: { order: 1 } }),
    /metadata\.order must be a string/,
  );
  assert.throws(
    () => validateCreatePayload({ product, video: validVideo(), metadata: ["x"] }),
    /metadata must be an object/,
  );
});

test("validateListVideosOptions enforces documented limit and status values", () => {
  assert.doesNotThrow(() => validateListVideosOptions({ limit: 1, status: "canceled" }));
  assert.doesNotThrow(() => validateListVideosOptions({ limit: 100 }));
  assert.throws(() => validateListVideosOptions({ limit: 0 }), /limit must be an integer from 1 through 100/);
  assert.throws(() => validateListVideosOptions({ limit: 101 }), /limit/);
  assert.throws(() => validateListVideosOptions({ limit: "20" }), /limit/);
  assert.throws(() => validateListVideosOptions({ status: "done" }), /status must be one of/);
});

test("validateEditPayload requires one-based clip index", () => {
  assert.throws(() => validateEditPayload({ clip_index: 0, instruction: "Try again." }), /one-based/);
  assert.doesNotThrow(() => validateEditPayload({ clip_index: 1, instruction: "Try again." }));
});

test("validateEditPayload enforces clip_index 1-40 and a 500-character instruction", () => {
  assert.doesNotThrow(() => validateEditPayload({ clip_index: 40, instruction: "x".repeat(500) }));
  assert.throws(() => validateEditPayload({ clip_index: 41, instruction: "Try again." }), /1 through 40/);
  assert.throws(() => validateEditPayload({ clip_index: 1.5, instruction: "Try again." }), /1 through 40/);
  assert.throws(() => validateEditPayload({ clip_index: 2, instruction: "   " }), /instruction is required/);
  assert.throws(() => validateEditPayload({ clip_index: 2, instruction: "x".repeat(501) }), /at most 500/);
});

test("parseResponse throws structured API errors", async () => {
  const response = new Response(JSON.stringify({
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests.",
      retryable: true,
      details: { limit: 1000 },
    },
    request_id: "request_abc123",
  }), {
    status: 429,
    headers: { "retry-after": "30" },
  });

  await assert.rejects(parseResponse(response), (error) => {
    assert.ok(error instanceof GrowthStudioApiError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "RATE_LIMIT_EXCEEDED");
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfter, 30);
    assert.equal(error.requestId, "request_abc123");
    return true;
  });
});

test("parseResponse rejects malformed JSON from a successful response as a protocol error", async () => {
  const response = new Response("not-json", {
    status: 200,
    headers: { "x-request-id": "request_malformed" },
  });

  await assert.rejects(parseResponse(response), (error) => {
    assert.ok(error instanceof GrowthStudioApiError);
    assert.equal(error.category, "protocol");
    assert.equal(error.status, 200);
    assert.equal(error.code, "INVALID_JSON_RESPONSE");
    assert.equal(error.retryable, false);
    assert.equal(error.requestId, "request_malformed");
    assert.match(error.message, /invalid JSON/i);
    return true;
  });
});

test("client keeps video IDs as strings and sends bearer auth", async () => {
  const calls = [];
  const credentials = { ["api" + "Key"]: "test-api-key" };
  const client = new GrowthStudioClient({
    ...credentials,
    baseUrl: "https://growth-api.pixverse.ai",
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return new Response(JSON.stringify({ video_id: "627410861853514292", status: "succeeded" }), { status: 200 });
    },
  });

  const result = await client.getVideo("627410861853514292");

  assert.equal(result.body.video_id, "627410861853514292");
  assert.equal(calls[0].url, "https://growth-api.pixverse.ai/openapi/v1/videos/627410861853514292");
  assert.equal(calls[0].init.headers.get("Authorization"), "Bearer test-api-key");
});

test("client lists and creates folders through the documented /openapi/v1/folders endpoints", async () => {
  const calls = [];
  const credentials = { ["api" + "Key"]: "test-api-key" };
  const responses = [
    new Response('{"folders":[{"folder_id":636771263750078906,"name":"REVOLVE"}],"request_id":"req-list"}', { status: 200 }),
    new Response(JSON.stringify({ folder_id: "636771263750078907", request_id: "req-create" }), { status: 201 }),
  ];
  const client = new GrowthStudioClient({
    ...credentials,
    baseUrl: "https://growth-api.pixverse.ai",
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return responses.shift();
    },
  });

  const listResult = await client.listFolders();
  const createResult = await client.createFolder({ name: "September campaign" });

  assert.deepEqual(listResult.body.folders, [{ folder_id: "636771263750078906", name: "REVOLVE" }]);
  assert.deepEqual(createResult.body, { folder_id: "636771263750078907", request_id: "req-create" });
  assert.equal(createResult.requestId, "req-create");
  assert.equal(calls[0].url, "https://growth-api.pixverse.ai/openapi/v1/folders");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].url, "https://growth-api.pixverse.ai/openapi/v1/folders");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[0].init.headers.get("Authorization"), "Bearer test-api-key");
  assert.equal(calls[1].init.headers.get("Authorization"), "Bearer test-api-key");
  assert.equal(calls[1].init.body, JSON.stringify({ name: "September campaign" }));
});

test("folder errors use the standard Growth Studio error body", async () => {
  const client = new GrowthStudioClient({
    ["api" + "Key"]: "test-api-key",
    baseUrl: "https://growth-api.pixverse.ai",
    fetchImpl: async () => new Response(JSON.stringify({
      error: { code: "FOLDER_LIMIT_EXCEEDED", message: "Folder limit reached.", retryable: false },
      request_id: "req-limit",
    }), { status: 409 }),
  });

  await assert.rejects(client.createFolder({ name: "One more" }), (error) => {
    assert.ok(error instanceof GrowthStudioApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "FOLDER_LIMIT_EXCEEDED");
    assert.equal(error.requestId, "req-limit");
    return true;
  });
});

test("parseResponse keeps 64-bit integer identifiers lossless as strings", async () => {
  const result = await parseResponse(new Response(
    '{"video_id":627410861853514292,"price":1299,"data":[{"avatar_id":123456789012345678}]}',
    { status: 200 },
  ));

  assert.equal(result.body.video_id, "627410861853514292");
  assert.equal(result.body.price, 1299);
  assert.equal(result.body.data[0].avatar_id, "123456789012345678");
  assert.equal(Object.getPrototypeOf(result.body), Object.prototype);
});

test("parseResponse defaults retryable by status when the error body is missing", async () => {
  const expectations = [[429, true], [503, true], [500, false], [400, false]];
  for (const [status, retryable] of expectations) {
    await assert.rejects(parseResponse(new Response("", {
      status,
      headers: { "retry-after": "12", "x-request-id": `req-${status}` },
    })), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.retryable, retryable);
      assert.equal(error.retryAfter, 12);
      assert.equal(error.requestId, `req-${status}`);
      return true;
    });
  }
  await assert.rejects(parseResponse(new Response(JSON.stringify({
    error: { code: "INTERNAL_ERROR", message: "boom", retryable: true },
  }), { status: 500 })), (error) => error.retryable === true && error.code === "INTERNAL_ERROR");
});

test("GET requests retry 429 and retryable 5xx honoring Retry-After seconds and HTTP dates", async () => {
  const waits = [];
  const calls = [];
  const nowMs = Date.parse("2026-10-10T00:00:00Z");
  const responses = [
    new Response("", { status: 429, headers: { "retry-after": "3" } }),
    new Response("", { status: 503, headers: { "retry-after": new Date(nowMs + 9_000).toUTCString() } }),
    new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "retry", retryable: true } }), { status: 500 }),
    new Response(JSON.stringify({ data: [], pagination: { has_more: false, next_cursor: "" } }), { status: 200 }),
  ];
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    const client = new GrowthStudioClient({
      ["api" + "Key"]: "test-api-key",
      baseUrl: "https://growth-api.pixverse.ai",
      fetchImpl: async (url, init) => {
        calls.push({ url: url.toString(), method: init.method });
        return responses.shift();
      },
      sleep: async (ms) => waits.push(ms),
    });

    const result = await client.listVideos({ limit: 20, status: "succeeded" });

    assert.deepEqual(result.body.data, []);
  } finally {
    Date.now = realNow;
  }
  assert.equal(calls.length, 4);
  assert.equal(calls.every(({ method }) => method === "GET"), true);
  assert.deepEqual(waits, [3000, 9000, 4000]);
});

test("GET retries use capped exponential backoff and stop after the attempt budget", async () => {
  const waits = [];
  let calls = 0;
  const client = new GrowthStudioClient({
    ["api" + "Key"]: "test-api-key",
    baseUrl: "https://growth-api.pixverse.ai",
    readRetry: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 3_000 },
    fetchImpl: async () => {
      calls += 1;
      return new Response("", { status: 503 });
    },
    sleep: async (ms) => waits.push(ms),
  });

  await assert.rejects(client.listAvatars(), (error) => error.status === 503);
  assert.equal(calls, 5);
  assert.deepEqual(waits, [1000, 2000, 3000, 3000]);
});

test("GET requests do not retry non-retryable errors", async () => {
  let calls = 0;
  const client = new GrowthStudioClient({
    ["api" + "Key"]: "test-api-key",
    baseUrl: "https://growth-api.pixverse.ai",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "no", retryable: false } }), { status: 500 });
    },
    sleep: async () => {},
  });

  await assert.rejects(client.getVideo("627410861853514292"), /no/);
  assert.equal(calls, 1);
});

test("POST create, edit, upload, and folder create are never retried", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-upload-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "product.png");
  await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const calls = [];
  const client = new GrowthStudioClient({
    ["api" + "Key"]: "test-api-key",
    baseUrl: "https://growth-api.pixverse.ai",
    fetchImpl: async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      return new Response("", { status: calls.length % 2 ? 429 : 503, headers: { "retry-after": "1" } });
    },
    sleep: async () => {
      throw new Error("POST requests must not sleep for a retry");
    },
  });

  await assert.rejects(client.createVideo({
    product: { source_url: "https://shop.example.com/item" },
    video: validVideo(),
  }), (error) => error.status === 429);
  await assert.rejects(client.editVideo("627410861853514292", { clip_index: 2, instruction: "Smile." }), (error) => error.status === 503);
  await assert.rejects(client.uploadImage(imagePath), (error) => error.status === 429);
  await assert.rejects(client.createFolder({ name: "ACME" }), (error) => error.status === 503);

  assert.deepEqual(calls, [
    "POST /openapi/v1/videos",
    "POST /openapi/v1/videos/627410861853514292/edit",
    "POST /openapi/v1/image/upload",
    "POST /openapi/v1/folders",
  ]);
});

test("uploadImage validates extension and size locally and sets the blob type", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-upload-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const client = new GrowthStudioClient({
    ["api" + "Key"]: "test-api-key",
    baseUrl: "https://growth-api.pixverse.ai",
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return new Response(JSON.stringify({ url: "https://media.pixverse.ai/uploads/x.webp", request_id: "req-up" }), { status: 200 });
    },
  });

  const gifPath = path.join(root, "product.gif");
  await fs.writeFile(gifPath, "GIF89a");
  await assert.rejects(client.uploadImage(gifPath), /\.jpg, \.jpeg, \.png, or \.webp/);

  const largePath = path.join(root, "large.jpg");
  const handle = await fs.open(largePath, "w");
  await handle.truncate(20 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(client.uploadImage(largePath), /20 MiB/);
  assert.equal(calls.length, 0);

  for (const [name, type] of [["a.JPG", "image/jpeg"], ["b.jpeg", "image/jpeg"], ["c.png", "image/png"], ["d.webp", "image/webp"]]) {
    const filePath = path.join(root, name);
    await fs.writeFile(filePath, "fixture");
    await client.uploadImage(filePath);
    const image = calls.at(-1).init.body.get("image");
    assert.equal(image.type, type);
    assert.equal(image.name, name);
  }
  assert.equal(new URL(calls[0].url).pathname, "/openapi/v1/image/upload");
});

test("validateFolderPayload requires a folder name", () => {
  assert.doesNotThrow(() => validateFolderPayload({ name: "REVOLVE" }));
  assert.throws(() => validateFolderPayload({ name: "" }), /non-empty name/);
});

function pollingClient(responses, { waits, now } = {}) {
  const calls = [];
  const client = new GrowthStudioClient({
    ["api" + "Key"]: "test-api-key",
    baseUrl: "https://growth-api.pixverse.ai",
    fetchImpl: async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      const next = responses.shift();
      return typeof next === "function" ? next() : next;
    },
    sleep: async (ms) => waits?.push(ms),
    ...(now ? { now } : {}),
  });
  return { client, calls };
}

function videoResponse(body, headers = {}) {
  return new Response(JSON.stringify({ video_id: "627410861853514292", ...body }), { status: 200, headers });
}

test("pollVideo honors Retry-After, enforces the five-second first wait, and stops on succeeded", async () => {
  const waits = [];
  const snapshots = [];
  const { client } = pollingClient([
    videoResponse({ status: "processing" }, { "retry-after": "7" }),
    videoResponse({ status: "succeeded", output: { video_url: "https://media.pixverse.ai/videos/result.mp4" } }),
  ], { waits });

  const result = await client.pollVideo("627410861853514292", {
    initialDelaySeconds: 0,
    onSnapshot: async (snapshot) => snapshots.push(snapshot.status),
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(waits, [5000, 7000]);
  assert.deepEqual(snapshots, ["processing", "succeeded"]);
});

test("pollVideo clamps the fallback delay to at least one second", async () => {
  const waits = [];
  const { client } = pollingClient([
    videoResponse({ status: "queued" }),
    videoResponse({ status: "succeeded" }),
  ], { waits });

  await client.pollVideo("627410861853514292", { initialDelaySeconds: 2, fallbackDelaySeconds: 0 });

  assert.deepEqual(waits, [5000, 1000]);
});

test("pollVideo keeps polling through 429 and retryable 5xx responses within its deadline", async () => {
  const waits = [];
  const { client, calls } = pollingClient([
    new Response("", { status: 429, headers: { "retry-after": "30" } }),
    new Response("", { status: 503, headers: { "retry-after": "2" } }),
    new Response("", { status: 429, headers: { "retry-after": "4" } }),
    new Response("", { status: 503 }),
    new Response("", { status: 503, headers: { "retry-after": "6" } }),
    videoResponse({ status: "succeeded" }),
  ], { waits });
  client.readRetry = { ...client.readRetry, maxAttempts: 2 };

  const result = await client.pollVideo("627410861853514292", { fallbackDelaySeconds: 3 });

  assert.equal(result.status, "succeeded");
  assert.equal(calls.length, 6);
  // First wait, in-request retry (30s), poll-level Retry-After after exhausted retries (2s),
  // in-request retry (4s), poll-level fallback with no Retry-After (3s), in-request retry (6s).
  assert.deepEqual(waits, [5000, 30000, 2000, 4000, 3000, 6000]);
});

test("pollVideo stops on retryable errors once the deadline passes", async () => {
  let nowMs = 0;
  const { client, calls } = pollingClient([
    () => {
      nowMs = 11_000;
      return new Response("", { status: 503 });
    },
  ], { now: () => nowMs });
  client.readRetry = { ...client.readRetry, maxAttempts: 1 };

  await assert.rejects(
    client.pollVideo("627410861853514292", { timeoutMs: 10_000 }),
    (error) => error.status === 503,
  );
  assert.equal(calls.length, 1);
});

test("pollVideo prefers edit.status over edit.latest.status", async () => {
  const waits = [];
  const { client, calls } = pollingClient([
    videoResponse({ status: "succeeded", edit: { status: "processing", latest: { status: "succeeded" } } }, { "retry-after": "5" }),
    videoResponse({ status: "succeeded", edit: { status: "succeeded", latest: { status: "processing" } } }),
  ], { waits });

  const result = await client.pollVideo("627410861853514292");

  assert.equal(result.edit.status, "succeeded");
  assert.equal(calls.length, 2);
});
