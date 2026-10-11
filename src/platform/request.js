import fs from "node:fs";
import path from "node:path";
import JSONBigFactory from "json-bigint";

import { PixverseCliError } from "../core/errors.js";

const PATH_PARAMETER = /\{([^}]+)\}/g;
// The template list documents template_ids as one comma-separated string.
const COMMA_SEPARATED_QUERY = new Set(["template_ids"]);
// Upload endpoints accept only these MIME types; an untyped Blob is sent as
// application/octet-stream, which the image upload reference rejects.
const UPLOAD_MIME_TYPES = new Map(Object.entries({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/x-m4a",
  ".aac": "audio/aac",
}));
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

// Fields each operation's API reference types as integer. The validators keep
// identifiers as decimal strings so 64-bit values stay exact; they are turned
// back into JSON integers here. Fields typed as string (mask_id, mask_ids,
// lip_sync_tts_speaker_id, webhook_id, fusion video_references, image.template
// img_ids) are deliberately absent.
const VIDEO_SOURCE_IDS = ["source_video_id", "video_media_id"];
const INTEGER_ID_FIELDS = new Map(Object.entries({
  "audio.verify": ["audio_media_id"],
  "voice.create": ["audio_media_id"],
  "image.template": ["template_id"],
  "video.text": ["template_id"],
  "video.image": ["img_id", "template_id"],
  "video.template": ["img_id", "img_ids[]", "template_id"],
  "video.transition": ["first_frame_img", "last_frame_img"],
  "video.multi-transition": ["multi_transition[].img_id"],
  "video.lip-sync": [...VIDEO_SOURCE_IDS, "audio_media_id"],
  "video.fusion": ["image_references[].img_id"],
  "video.avatar": ["img_id", "audio_media_id"],
  "video.restyle": [...VIDEO_SOURCE_IDS, "restyle_id"],
  "video.swap-mask": [...VIDEO_SOURCE_IDS, "keyframe_id"],
  "video.swap": [...VIDEO_SOURCE_IDS, "keyframe_id", "img_id"],
  "video.sound-effect": VIDEO_SOURCE_IDS,
  "video.extend": [...VIDEO_SOURCE_IDS, "template_id"],
  "video.motion-control": [...VIDEO_SOURCE_IDS, "img_id"],
  "video.modify": [...VIDEO_SOURCE_IDS, "img_ids[]", "keyframe_id"],
  "video.upscale": VIDEO_SOURCE_IDS,
  "agent.viral-recreation": [
    "agent_id",
    "img_references[].img_id",
    "video_references[].video_media_id",
    "video_references[].source_video_id",
  ],
  "agent.real-estate": ["agent_id", "img_references[].img_id"],
  "agent.music-mv": ["audio_media_id", "image_references[].img_id", "style_img_references[].img_id"],
}));

export function integerIdFields(operationId) {
  return INTEGER_ID_FIELDS.get(operationId) ?? [];
}

function serializeJsonBody(operation, payload) {
  const fields = INTEGER_ID_FIELDS.get(operation.id);
  if (!fields) return JSON.stringify(payload);
  const wirePayload = { ...payload };
  if (operation.id === "agent.music-mv" && wirePayload.img_references !== undefined) {
    wirePayload.image_references = wirePayload.img_references;
    delete wirePayload.img_references;
  }
  for (const field of fields) convertIntegerPath(operation, wirePayload, field.split("."), field);
  return JSON_BIG.stringify(wirePayload);
}

function convertIntegerPath(operation, container, [segment, ...rest], label) {
  const isArray = segment.endsWith("[]");
  const key = isArray ? segment.slice(0, -2) : segment;
  if (container === null || typeof container !== "object" || container[key] === undefined) return;
  if (isArray) {
    if (!Array.isArray(container[key])) return;
    container[key] = container[key].map((item) => {
      if (rest.length === 0) return toWireInteger(operation, label, item);
      if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
      const copy = { ...item };
      convertIntegerPath(operation, copy, rest, label);
      return copy;
    });
    return;
  }
  if (rest.length === 0) {
    container[key] = toWireInteger(operation, label, container[key]);
    return;
  }
  if (container[key] === null || typeof container[key] !== "object") return;
  container[key] = Array.isArray(container[key]) ? [...container[key]] : { ...container[key] };
  convertIntegerPath(operation, container[key], rest, label);
}

function toWireInteger(operation, field, value) {
  if (value === null || value === "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw requestError(operation, `${field} must be a non-negative integer ID.`);
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
    if (Array.isArray(value) && COMMA_SEPARATED_QUERY.has(name)) {
      search.append(name, value.map(serializeField).join(","));
    } else if (Array.isArray(value)) {
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
    const type = UPLOAD_MIME_TYPES.get(path.extname(filePath).toLowerCase());
    const blob = await fs.openAsBlob(filePath, type ? { type } : undefined);
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
