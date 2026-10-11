import {
  isPresent,
  requireExactlyOneField,
  requireField,
  requireFields,
  validateModelScalars,
  validationError,
} from "./common.js";
import { validateImageSource } from "./media.js";

const IMAGE_REFERENCE_FIELDS = ["img_id", "image_id", "image_url", "img_url"];
const VIDEO_REFERENCE_FIELDS = ["video_id", "video_url"];

export function validateVideoOperation(operation, payload) {
  switch (operation.id) {
    case "video.text":
      validateModelScalars(operation, payload);
      requireFields(operation, payload, ["aspect_ratio", "duration", "model", "prompt", "quality"]);
      break;
    case "video.image":
      validateModelScalars(operation, payload);
      requireFields(operation, payload, ["duration", "img_id", "model", "prompt", "quality"]);
      break;
    case "video.template": {
      // The template supplies the prompt: it may be empty and is ignored when template_id is set.
      if (payload.prompt === undefined) payload.prompt = "";
      if (typeof payload.prompt !== "string" || payload.prompt.length > 2048) {
        throw validationError(operation, "prompt must be a string no longer than 2048 characters.");
      }
      const { prompt, ...scalars } = payload;
      validateModelScalars(operation, scalars);
      requireFields(operation, payload, ["template_id", "duration", "model", "quality"]);
      if (!isPresent(payload.img_id) && (!Array.isArray(payload.img_ids) || payload.img_ids.length === 0)) {
        throw validationError(operation, "img_id or img_ids image source is required.");
      }
      break;
    }
    case "video.transition":
      validateModelScalars(operation, payload);
      requireFields(operation, payload, ["prompt", "model", "duration", "quality"]);
      validateTransition(operation, payload);
      break;
    case "video.multi-transition":
      validateMultiTransition(operation, payload);
      break;
    case "video.lip-sync":
      validateLipSync(operation, payload);
      break;
    case "video.fusion":
      validateFusion(operation, payload);
      break;
    case "video.avatar":
      validateModelScalars(operation, payload);
      requireFields(operation, payload, ["img_id", "quality"]);
      validateAudioOrTts(operation, payload, true);
      if (isPresent(payload.lip_sync_tts_content)
        && (payload.lip_sync_tts_content.length < 30 || payload.lip_sync_tts_content.length > 200)) {
        throw validationError(operation, "avatar lip_sync_tts_content must contain 30 to 200 characters.");
      }
      break;
    default:
      throw validationError(operation, `No video validator exists for ${operation.id}.`);
  }
}

function validateTransition(operation, payload) {
  // The API only reads first_frame_img/last_frame_img; aliases would be sent but ignored.
  requireFields(operation, payload, ["first_frame_img", "last_frame_img"]);
}

function validateMultiTransition(operation, payload) {
  requireFields(operation, payload, ["model", "quality"]);
  if (!["v3.5", "v4", "v4.5", "v5"].includes(payload.model)) {
    throw validationError(operation, "multi-transition model must be v3.5, v4, v4.5, or v5.");
  }
  validateModelScalars(operation, payload);
  const items = payload.multi_transition;
  if (!Array.isArray(items) || items.length < 2 || items.length > 7) {
    throw validationError(operation, "multi-transition must contain between 2 and 7 ordered items.");
  }
  items.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw validationError(operation, `multi-transition item ${index + 1} must be an object.`);
    }
    requireField(operation, item, ["img_id"], `multi-transition item ${index + 1} img_id`);
    const last = index === items.length - 1;
    if (last) {
      if (isPresent(item.duration) && item.duration !== 0) {
        throw validationError(operation, "the last multi-transition item duration must be 0 or omitted.");
      }
      return;
    }
    if (!isPresent(item.duration)) {
      throw validationError(operation, "duration is required for every multi-transition item except the last item.");
    }
    const maximumDuration = items.length >= 3 ? 5 : 8;
    if (!Number.isInteger(item.duration) || item.duration < 1 || item.duration > maximumDuration) {
      throw validationError(operation, `multi-transition item duration must be an integer from 1 to ${maximumDuration} when there are ${items.length} items.`);
    }
  });
}

function validateLipSync(operation, payload) {
  requireExactlyOneField(operation, payload, ["source_video_id", "video_media_id"]);
  validateAudioOrTts(operation, payload, true);
}

function validateAudioOrTts(operation, payload, required) {
  const audio = isPresent(payload.audio_media_id);
  const hasSpeaker = isPresent(payload.lip_sync_tts_speaker_id);
  const hasContent = isPresent(payload.lip_sync_tts_content);
  const tts = hasSpeaker && hasContent;
  if (hasSpeaker !== hasContent) {
    throw validationError(operation, "lip-sync TTS requires both lip_sync_tts_speaker_id and lip_sync_tts_content.");
  }
  if ((required && !audio && !tts) || (audio && tts)) {
    throw validationError(operation, "Provide either audio_media_id or the TTS speaker/content pair, but not both.");
  }
}

function validateFusion(operation, payload) {
  const omniVideo = payload.model === "v6" && payload.reference_mode === "omni"
    && Array.isArray(payload.video_references) && payload.video_references.length > 0;
  const scalarPayload = omniVideo && payload.duration === 0 ? { ...payload } : payload;
  if (scalarPayload !== payload) delete scalarPayload.duration;
  const scalarOptions = payload.model === "v6" && payload.reference_mode !== undefined
    ? { aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16", "2:3", "3:2", "21:9", "auto"] }
    : {};
  validateModelScalars(operation, scalarPayload, scalarOptions);
  // v6 omni requests may reference only videos (fusion v6 video reference guide).
  requireFields(operation, payload, omniVideo
    ? ["prompt", "model", "duration", "quality", "aspect_ratio"]
    : ["image_references", "prompt", "model", "duration", "quality", "aspect_ratio"]);
  if (!["v4.5", "v5", "v5.5", "v5.6", "v6", "c1"].includes(payload.model)) {
    throw validationError(operation, "fusion model must be v4.5, v5, v5.5, v5.6, v6, or c1.");
  }
  validateFusionModelRules(operation, payload, omniVideo);
  if (omniVideo && payload.video_references.length > 2) {
    throw validationError(operation, "fusion accepts at most two reference videos.");
  }
  const references = payload.image_references ?? (omniVideo ? [] : undefined);
  if (!Array.isArray(references) || (references.length === 0 && !omniVideo)) {
    throw validationError(operation, "fusion requires one or more image references.");
  }
  for (const reference of references) {
    if (reference?.type !== undefined && !["subject", "background"].includes(reference.type)) {
      throw validationError(operation, "fusion image reference type must be subject or background.");
    }
  }
  const maximum = payload.model === "v6" && payload.reference_mode === "omni" ? 10
    : ["v5.5", "v5.6", "v6", "c1"].includes(payload.model) ? 7 : 3;
  if (references.length > maximum) throw validationError(operation, `fusion accepts at most ${maximum} image references for this model.`);
  if (omniVideo && payload.duration !== 0) {
    throw validationError(operation, "fusion duration must be 0 for v6 omni mode with video references.");
  }
}

function validateFusionModelRules(operation, payload, omniVideo) {
  if (payload.reference_mode !== undefined) {
    if (payload.reference_mode === "omni" && payload.model !== "v6") {
      throw validationError(operation, "fusion reference_mode omni requires model v6.");
    }
  }

  if (!omniVideo) {
    const durations = ["v4.5", "v5"].includes(payload.model) ? [5, 8]
      : ["v5.5", "v5.6"].includes(payload.model) ? [5, 8, 10]
        : undefined;
    if (durations && !durations.includes(payload.duration)) {
      throw validationError(operation, `fusion duration for ${payload.model} must be ${durations.join(" or ")}.`);
    }
    if (["v5.5", "v5.6"].includes(payload.model) && payload.quality === "1080p" && payload.duration === 10) {
      throw validationError(operation, "fusion duration 10 is not available at 1080p for v5.5 or v5.6.");
    }
  }

  const legacyAspects = ["16:9", "4:3", "1:1", "3:4", "9:16"];
  const extendedAspects = [...legacyAspects, "2:3", "3:2", "21:9"];
  const allowedAspects = ["v6", "c1"].includes(payload.model) ? extendedAspects : legacyAspects;
  if (payload.model === "v6" && payload.reference_mode !== undefined) allowedAspects.push("auto");
  if (!allowedAspects.includes(payload.aspect_ratio)) {
    throw validationError(operation, `fusion aspect_ratio is not supported by ${payload.model}.`);
  }
}
