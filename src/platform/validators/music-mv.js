import { requireFields, validationError } from "./common.js";

// vibe_mv_v3 is the documented legacy workflow; vibe_mv_v3_custom is recommended.
const AGENT_TYPES = new Set(["vibe_mv_v3_custom", "vibe_mv_v3"]);
const ASPECT_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
const QUALITIES = new Set(["720p", "1080p"]);
const MUSIC_STYLES = new Set([
  "pop", "rock", "hip hop", "hiphop", "r&b", "jazz", "reggae", "country", "folk",
  "electronic", "classical", "soul", "funk", "metal", "ambient", "others",
]);
const MV_STYLES = new Set([
  "custom", "cinematic", "lo-fi", "dreamscape", "woolen felt", "candy", "golden age",
  "voxel", "retro game", "claymation", "woodland tale", "impressionism", "decadence",
  "futuristic", "chromatic clash", "holiday",
]);
const BOOLEAN_FIELDS = ["caption_switch", "lip_sync_switch", "instrumental_switch"];
const TEXT_LIMIT = 5_000;
const UINT64_MAX = 18_446_744_073_709_551_615n;

export function normalizeAndValidateMusicMv(operation, payload) {
  const normalized = normalizeImageReferenceAlias(operation, payload);
  requireFields(operation, normalized, ["mv_agent_type", "audio_media_id"]);
  validateExactEnum(operation, "mv_agent_type", normalized.mv_agent_type, AGENT_TYPES);
  validatePositiveDecimalId(operation, "audio_media_id", normalized.audio_media_id);
  // Both are optional; the API defaults to 16:9 and 720p.
  if (normalized.aspect_ratio !== undefined) {
    validateExactEnum(operation, "aspect_ratio", normalized.aspect_ratio, ASPECT_RATIOS);
  }
  if (normalized.quality !== undefined) validateExactEnum(operation, "quality", normalized.quality, QUALITIES);
  validateOptionalStyles(operation, normalized);
  validateReferences(operation, normalized);
  validateOptionalScalars(operation, normalized);
  validateLyrics(operation, normalized);
  return normalized;
}

export function validatePositiveDecimalId(operation, field, value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw validationError(operation, `${field} must be a positive decimal string identifier.`);
  }
  if (BigInt(value) > UINT64_MAX) {
    throw validationError(operation, `${field} must fit within the uint64 range.`);
  }
}

function normalizeImageReferenceAlias(operation, payload) {
  if (payload.img_references !== undefined && payload.image_references !== undefined) {
    throw validationError(operation, "Provide only one of img_references or image_references.");
  }
  if (payload.image_references === undefined) return { ...payload };
  const { image_references, ...rest } = payload;
  return { ...rest, img_references: image_references };
}

function validateOptionalStyles(operation, payload) {
  if (payload.music_style !== undefined) {
    validateCaseInsensitiveEnum(operation, "music_style", payload.music_style, MUSIC_STYLES);
  }
  if (payload.mv_style !== undefined) {
    validateCaseInsensitiveEnum(operation, "mv_style", payload.mv_style, MV_STYLES);
  }
}

function validateReferences(operation, payload) {
  for (const field of ["img_references", "style_img_references"]) {
    const references = payload[field];
    if (references === undefined) continue;
    if (!Array.isArray(references) || references.length > 1) {
      throw validationError(operation, `${field} must be an array containing no more than one reference.`);
    }
    for (const reference of references) validateReference(operation, reference);
  }
  const customStyle = String(payload.mv_style).toLowerCase() === "custom";
  if (!customStyle && (payload.style_img_references?.length ?? 0) > 0) {
    throw validationError(operation, "style_img_references is supported only when mv_style is Custom.");
  }
  if (customStyle) {
    const count = (payload.img_references?.length ?? 0) + (payload.style_img_references?.length ?? 0);
    if (count === 0) throw validationError(operation, "Custom mv_style requires an image or style reference.");
  }
}

function validateReference(operation, reference) {
  if (reference === null || typeof reference !== "object" || Array.isArray(reference)) {
    throw validationError(operation, "Each Music MV image reference must be an object.");
  }
  validatePositiveDecimalId(operation, "img_id", reference.img_id);
  if (reference.ref_name !== undefined && typeof reference.ref_name !== "string") {
    throw validationError(operation, "ref_name must be a string when provided.");
  }
}

function validateOptionalScalars(operation, payload) {
  for (const field of BOOLEAN_FIELDS) {
    if (payload[field] !== undefined && typeof payload[field] !== "boolean") {
      throw validationError(operation, `${field} must be a boolean.`);
    }
  }
  if (payload.seed !== undefined && (!Number.isSafeInteger(payload.seed) || payload.seed < 0)) {
    throw validationError(operation, "seed must be a non-negative safe integer.");
  }
}

function validateLyrics(operation, payload) {
  if (payload.lyric_text !== undefined
    && (typeof payload.lyric_text !== "string" || payload.lyric_text.length >= TEXT_LIMIT)) {
    throw validationError(operation, "lyric_text must be a string shorter than 5,000 characters.");
  }
  if (payload.lyric_timestamp === undefined) return;
  const timestamp = payload.lyric_timestamp;
  if (timestamp === null || typeof timestamp !== "object" || Array.isArray(timestamp)) {
    throw validationError(operation, "lyric_timestamp must be an object.");
  }
  if (!Array.isArray(timestamp.words) || timestamp.words.length === 0 || timestamp.words.length > TEXT_LIMIT) {
    throw validationError(operation, "lyric_timestamp.words must be a non-empty array with at most 5,000 entries.");
  }
  let previousEnd = 0;
  let characterCount = 0;
  for (const [index, entry] of timestamp.words.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw validationError(operation, `lyric_timestamp.words[${index}] must be an object.`);
    }
    if (!Number.isFinite(entry.start) || !Number.isFinite(entry.end)) {
      throw validationError(operation, `lyric_timestamp.words[${index}] start and end must be finite numbers.`);
    }
    if (entry.start < 0) throw validationError(operation, `lyric_timestamp.words[${index}] start must be non-negative.`);
    if (entry.end < entry.start) throw validationError(operation, `lyric_timestamp.words[${index}] end must not precede start.`);
    if (index > 0 && entry.start < previousEnd) {
      throw validationError(operation, "lyric_timestamp words must be monotonic and must not overlap.");
    }
    if (typeof entry.word !== "string" || entry.word.trim() === "") {
      throw validationError(operation, `lyric_timestamp.words[${index}].word must be a non-empty string.`);
    }
    characterCount += entry.word.length;
    if (characterCount >= TEXT_LIMIT) {
      throw validationError(operation, "Concatenated lyric_timestamp words must be shorter than 5,000 characters.");
    }
    previousEnd = entry.end;
  }
}

function validateExactEnum(operation, field, value, allowed) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw validationError(operation, `${field} must be one of ${[...allowed].join(", ")}.`);
  }
}

function validateCaseInsensitiveEnum(operation, field, value, allowed) {
  if (typeof value !== "string" || !allowed.has(value.toLowerCase())) {
    throw validationError(operation, `${field} contains an unsupported value.`);
  }
}
