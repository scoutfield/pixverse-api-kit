import fs from "node:fs";
import path from "node:path";
import JSONBigFactory from "json-bigint";

import { PixverseCliError } from "../core/errors.js";

const PATH_PARAMETER = /\{([^}]+)\}/g;
const JSON_BIG = JSONBigFactory({
  useNativeBigInt: true,
  protoAction: "error",
  constructorAction: "error",
});

export async function buildPlatformRequest(operation, normalizedInput) {
  assertRequestInputs(operation, normalizedInput);
  const requestPath = interpolatePath(operation, normalizedInput.pathParams);
  const query = operation.bodyMode === "none"
    ? { ...normalizedInput.payload, ...normalizedInput.query }
    : normalizedInput.query;
  const pathWithQuery = appendQuery(requestPath, query);
  const headers = new Headers();
  let body;

  if (operation.bodyMode === "json") {
    headers.set("Content-Type", "application/json");
    body = serializeJsonBody(operation, normalizedInput.payload);
  } else if (operation.bodyMode === "multipart") {
    body = await buildMultipartBody(normalizedInput);
  } else if (operation.bodyMode !== "none") {
    throw requestError(operation, `Unsupported Platform body mode: ${operation.bodyMode}.`);
  }

  return {
    method: operation.method,
    path: pathWithQuery,
    headers,
    body,
  };
}

function serializeJsonBody(operation, payload) {
  if (!new Set(["audio.verify", "agent.music-mv", "video.fusion", "video.upscale"]).has(operation.id)) {
    return JSON.stringify(payload);
  }
  const wirePayload = { ...payload };
  if (operation.id === "agent.music-mv" && wirePayload.img_references !== undefined) {
    wirePayload.image_references = wirePayload.img_references;
    delete wirePayload.img_references;
  }
  if (wirePayload.audio_media_id !== undefined) {
    wirePayload.audio_media_id = decimalStringToBigInt(wirePayload.audio_media_id);
  }
  for (const field of ["img_references", "image_references", "style_img_references"]) {
    if (!Array.isArray(wirePayload[field])) continue;
    wirePayload[field] = wirePayload[field].map((reference) => ({
      ...reference,
      img_id: decimalStringToBigInt(reference.img_id),
    }));
  }
  for (const field of ["source_video_id", "video_media_id"]) {
    if (wirePayload[field] !== undefined) {
      wirePayload[field] = decimalStringToBigInt(wirePayload[field]);
    }
  }
  return JSON_BIG.stringify(wirePayload);
}

function decimalStringToBigInt(value) {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) ? BigInt(value) : value;
}

function interpolatePath(operation, pathParams) {
  return operation.path.replace(PATH_PARAMETER, (_, name) => {
    const value = pathParams[name];
    if (typeof value !== "string" || value === "") {
      throw requestError(operation, `Missing normalized path parameter: ${name}.`);
    }
    return encodeURIComponent(value);
  });
}

function appendQuery(requestPath, query) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(name, serializeField(item));
    } else {
      search.append(name, serializeField(value));
    }
  }
  const suffix = search.toString();
  return suffix === "" ? requestPath : `${requestPath}?${suffix}`;
}

async function buildMultipartBody(normalizedInput) {
  const form = new FormData();
  for (const [name, value] of Object.entries(normalizedInput.payload)) {
    if (value !== undefined && value !== null) form.append(name, serializeField(value));
  }
  for (const [name, filePath] of Object.entries(normalizedInput.files)) {
    const blob = await fs.openAsBlob(filePath);
    form.append(name, blob, path.basename(filePath));
  }
  return form;
}

function serializeField(value) {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function assertRequestInputs(operation, normalizedInput) {
  if (!operation || typeof operation !== "object") {
    throw new TypeError("A Platform operation is required.");
  }
  for (const name of ["payload", "query", "pathParams", "files"]) {
    const value = normalizedInput?.[name];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw requestError(operation, `Normalized Platform ${name} must be an object.`);
    }
  }
}

function requestError(operation, message) {
  return new PixverseCliError(message, {
    category: "validation",
    provider: "platform",
    operation: operation?.id,
    code: "INVALID_PLATFORM_REQUEST",
    retryable: false,
  });
}
