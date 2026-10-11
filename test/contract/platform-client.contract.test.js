import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";


import {
  PlatformClient,
  normalizePlatformResponseIdentifiers,
} from "../../src/platform/client.js";
import { PLATFORM_OPERATIONS } from "../../src/platform/operations.js";
import { buildPlatformRequest } from "../../src/platform/request.js";
import { createRecordingFetch, describeRecordedBody, jsonResponse, parseLosslessJson } from "../helpers/recording-fetch.js";

const FIXTURES = new URL("../fixtures/platform/", import.meta.url);
const TEST_CREDENTIAL = ["fixture", "credential"].join("-");
const BASE_URL = "https://platform.example.test";

for (const operation of PLATFORM_OPERATIONS) {
  test(`${operation.id} matches its independent request and success contracts`, async () => {
    const requestFixture = await fixture(operation.id, "request");
    const successFixture = await fixture(operation.id, "success");
    const frozenInput = deepFreeze(structuredClone(requestFixture.input));
    const recorder = createRecordingFetch([jsonResponse(successFixture.responseText)]);
    const client = new PlatformClient({
      apiKey: TEST_CREDENTIAL,
      baseUrl: BASE_URL,
      fetchImpl: recorder.fetchImpl,
    });

    const result = await client.execute(operation.id, frozenInput);

    assert.equal(recorder.calls.length, 1);
    const [call] = recorder.calls;
    assert.equal(call.method, requestFixture.method);
    assert.equal(call.url, `${BASE_URL}${requestFixture.path}`);
    assert.equal(call.headers.get("API-KEY"), TEST_CREDENTIAL);
    assert.match(call.headers.get("Ai-trace-id"), UUID_PATTERN);
    assert.equal(call.headers.get("Accept"), "application/json");
    assert.deepEqual(await describeRecordedBody(call.body), requestFixture.body);
    if (operation.bodyMode === "multipart") {
      assert.equal(call.headers.has("Content-Type"), false);
    } else if (operation.bodyMode === "json") {
      assert.equal(call.headers.get("Content-Type"), "application/json");
    } else {
      assert.equal(call.headers.has("Content-Type"), false);
    }
    assert.deepEqual(frozenInput, requestFixture.input);
    assert.equal(result.operation, operation.id);
    assert.equal(result.traceId, call.headers.get("Ai-trace-id"));
    assert.deepEqual(toPlainJson(result.envelope), successFixture.expectedEnvelope);
    assert.deepEqual(toPlainJson(result.data), successFixture.expectedData);
    assert.equal(result.retryAfter, successFixture.retryAfter);
    assertStringIds(result.envelope);
  });
}

test("new requests always receive fresh trace IDs and ignore a caller trace outside recovery", async () => {
  const recorder = createRecordingFetch([
    jsonResponse('{"ErrCode":0,"ErrMsg":"success","Resp":{}}'),
    jsonResponse('{"ErrCode":0,"ErrMsg":"success","Resp":{}}'),
  ]);
  const client = new PlatformClient({ apiKey: TEST_CREDENTIAL, baseUrl: BASE_URL, fetchImpl: recorder.fetchImpl });

  const first = await client.execute("account.balance", {}, { traceId: "caller-trace" });
  const second = await client.execute("account.balance", {});

  assert.match(first.traceId, UUID_PATTERN);
  assert.match(second.traceId, UUID_PATTERN);
  assert.notEqual(first.traceId, "caller-trace");
  assert.notEqual(first.traceId, second.traceId);
});

test("response normalization stringifies resource IDs recursively without mutating source or numeric metrics", () => {
  const source = deepFreeze({
    id: 1,
    account_id: 2,
    video_id: 3,
    image_id: 4,
    speaker_id: 5,
    keyframe_id: 6,
    status: 7,
    count: 8,
    credits: 9,
    created_at: 1_726_733_600,
    nested: Object.freeze([Object.freeze({
      mask_id: 10,
      video_ids: Object.freeze([11, "9007199254740993"]),
      image_id: "9007199254740995",
    })]),
  });

  const normalized = normalizePlatformResponseIdentifiers(source);

  assert.deepEqual(toPlainJson(normalized), {
    id: "1",
    account_id: "2",
    video_id: "3",
    image_id: "4",
    speaker_id: "5",
    keyframe_id: 6,
    status: 7,
    count: 8,
    credits: 9,
    created_at: 1_726_733_600,
    nested: [{
      mask_id: "10",
      video_ids: ["11", "9007199254740993"],
      image_id: "9007199254740995",
    }],
  });
  assert.equal(source.account_id, 2);
  assert.equal(source.nested[0].mask_id, 10);
  assert.notEqual(normalized, source);
  assert.notEqual(normalized.nested, source.nested);
  assert.notEqual(normalized.nested[0], source.nested[0]);
});

test("explicit recovery reuses only the saved trace and preserves the abort signal", async () => {
  const savedTrace = "7e407ae8-0f1c-4c42-958f-f08ae674d19d";
  const controller = new AbortController();
  const recorder = createRecordingFetch([jsonResponse('{"ErrCode":0,"ErrMsg":"success","Resp":{}}')]);
  const client = new PlatformClient({ apiKey: TEST_CREDENTIAL, baseUrl: BASE_URL, fetchImpl: recorder.fetchImpl });

  const result = await client.execute("account.balance", {}, {
    recovery: true,
    traceId: savedTrace,
    signal: controller.signal,
  });

  assert.equal(result.traceId, savedTrace);
  assert.equal(recorder.calls[0].headers.get("Ai-trace-id"), savedTrace);
  assert.equal(recorder.calls[0].signal, controller.signal);
});

test("an aborted read request is surfaced once without retry or backoff", async () => {
  const abortCause = new DOMException("Stop Platform request.", "AbortError");
  const controller = new AbortController();
  controller.abort(abortCause);
  const delays = [];
  let attempts = 0;
  const client = new PlatformClient({
    apiKey: TEST_CREDENTIAL,
    baseUrl: BASE_URL,
    sleep: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async (_url, { signal }) => {
      attempts += 1;
      throw signal.reason;
    },
  });

  await assert.rejects(
    client.execute("account.balance", {}, { signal: controller.signal }),
    (error) => error.category === "transport"
      && error.retryable === false
      && error.cause === abortCause,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test("GET and HEAD read requests retry transient failures, while every non-read-only request submits once", async () => {
  const readRecorder = createRecordingFetch([
    jsonResponse('{"error":"busy"}', { status: 503 }),
    jsonResponse('{"ErrCode":0,"ErrMsg":"success","Resp":{}}'),
  ]);
  const readClient = new PlatformClient({
    apiKey: TEST_CREDENTIAL, baseUrl: BASE_URL, fetchImpl: readRecorder.fetchImpl, sleep: async () => {},
  });
  await readClient.execute("account.balance", {});
  assert.equal(readRecorder.calls.length, 2);

  const writeRecorder = createRecordingFetch([
    jsonResponse('{"error":{"message":"busy"}}', { status: 503 }),
    jsonResponse('{"ErrCode":0,"ErrMsg":"success","Resp":{}}'),
  ]);
  const writeClient = new PlatformClient({
    apiKey: TEST_CREDENTIAL, baseUrl: BASE_URL, fetchImpl: writeRecorder.fetchImpl, sleep: async () => {},
  });
  await assert.rejects(
    writeClient.execute("video.text", {
      aspect_ratio: "16:9", duration: 5, model: "v6", prompt: "hello", quality: "720p",
    }),
    (error) => error.status === 503,
  );
  assert.equal(writeRecorder.calls.length, 1);
});

test("request building preserves repeated query values and types local multipart files by extension", async () => {
  const queryRequest = await buildPlatformRequest({
    id: "fixture.query", method: "GET", path: "/items", bodyMode: "none",
  }, {
    payload: { future: "kept" },
    query: { ids: ["1", "2"], blank: "", missing: null },
    pathParams: {},
    files: {},
  });
  assert.equal(queryRequest.path, "/items?future=kept&ids=1&ids=2");

  const filePath = fileURLToPath(new URL("../fixtures/media/tiny.png", import.meta.url));
  const multipartRequest = await buildPlatformRequest({
    id: "fixture.multipart", method: "POST", path: "/upload", bodyMode: "multipart",
  }, {
    payload: { metadata: { role: "cover" }, omitted: null },
    query: {},
    pathParams: {},
    files: { image: filePath },
  });
  assert.equal(multipartRequest.headers.has("Content-Type"), false);
  assert.deepEqual(await describeRecordedBody(multipartRequest.body), {
    metadata: '{"role":"cover"}',
    image: { name: "tiny.png", size: 90, type: "image/png" },
  });

  // The template list documents template_ids as a single comma-separated string.
  const templatesRequest = await buildPlatformRequest({
    id: "resource.templates", method: "GET", path: "/templates", bodyMode: "none",
  }, {
    payload: { template_ids: ["402331965264704", "402331965264705"] },
    query: {},
    pathParams: {},
    files: {},
  });
  assert.equal(templatesRequest.path, "/templates?template_ids=402331965264704%2C402331965264705");
});

test("Music MV uint64 identifiers stay strings internally but serialize as lossless JSON numbers", async () => {
  const audioInput = deepFreeze({
    payload: { audio_media_id: "18446744073709551615" },
    query: {},
    pathParams: {},
    files: {},
  });
  const audioRequest = await buildPlatformRequest({
    id: "audio.verify", method: "POST", path: "/audio", bodyMode: "json",
  }, audioInput);
  assert.equal(audioRequest.body, '{"audio_media_id":18446744073709551615}');
  assert.equal(audioInput.payload.audio_media_id, "18446744073709551615");

  const mvInput = deepFreeze({
    payload: {
      audio_media_id: "425662507205761",
      img_references: [{ img_id: "164913710", ref_name: "Character" }],
      style_img_references: [{ img_id: "164913711", ref_name: "Style" }],
      seed: 42,
    },
    query: {},
    pathParams: {},
    files: {},
  });
  const mvRequest = await buildPlatformRequest({
    id: "agent.music-mv", method: "POST", path: "/mv", bodyMode: "json",
  }, mvInput);
  assert.equal(mvRequest.body, '{"audio_media_id":425662507205761,"style_img_references":[{"img_id":164913711,"ref_name":"Style"}],"seed":42,"image_references":[{"img_id":164913710,"ref_name":"Character"}]}');
  assert.equal(mvInput.payload.img_references[0].img_id, "164913710");

  // The fusion endpoint documents image_references[].img_id as an integer; string IDs are rejected (ErrCode 400013).
  const fusionInput = deepFreeze({
    payload: {
      model: "v6",
      image_references: [{ img_id: "892421142", ref_name: "front" }, { img_id: "892421144", ref_name: "side" }],
      prompt: "@front @side walk.",
      duration: 15,
      quality: "1080p",
      aspect_ratio: "9:16",
      generate_audio_switch: true,
    },
    query: {},
    pathParams: {},
    files: {},
  });
  const fusionRequest = await buildPlatformRequest({
    id: "video.fusion", method: "POST", path: "/fusion", bodyMode: "json",
  }, fusionInput);
  assert.equal(fusionRequest.body, '{"model":"v6","image_references":[{"img_id":892421142,"ref_name":"front"},{"img_id":892421144,"ref_name":"side"}],"prompt":"@front @side walk.","duration":15,"quality":"1080p","aspect_ratio":"9:16","generate_audio_switch":true}');
  assert.equal(fusionInput.payload.image_references[0].img_id, "892421142");

  // Fields the reference types as string stay strings even next to integer IDs.
  const modifyRequest = await buildPlatformRequest({
    id: "video.modify", method: "POST", path: "/modify", bodyMode: "json",
  }, {
    payload: { video_media_id: "18446744073709551615", mask_ids: ["7"], img_ids: ["8"], keyframe_id: "1" },
    query: {},
    pathParams: {},
    files: {},
  });
  assert.equal(modifyRequest.body, '{"video_media_id":18446744073709551615,"mask_ids":["7"],"img_ids":[8],"keyframe_id":1}');

  await assert.rejects(buildPlatformRequest({
    id: "video.image", method: "POST", path: "/img", bodyMode: "json",
  }, {
    payload: { img_id: "not-a-number" },
    query: {},
    pathParams: {},
    files: {},
  }), { code: "INVALID_PLATFORM_REQUEST", message: /img_id must be a non-negative integer ID/ });
});

test("upscale media IDs stay strings internally but serialize as lossless JSON numbers", async () => {
  const input = deepFreeze({
    payload: { video_media_id: "426563984800177" },
    query: {},
    pathParams: {},
    files: {},
  });

  const request = await buildPlatformRequest({
    id: "video.upscale", method: "POST", path: "/upscale", bodyMode: "json",
  }, input);

  assert.equal(request.body, '{"video_media_id":426563984800177}');
  assert.equal(input.payload.video_media_id, "426563984800177");
});

test("client and request boundaries reject malformed construction inputs", async () => {
  for (const options of [
    { apiKey: "", baseUrl: BASE_URL, fetchImpl: () => {} },
    { apiKey: TEST_CREDENTIAL, baseUrl: BASE_URL, fetchImpl: null },
    { apiKey: TEST_CREDENTIAL, baseUrl: BASE_URL, fetchImpl: () => {}, traceIdFactory: null },
    { apiKey: TEST_CREDENTIAL, baseUrl: "ftp://example.test", fetchImpl: () => {} },
    { apiKey: TEST_CREDENTIAL, baseUrl: "not a url", fetchImpl: () => {} },
  ]) {
    assert.throws(() => new PlatformClient(options), /required|valid HTTP/i);
  }

  await assert.rejects(buildPlatformRequest({
    id: "fixture.path", method: "GET", path: "/items/{id}", bodyMode: "none",
  }, { payload: {}, query: {}, pathParams: {}, files: {} }), /path parameter/i);
  await assert.rejects(buildPlatformRequest({
    id: "fixture.body", method: "POST", path: "/items", bodyMode: "binary",
  }, { payload: {}, query: {}, pathParams: {}, files: {} }), /body mode/i);
  await assert.rejects(buildPlatformRequest({
    id: "fixture.shape", method: "GET", path: "/items", bodyMode: "none",
  }, { payload: [], query: {}, pathParams: {}, files: {} }), /payload must be an object/i);
  await assert.rejects(buildPlatformRequest(undefined, {}), /operation is required/i);
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function fixture(operationId, name) {
  return parseLosslessJson(await fs.readFile(new URL(`${operationId}/${name}.json`, FIXTURES), "utf8"));
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function assertStringIds(value, key = "") {
  if (Array.isArray(value)) return value.forEach((item) => assertStringIds(item, key.replace(/s$/i, "")));
  if (!value || typeof value !== "object") {
    if (key.toLowerCase() !== "keyframe_id" && /(?:^|_)(?:id|ids)$/i.test(key)) {
      assert.equal(typeof value, "string", `${key} must be lossless`);
    }
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) assertStringIds(childValue, childKey);
}

function toPlainJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
