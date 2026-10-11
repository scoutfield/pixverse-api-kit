import {
  isPresent,
  requireExactlyOneField,
  requireFields,
  validateModelScalars,
  validateSafeRemoteUrl,
  validationError,
} from "./common.js";
import { inspectLocalMedia as inspectMedia } from "../../core/media.js";
import { normalizeAndValidateMusicMv, validatePositiveDecimalId } from "./music-mv.js";

const VIDEO_SOURCES = ["source_video_id", "video_media_id"];
const EXTEND_MODELS = ["v3.5", "v4", "v4.5", "v5", "v5.5", "v6"];
const SEED_MAXIMUM = 2_147_483_647;

export async function validateSpecializedOperation(operation, payload, query = payload, context = {}) {
  switch (operation.id) {
    case "account.balance": return;
    case "account.usage": return validateUsage(operation, payload);
    case "audio.verify":
      requireFields(operation, payload, ["audio_media_id"]);
      validatePositiveDecimalId(operation, "audio_media_id", payload.audio_media_id);
      return;
    case "resource.templates": return validateTemplateQuery(operation, query);
    case "resource.tts-speakers": return validateTtsQuery(operation, query);
    case "resource.restyle-effects":
      requireFields(operation, query, ["page_num", "page_size"]);
      validatePositiveInteger(operation, query.page_num, "page_num");
      validatePositiveInteger(operation, query.page_size, "page_size");
      return;
    case "voice.create":
      requireFields(operation, payload, ["name", "audio_media_id"]);
      return;
    case "image.template":
      requireFields(operation, payload, ["img_ids", "template_id"]);
      if (!Array.isArray(payload.img_ids) || payload.img_ids.length === 0) throw validationError(operation, "img_ids must contain at least one image identifier.");
      return;
    case "video.restyle":
      requireExactlyOneField(operation, payload, VIDEO_SOURCES);
      requireExactlyOneField(operation, payload, ["restyle_id", "restyle_prompt"]);
      validateOptionalSeed(operation, payload.seed);
      return;
    case "video.swap-mask":
      requireExactlyOneField(operation, payload, VIDEO_SOURCES);
      validateKeyframe(operation, payload.keyframe_id, false);
      return;
    case "video.swap":
      requireExactlyOneField(operation, payload, VIDEO_SOURCES);
      requireFields(operation, payload, ["keyframe_id", "mask_id", "img_id", "quality"]);
      validateKeyframe(operation, payload.keyframe_id, true);
      validateQuality(operation, payload.quality, ["360p", "540p", "720p"]);
      return;
    case "video.sound-effect":
      requireExactlyOneField(operation, payload, VIDEO_SOURCES);
      // The API has no prompt field; the sound description is sound_effect_content.
      if (payload.prompt !== undefined) {
        throw validationError(operation, "sound-effect has no prompt field; describe the sound with sound_effect_content.");
      }
      if (payload.sound_effect_content !== undefined && typeof payload.sound_effect_content !== "string") {
        throw validationError(operation, "sound_effect_content must be a string.");
      }
      if (payload.original_sound_switch !== undefined && typeof payload.original_sound_switch !== "boolean") {
        throw validationError(operation, "original_sound_switch must be a boolean.");
      }
      return;
    case "video.extend":
      requireExactlyOneField(operation, payload, VIDEO_SOURCES);
      requireFields(operation, payload, ["prompt", "seed", "quality", "duration", "model"]);
      if (!EXTEND_MODELS.includes(payload.model)) {
        throw validationError(operation, `extend model must be one of ${EXTEND_MODELS.join(", ")}.`);
      }
      validateModelScalars(operation, payload);
      return;
    case "video.motion-control":
      requireExactlyOneField(operation, payload, VIDEO_SOURCES);
      requireFields(operation, payload, ["img_id", "quality"]);
      validateQuality(operation, payload.quality, ["360p", "540p", "720p"]);
      return;
    case "video.modify":
      requireExactlyOneField(operation, payload, VIDEO_SOURCES);
      requireFields(operation, payload, ["prompt", "quality"]);
      validateQuality(operation, payload.quality, ["360p", "540p", "720p"]);
      validateMaximumItems(operation, payload.mask_ids, "mask_ids", 3);
      validateMaximumItems(operation, payload.mask_urls, "mask_urls", 3);
      return;
    case "video.upscale":
      requireExactlyOneField(operation, payload, VIDEO_SOURCES);
      for (const field of VIDEO_SOURCES) {
        if (isPresent(payload[field])) validatePositiveDecimalId(operation, field, payload[field]);
      }
      return;
    case "agent.viral-recreation": return validateViralAgent(operation, payload, context);
    case "agent.real-estate": return validateRealEstateAgent(operation, payload);
    case "agent.music-mv": return normalizeAndValidateMusicMv(operation, payload);
    default: throw validationError(operation, `No specialized validator exists for ${operation.id}.`);
  }
}

function validateUsage(operation, payload) {
  if (isPresent(payload.cursor)) return;
  const pattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  for (const name of ["start_time", "end_time"]) {
    if (isPresent(payload[name]) && (typeof payload[name] !== "string" || !pattern.test(payload[name]))) throw validationError(operation, `${name} must use YYYY-MM-DD HH:mm:ss in UTC.`);
  }
  if (isPresent(payload.start_time) && isPresent(payload.end_time)) {
    const start = parseUtcTimestamp(payload.start_time);
    const end = parseUtcTimestamp(payload.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw validationError(operation, "start_time must not be later than end_time.");
    if (end - start > 30 * 86400_000) throw validationError(operation, "The usage time range must not exceed 30 days.");
  }
  if (payload.limit !== undefined && (!Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 100)) throw validationError(operation, "limit must be an integer from 1 to 100.");
  if (payload.credits_status !== undefined && !["consume", "refund"].includes(payload.credits_status)) throw validationError(operation, "credits_status must be consume or refund.");
  const creationTypes = ["text_to_video", "image_to_video", "transition", "lip_sync", "extend", "sound_effect", "fusion", "restyle", "multi_transition", "swap", "agent", "swap_mask", "avatar", "image_to_image", "mimic", "modify", "upscale"];
  if (payload.creation_type !== undefined && (!Array.isArray(payload.creation_type) || payload.creation_type.some((item) => !creationTypes.includes(item)))) throw validationError(operation, "creation_type contains an unsupported operation type.");
}

function validateTemplateQuery(operation, query) {
  if (query.type !== undefined && ![1, 2, "1", "2"].includes(query.type)) throw validationError(operation, "type must be 1 or 2.");
  // The reference types these query values as strings, e.g. page "1" and pageSize "50".
  if (query.page !== undefined) validatePositiveInteger(operation, toIntegerOrSelf(query.page), "page");
  if (query.pageSize !== undefined && ![10, 20, 50, 100].includes(toIntegerOrSelf(query.pageSize))) throw validationError(operation, "pageSize must be 10, 20, 50, or 100.");
}

function validateTtsQuery(operation, query) {
  if (query.page_num !== undefined) validatePositiveInteger(operation, query.page_num, "page_num");
  if (query.page_size !== undefined && ![10, 20, 50, 100].includes(query.page_size)) throw validationError(operation, "page_size must be 10, 20, 50, or 100.");
  if (query.speaker_type !== undefined && !["system", "custom", "all"].includes(query.speaker_type)) throw validationError(operation, "speaker_type must be system, custom, or all.");
}

async function validateViralAgent(operation, payload, context) {
  requireFields(operation, payload, ["agent_id", "prompt", "img_references", "video_references"]);
  if (payload.agent_id !== "414562414124109") throw validationError(operation, "viral recreation agent_id must be 414562414124109.");
  validateModelScalars(operation, payload, { qualities: ["720p", "1080p"], aspectRatios: ["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"] });
  if (!Array.isArray(payload.img_references) || payload.img_references.length < 1 || payload.img_references.length > 5) throw validationError(operation, "img_references must contain between 1 and 5 images.");
  if (!Array.isArray(payload.video_references) || payload.video_references.length !== 1) throw validationError(operation, "video_references must contain exactly one video.");
  // Each reference must carry an uploaded asset ID; the API has no URL or file fields here.
  payload.img_references.forEach((reference, index) => {
    if (!isReferenceObject(reference) || !isPresent(reference.img_id)) {
      throw validationError(operation, `img_references[${index}] requires an img_id from upload image.`);
    }
  });
  payload.video_references.forEach((reference, index) => {
    if (!isReferenceObject(reference)) throw validationError(operation, `video_references[${index}] must be an object.`);
    requireExactlyOneField(operation, reference, VIDEO_SOURCES, `video_references[${index}] source_video_id or video_media_id`);
  });
  const inspector = context.inspectLocalMedia ?? inspectMedia;
  for (const reference of payload.img_references) {
    const file = localReferencePath(reference);
    if (!file) continue;
    const metadata = await inspector(file, { allowedExtensions: [".jpg", ".jpeg", ".png", ".webp"], maxBytes: 20 * 1024 * 1024 });
    if (metadata.width > 10_000 || metadata.height > 10_000) throw validationError(operation, "Viral-agent image dimensions must not exceed 10,000 pixels.");
  }
  for (const reference of payload.video_references) {
    const file = localReferencePath(reference);
    if (!file) continue;
    const metadata = await inspector(file, { allowedExtensions: [".mp4", ".mov", ".webm"], maxBytes: 100 * 1024 * 1024 });
    if (metadata.duration_seconds < 2 || metadata.duration_seconds > 30) throw validationError(operation, "Viral-agent video duration must be between 2 and 30 seconds.");
    if (metadata.width < 640 || metadata.width > 1920 || metadata.height < 640 || metadata.height > 1920) throw validationError(operation, "Viral-agent video width and height must each be between 640 and 1920 pixels.");
  }
  // Local paths only feed the media checks above and must not reach the API.
  return {
    ...payload,
    img_references: payload.img_references.map(withoutLocalPath),
    video_references: payload.video_references.map(withoutLocalPath),
  };
}

function withoutLocalPath({ file, local_path, ...reference }) {
  return reference;
}

function validateRealEstateAgent(operation, payload) {
  requireFields(operation, payload, ["agent_id", "model"]);
  if (payload.agent_id !== "419629433597950") throw validationError(operation, "real estate agent_id must be 419629433597950.");
  if (!["pro", "fast"].includes(payload.model)) throw validationError(operation, "real estate model must be pro or fast.");
  for (const field of ["mode", "duration", "video_style", "lip_sync_tts_speaker_id"]) {
    if (payload[field] !== undefined && payload.model !== "pro") throw validationError(operation, `${field} is supported only by the pro real estate model.`);
  }
  if (payload.mode !== undefined && !["property_tour", "ad_house_tour"].includes(payload.mode)) throw validationError(operation, "mode must be property_tour or ad_house_tour.");
  if (isPresent(payload.product_url)) {
    validateSafeRemoteUrl(operation, "product_url", payload.product_url);
    if (isPresent(payload.prompt) || isPresent(payload.img_references)) throw validationError(operation, "product_url cannot be combined with prompt or img_references.");
  }
  if (payload.prompt !== undefined && (typeof payload.prompt !== "string" || payload.prompt.length > 5000)) throw validationError(operation, "prompt must be no longer than 5000 characters.");
  if (payload.img_references !== undefined) {
    const [minimum, maximum] = payload.model === "fast" ? [5, 20] : [5, 60];
    if (!Array.isArray(payload.img_references) || payload.img_references.length < minimum || payload.img_references.length > maximum) throw validationError(operation, `img_references must contain ${minimum} to ${maximum} images for ${payload.model}.`);
  }
  if (payload.language_code !== undefined && !["en-US", "zh-CN", "auto"].includes(payload.language_code)) throw validationError(operation, "language_code must be en-US, zh-CN, or auto.");
  if (payload.avatar_presence_level !== undefined && !["none", "low", "medium", "high"].includes(payload.avatar_presence_level)) throw validationError(operation, "avatar_presence_level must be none, low, medium, or high.");
  if (payload.model === "pro" && payload.mode === "ad_house_tour") {
    if (payload.language_code !== undefined) throw validationError(operation, "language_code is not supported for pro ad_house_tour.");
    if (![15, 30].includes(payload.duration)) throw validationError(operation, "pro ad_house_tour duration must be 15 or 30.");
    if (!["cozy", "pov"].includes(payload.video_style)) throw validationError(operation, "pro ad_house_tour video_style must be cozy or pov.");
  }
  const aspects = payload.model === "fast" ? ["9:16", "16:9", "1:1", "4:3", "3:4"] : ["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"];
  if (payload.aspect_ratio !== undefined && !aspects.includes(payload.aspect_ratio)) throw validationError(operation, "Unsupported real estate aspect_ratio.");
  const qualities = payload.model === "fast" ? ["720p", "1080p"] : ["480p", "720p", "1080p"];
  if (payload.quality !== undefined) validateQuality(operation, payload.quality, qualities);
}

function toIntegerOrSelf(value) {
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
}
function validatePositiveInteger(operation, value, name) {
  if (!Number.isInteger(value) || value < 1) throw validationError(operation, `${name} must be a positive integer.`);
}
function validateOptionalSeed(operation, value) {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > SEED_MAXIMUM)) throw validationError(operation, `seed must be an integer from 0 to ${SEED_MAXIMUM}.`);
}
function validateKeyframe(operation, value, required) {
  if (!isPresent(value)) {
    if (required) throw validationError(operation, "keyframe_id is required.");
    return;
  }
  const normalized = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  // Documented range: 1 to the position of the last video frame.
  if (typeof normalized !== "string"
    || !/^\d+$/.test(normalized)
    || BigInt(normalized) < 1n
    || BigInt(normalized) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw validationError(operation, "keyframe_id must be a positive safe-integer string.");
  }
}
function validateQuality(operation, value, allowed) {
  if (!allowed.includes(value)) throw validationError(operation, `quality must be one of ${allowed.join(", ")}.`);
}
function validateMaximumItems(operation, value, field, maximum) {
  if (value !== undefined && (!Array.isArray(value) || value.length > maximum)) throw validationError(operation, `${field} must contain no more than ${maximum} items.`);
}
function isReferenceObject(reference) {
  return reference !== null && typeof reference === "object" && !Array.isArray(reference);
}
function localReferencePath(reference) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) return undefined;
  return reference.file ?? reference.local_path;
}
function parseUtcTimestamp(value) {
  const timestamp = Date.parse(`${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(timestamp)) return Number.NaN;
  const roundTrip = new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);
  return roundTrip === value ? timestamp : Number.NaN;
}
