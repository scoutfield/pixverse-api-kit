export const VIRAL_CLONE_CREATE_ROUTE = "/viral-clone/runs";
export const VIRAL_CLONE_CREATE_PATH = `/openapi/v1${VIRAL_CLONE_CREATE_ROUTE}`;
export const VIDEO_IMPORT_ROUTE = "/video/upload";
export const VIDEO_IMPORT_PATH = `/openapi/v1${VIDEO_IMPORT_ROUTE}`;
export const MAX_VIRAL_CLONE_BODY_BYTES = 1024 * 1024;
export const VIRAL_CLONE_MODELS = Object.freeze(["standard", "plus", "pro"]);
export const VIRAL_CLONE_ASPECT_RATIOS = Object.freeze(["1:1", "9:16", "16:9", "3:4", "4:3", "21:9"]);
export const VIRAL_CLONE_RESOLUTIONS = Object.freeze({
  standard: Object.freeze(["768p", "1440p"]),
  plus: Object.freeze(["480p", "720p", "1080p"]),
  pro: Object.freeze(["480p", "720p", "1080p"]),
});
export const VIRAL_CLONE_BGM_MODES = Object.freeze(["model_direct", "independent"]);
export const VIRAL_CLONE_AVATAR_MODES = Object.freeze(["custom", "disabled"]);
export const VIRAL_CLONE_RUN_STATUSES = Object.freeze(["processing", "succeeded", "failed"]);
export const MAX_VIRAL_CLONE_IMAGES = 10;

const ROOT_FIELDS = new Set(["source_video_id", "model", "script_language", "listing", "video", "avatar"]);
const LISTING_FIELDS = new Set(["listing_id", "title", "description", "brand", "image_info"]);
const IMAGE_INFO_FIELDS = new Set(["items"]);
const IMAGE_ITEM_FIELDS = new Set(["url", "sort"]);
const VIDEO_FIELDS = new Set(["aspect_ratio", "resolution", "language", "bgm_mode"]);
const SERVER_MANAGED_VIDEO_FIELDS = new Set(["duration_seconds", "voiceover", "captions"]);
const AVATAR_FIELDS = new Set(["mode", "url", "avatar_id"]);
const DECIMAL_ID = /^\d+$/;
// Loose BCP 47 shape check: primary language subtag plus optional subtags (en-US, zh-Hans-CN).
const BCP47 = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export function validateViralClonePayload(payload) {
  assertPlainObject(payload, "Viral Clone payload");
  assertKnownFields(payload, ROOT_FIELDS, "Viral Clone");

  assertDecimalString(payload.source_video_id, "source_video_id");
  if (typeof payload.model !== "string" || !VIRAL_CLONE_MODELS.includes(payload.model)) {
    throw new Error(`model must be one of: ${VIRAL_CLONE_MODELS.join(", ")} (case-sensitive).`);
  }
  assertLanguage(payload.script_language, "script_language");
  validateListing(payload.listing);
  validateVideo(payload.video, payload.model);
  if (payload.avatar !== undefined) validateAvatar(payload.avatar);
}

export function normalizeViralClonePayload(payload) {
  validateViralClonePayload(payload);
  const normalized = {
    source_video_id: payload.source_video_id,
    model: payload.model,
    script_language: payload.script_language,
    listing: normalizeListing(payload.listing),
    video: pickDefined(payload.video, ["aspect_ratio", "resolution", "language", "bgm_mode"]),
    ...(payload.avatar === undefined
      ? {}
      : { avatar: pickDefined(payload.avatar, ["mode", "url", "avatar_id"]) }),
  };
  const bytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (bytes > MAX_VIRAL_CLONE_BODY_BYTES) {
    throw new Error(`Viral Clone request body must be at most ${MAX_VIRAL_CLONE_BODY_BYTES} bytes (1 MiB).`);
  }
  return normalized;
}

export function describeViralCloneDryRun(payload) {
  return {
    capability: "viral-clone",
    billable: false,
    method: "POST",
    path: VIRAL_CLONE_CREATE_PATH,
    body: normalizeViralClonePayload(payload),
  };
}

export function assertRunId(runId) {
  if (typeof runId !== "string" || !DECIMAL_ID.test(runId)) {
    throw new Error("run_id must be a decimal string.");
  }
}

// Normalizes a create-response run_id to a decimal string. Small IDs arrive as JSON
// numbers (json-bigint keeps only unsafe integers as strings), so accept a safe
// non-negative integer and stringify it rather than losing a charged run.
export function readRunIdentifier(value) {
  if (typeof value === "string" && DECIMAL_ID.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

export function runIdFromLocation(location) {
  if (typeof location !== "string") return undefined;
  const match = /\/viral-clone\/runs\/(\d+)\/?(?:[?#].*)?$/.exec(location);
  return match?.[1];
}

export function validateVideoImportUrl(url) {
  assertHttpUrl(url, "url");
}

function validateListing(listing) {
  assertPlainObject(listing, "listing");
  assertKnownFields(listing, LISTING_FIELDS, "listing");

  const hasListingId = listing.listing_id !== undefined;
  if (hasListingId && (typeof listing.listing_id !== "string" || !listing.listing_id.trim())) {
    throw new Error("listing.listing_id must be a non-empty string.");
  }

  if (!hasListingId || listing.title !== undefined) {
    if (typeof listing.title !== "string" || !listing.title.trim()) {
      throw new Error("listing.title is required when listing.listing_id is omitted.");
    }
    if (listing.title.length > 255) throw new Error("listing.title must be at most 255 characters.");
  }
  assertOptionalString(listing.description, "listing.description", 5_120);
  assertOptionalString(listing.brand, "listing.brand", 255);

  if (listing.image_info === undefined) {
    if (!hasListingId) {
      throw new Error("listing.image_info.items is required when listing.listing_id is omitted.");
    }
    return;
  }
  assertPlainObject(listing.image_info, "listing.image_info");
  assertKnownFields(listing.image_info, IMAGE_INFO_FIELDS, "listing.image_info");
  const { items } = listing.image_info;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_VIRAL_CLONE_IMAGES) {
    throw new Error(`listing.image_info.items must contain 1 to ${MAX_VIRAL_CLONE_IMAGES} images.`);
  }
  items.forEach((item, index) => {
    const label = `listing.image_info.items[${index}]`;
    assertPlainObject(item, label);
    assertKnownFields(item, IMAGE_ITEM_FIELDS, label);
    assertHttpUrl(item.url, `${label}.url`);
    if (item.sort !== undefined && !Number.isSafeInteger(item.sort)) {
      throw new Error(`${label}.sort must be an integer.`);
    }
  });
}

function validateVideo(video, model) {
  assertPlainObject(video, "video");
  for (const field of Object.keys(video)) {
    if (SERVER_MANAGED_VIDEO_FIELDS.has(field)) {
      throw new Error(`video.${field} is not accepted: Viral Clone duration, voiceover, and captions are server-managed.`);
    }
  }
  assertKnownFields(video, VIDEO_FIELDS, "video");

  // The guide (section 16.5) marks aspect_ratio, resolution, and language as required.
  if (!VIRAL_CLONE_ASPECT_RATIOS.includes(video.aspect_ratio)) {
    throw new Error(`video.aspect_ratio is required and must be one of: ${VIRAL_CLONE_ASPECT_RATIOS.join(", ")}.`);
  }
  const allowedResolutions = VIRAL_CLONE_RESOLUTIONS[model];
  if (typeof video.resolution !== "string" || !allowedResolutions.includes(video.resolution)) {
    throw new Error(`video.resolution is required; for model ${model} use one of: ${allowedResolutions.join(", ")} (lowercase).`);
  }
  assertLanguage(video.language, "video.language");
  if (video.bgm_mode !== undefined && !VIRAL_CLONE_BGM_MODES.includes(video.bgm_mode)) {
    throw new Error(`video.bgm_mode must be one of: ${VIRAL_CLONE_BGM_MODES.join(", ")}.`);
  }
}

function validateAvatar(avatar) {
  assertPlainObject(avatar, "avatar");
  assertKnownFields(avatar, AVATAR_FIELDS, "avatar");
  if (!VIRAL_CLONE_AVATAR_MODES.includes(avatar.mode)) {
    throw new Error(`avatar.mode must be one of: ${VIRAL_CLONE_AVATAR_MODES.join(", ")}.`);
  }
  const hasUrl = avatar.url !== undefined;
  const hasAvatarId = avatar.avatar_id !== undefined;
  if (avatar.mode === "disabled") {
    if (hasUrl || hasAvatarId) throw new Error("avatar.url and avatar.avatar_id must be omitted when avatar.mode is disabled.");
    return;
  }
  if (hasUrl === hasAvatarId) {
    throw new Error("avatar.mode custom requires exactly one of avatar.url or avatar.avatar_id.");
  }
  if (hasUrl) assertHttpUrl(avatar.url, "avatar.url");
  else if (typeof avatar.avatar_id !== "string" || !avatar.avatar_id.trim()) {
    throw new Error("avatar.avatar_id must be a non-empty string.");
  }
}

function normalizeListing(listing) {
  const output = pickDefined(listing, ["listing_id", "title", "description", "brand"]);
  if (listing.image_info !== undefined) {
    output.image_info = {
      items: listing.image_info.items.map((item) => pickDefined(item, ["url", "sort"])),
    };
  }
  return output;
}

function pickDefined(source, fields) {
  const output = {};
  for (const field of fields) {
    if (source[field] !== undefined) output[field] = source[field];
  }
  return output;
}

function assertDecimalString(value, label) {
  if (typeof value !== "string" || !DECIMAL_ID.test(value)) {
    throw new Error(`${label} must be a decimal string such as "627410861853514292".`);
  }
}

function assertLanguage(value, label) {
  if (typeof value !== "string" || !BCP47.test(value)) {
    throw new Error(`${label} must be a BCP 47 language tag such as en-US.`);
  }
}

function assertHttpUrl(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty HTTP or HTTPS URL.`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not include credentials.`);
}

function assertOptionalString(value, label, maximumLength) {
  if (value !== undefined && (typeof value !== "string" || value.length > maximumLength)) {
    throw new Error(`${label} must be a string of at most ${maximumLength} characters.`);
  }
}

function assertPlainObject(value, label) {
  const prototype = value === null || typeof value !== "object" ? null : Object.getPrototypeOf(value);
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)
  ) {
    throw new Error(`${label} must be a plain object.`);
  }
}

function assertKnownFields(value, allowedFields, label) {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) throw new Error(`Unknown ${label} field: ${field}.`);
  }
}
