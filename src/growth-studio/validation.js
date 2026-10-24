export const VIDEO_DURATIONS = Object.freeze([15, 30, 45, 60]);
export const VIDEO_RESOLUTIONS = Object.freeze(["480p", "720p", "1080p"]);
export const AVATAR_MODES = Object.freeze(["auto", "custom", "disabled"]);
export const VIDEO_STATUSES = Object.freeze(["queued", "processing", "succeeded", "failed", "canceled"]);
export const VIDEO_LANGUAGES = Object.freeze([
  "en-AU", "pt-BR", "es-BR", "en-CA", "fr-CA", "zh-CN", "es-CO", "fr-FR", "de-DE", "hi-IN",
  "en-IN", "id-ID", "it-IT", "ja-JP", "ms-MY", "es-MX", "nl-NL", "en-NL", "fil-PH", "en-PH",
  "pl-PL", "ru-RU", "en-SG", "ko-KR", "es-ES", "de-CH", "fr-CH", "it-CH", "zh-TW", "th-TH",
  "en-TH", "tr-TR", "ar-AE", "en-AE", "en-GB", "en-US", "es-US", "vi-VN",
]);
export const MAX_PRODUCT_IMAGES = 6;
export const MAX_EDIT_CLIP_INDEX = 40;
export const MAX_EDIT_INSTRUCTION_LENGTH = 500;
export const MAX_LIST_LIMIT = 100;
// The live API accepts only kind=uploaded (kind=product returns 400 INVALID_REQUEST).
export const VIDEO_LIST_KINDS = Object.freeze(["uploaded"]);

const LANGUAGE_SET = new Set(VIDEO_LANGUAGES);
const STATUS_SET = new Set(VIDEO_STATUSES);
const UPLOADED_IMAGE_PREFIX = "https://media.pixverse.ai/";

export function validateCreatePayload(payload) {
  if (!isRecord(payload)) throw new Error("Create payload must be an object.");
  if (payload.folder_id !== undefined) {
    throw new Error("folder_id belongs at video.folder_id, not at the top level of the create payload.");
  }
  validateProduct(payload.product);
  validateVideo(payload.video);
  if (payload.metadata !== undefined) validateMetadata(payload.metadata);
}

export function validateEditPayload(payload) {
  if (!isRecord(payload)) throw new Error("Edit payload must be an object.");
  if (
    !Number.isInteger(payload.clip_index)
    || payload.clip_index < 1
    || payload.clip_index > MAX_EDIT_CLIP_INDEX
  ) {
    throw new Error(`clip_index must be a one-based integer from 1 through ${MAX_EDIT_CLIP_INDEX}.`);
  }
  if (typeof payload.instruction !== "string" || !payload.instruction.trim()) {
    throw new Error("instruction is required.");
  }
  if (payload.instruction.length > MAX_EDIT_INSTRUCTION_LENGTH) {
    throw new Error(`instruction must be at most ${MAX_EDIT_INSTRUCTION_LENGTH} characters.`);
  }
}

export function validateFolderPayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Folder payload must be an object.");
  if (!payload.name || typeof payload.name !== "string" || !payload.name.trim()) {
    throw new Error("Folder payload requires a non-empty name.");
  }
}

export function validateListVideosOptions(options = {}) {
  if (options.limit !== undefined) {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIST_LIMIT) {
      throw new Error(`limit must be an integer from 1 through ${MAX_LIST_LIMIT}.`);
    }
  }
  if (options.status !== undefined && !STATUS_SET.has(options.status)) {
    throw new Error(`status must be one of: ${VIDEO_STATUSES.join(", ")}.`);
  }
  if (options.cursor !== undefined && typeof options.cursor !== "string") {
    throw new Error("cursor must be a string.");
  }
  if (options.kind !== undefined && !VIDEO_LIST_KINDS.includes(options.kind)) {
    throw new Error(`kind must be one of: ${VIDEO_LIST_KINDS.join(", ")}.`);
  }
}

export function assertVideoId(videoId) {
  if (typeof videoId !== "string" || !/^\d+$/.test(videoId)) {
    throw new Error("video_id must be a numeric string.");
  }
}

export function assertFolderId(folderId) {
  if (typeof folderId !== "string" || !/^\d+$/.test(folderId)) {
    throw new Error("folder_id must be a numeric string.");
  }
}

function validateProduct(product) {
  if (!isRecord(product)) throw new Error("Create payload requires product.");

  const hasSourceUrl = product.source_url !== undefined;
  if (hasSourceUrl) assertHttpUrl(product.source_url, "product.source_url", 2048);

  if (product.title !== undefined || !hasSourceUrl) {
    assertNonEmptyString(product.title, "product.title", 255, hasSourceUrl ? "" : " when product.source_url is omitted");
  }
  assertOptionalString(product.description, "product.description", 5120);
  assertOptionalString(product.brand, "product.brand", 255);

  if (product.price !== undefined) {
    if (!isRecord(product.price)) throw new Error("product.price must be an object.");
    if (typeof product.price.amount !== "string" || !product.price.amount.trim()) {
      throw new Error("product.price.amount must be a non-empty string such as \"89.99\".");
    }
    if (typeof product.price.currency !== "string" || !/^[A-Za-z]{3}$/.test(product.price.currency)) {
      throw new Error("product.price.currency must be a three-letter currency code.");
    }
  }

  if (product.images === undefined) {
    if (!hasSourceUrl) {
      throw new Error("Create payload requires product.source_url or product.images from the upload endpoint.");
    }
    return;
  }
  if (!Array.isArray(product.images)) throw new Error("product.images must be an array.");
  if (!hasSourceUrl && product.images.length === 0) {
    throw new Error("product.images requires at least one uploaded image when product.source_url is omitted.");
  }
  if (product.images.length > MAX_PRODUCT_IMAGES) {
    throw new Error(`product.images accepts at most ${MAX_PRODUCT_IMAGES} images.`);
  }
  for (const image of product.images) {
    if (!isRecord(image) || typeof image.url !== "string" || !image.url.startsWith(UPLOADED_IMAGE_PREFIX)) {
      throw new Error("Product images must use URLs returned by the image upload endpoint.");
    }
  }
}

function validateVideo(video) {
  if (!isRecord(video)) throw new Error("Create payload requires video.");

  assertNonEmptyString(video.aspect_ratio, "video.aspect_ratio", Number.MAX_SAFE_INTEGER);
  if (!VIDEO_DURATIONS.includes(video.duration_seconds)) {
    throw new Error(`video.duration_seconds must be one of: ${VIDEO_DURATIONS.join(", ")}.`);
  }
  if (typeof video.resolution !== "string" || !VIDEO_RESOLUTIONS.includes(video.resolution.toLowerCase())) {
    throw new Error(`video.resolution must be one of: ${VIDEO_RESOLUTIONS.join(", ")}.`);
  }
  if (!LANGUAGE_SET.has(video.language)) {
    throw new Error("video.language must be one of the documented language codes, such as en-US.");
  }
  for (const field of ["voiceover", "captions", "background_music"]) {
    if (typeof video[field] !== "boolean") throw new Error(`video.${field} must be a boolean.`);
  }

  if (!isRecord(video.avatar)) throw new Error("video.avatar must be an object.");
  if (!AVATAR_MODES.includes(video.avatar.mode)) {
    throw new Error(`video.avatar.mode must be one of: ${AVATAR_MODES.join(", ")}.`);
  }
  if (video.avatar.mode === "custom") {
    if (typeof video.avatar.url !== "string" || !video.avatar.url.trim()) {
      throw new Error("video.avatar.url is required when video.avatar.mode is custom.");
    }
  } else if (video.avatar.url !== undefined) {
    throw new Error(`video.avatar.url must be omitted when video.avatar.mode is ${video.avatar.mode}.`);
  }

  assertOptionalString(video.creative_ad_clone, "video.creative_ad_clone", Number.MAX_SAFE_INTEGER);
  assertOptionalString(video.subtitles_size_mode, "video.subtitles_size_mode", Number.MAX_SAFE_INTEGER);
  if (video.folder_id !== undefined) assertFolderId(video.folder_id);
}

function validateMetadata(metadata) {
  if (!isRecord(metadata)) throw new Error("metadata must be an object of string values.");
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== "string") throw new Error(`metadata.${key} must be a string.`);
  }
}

function assertHttpUrl(value, label, maximumLength) {
  if (typeof value !== "string" || !value || value.length > maximumLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maximumLength} characters.`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTP or HTTPS URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must be an HTTP or HTTPS URL.`);
  }
}

function assertNonEmptyString(value, label, maximumLength, condition = "") {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required${condition}.`);
  }
  if (value.length > maximumLength) {
    throw new Error(`${label} must be at most ${maximumLength} characters.`);
  }
}

function assertOptionalString(value, label, maximumLength) {
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  if (value.length > maximumLength) {
    throw new Error(`${label} must be at most ${maximumLength} characters.`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const IMAGE_LIST_OPTION_FIELDS = new Set(["offset", "limit", "traceId"]);

// GET /openapi/v1/images is undocumented (observed live 2026-10-23). It uses
// ledger-style offset pagination; the server's exact limits are unverified, so the
// CLI applies the documented wallet-ledger bounds (offset >= 0, limit 1-100).
export function normalizeImageListOptions(options = {}) {
  if (!isRecord(options)) throw new TypeError("Image list options must be a plain object.");
  for (const field of Object.keys(options)) {
    if (!IMAGE_LIST_OPTION_FIELDS.has(field)) throw new Error(`Unknown image list option: ${field}.`);
  }
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be a safe integer of at least 0.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new RangeError(`limit must be a safe integer from 1 through ${MAX_LIST_LIMIT}.`);
  }
  return { offset, limit };
}
