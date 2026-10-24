import { ACCOUNT_OPERATIONS } from "./operations/account.js";
import { AGENT_OPERATIONS } from "./operations/agents.js";
import { AUDIO_OPERATIONS } from "./operations/audio.js";
import { RESOURCE_OPERATIONS } from "./operations/resources.js";
import { UPLOAD_OPERATIONS } from "./operations/uploads.js";
import { VIDEO_EDITING_OPERATIONS } from "./operations/video-editing.js";
import { VIDEO_GENERATION_OPERATIONS } from "./operations/video-generation.js";

const DOCUMENTATION_URLS = Object.freeze({
  "account.balance": "https://docs.platform.pixverse.ai/get-account-balance-13778057e0",
  "account.usage": "https://docs.platform.pixverse.ai/usage-deduction-query-43051211e0",
  "upload.image": "https://docs.platform.pixverse.ai/upload-image-13016631e0",
  "upload.media": "https://docs.platform.pixverse.ai/upload-media-video-and-audio-43051206e0",
  "audio.verify": "https://docs.platform.pixverse.ai/verify-uploaded-audio-43051207e0",
  "resource.templates": "https://docs.platform.pixverse.ai/get-effect-template-list-43051208e0",
  "resource.tts-speakers": "https://docs.platform.pixverse.ai/get-tts-speaker-list-43051209e0",
  "resource.restyle-effects": "https://docs.platform.pixverse.ai/get-restyle-effect-list-43051210e0",
  "voice.create": "https://docs.platform.pixverse.ai/create-custom-voice-43150037e0",
  "voice.delete": "https://docs.platform.pixverse.ai/delete-custom-voice-43150038e0",
  "image.template": "https://docs.platform.pixverse.ai/image-template-generation-43150035e0",
  "image.status": "https://docs.platform.pixverse.ai/get-image-generation-result-43150036e0",
  "video.text": "https://docs.platform.pixverse.ai/text-to-video-13016634e0",
  "video.image": "https://docs.platform.pixverse.ai/image-to-video-and-video-templates-13016633e0",
  "video.template": "https://docs.platform.pixverse.ai/image-to-video-and-video-templates-13016633e0",
  "video.transition": "https://docs.platform.pixverse.ai/first-and-last-frame-video-43051213e0",
  "video.multi-transition": "https://docs.platform.pixverse.ai/multi-transition-video-43051215e0",
  "video.lip-sync": "https://docs.platform.pixverse.ai/lipsync-43051219e0",
  "video.fusion": "https://docs.platform.pixverse.ai/reference-to-video-fusion-43051214e0",
  "video.restyle": "https://docs.platform.pixverse.ai/video-restyle-43051218e0",
  "video.swap-mask": "https://docs.platform.pixverse.ai/select-video-mask-43051221e0",
  "video.swap": "https://docs.platform.pixverse.ai/subject-replacement-swap-43051222e0",
  "video.sound-effect": "https://docs.platform.pixverse.ai/sound-effect-43051220e0",
  "video.extend": "https://docs.platform.pixverse.ai/video-extend-43051216e0",
  "video.motion-control": "https://docs.platform.pixverse.ai/motion-control-mimic-43051224e0",
  "video.modify": "https://docs.platform.pixverse.ai/video-edit-modify-43051223e0",
  "video.upscale": "https://docs.platform.pixverse.ai/video-upscale-43051217e0",
  "video.avatar": "https://docs.platform.pixverse.ai/image-avatar-43051225e0",
  "agent.viral-recreation": "https://docs.platform.pixverse.ai/viral-recreation-agent-41205382e0",
  "agent.real-estate": "https://docs.platform.pixverse.ai/one-click-real-estate-video-43051226e0",
  "agent.music-mv": "https://docs.platform.pixverse.ai/one-click-vibemv-44144151e0",
  "video.expand": "https://docs.platform.pixverse.ai/video-expand-45751712e0",
  "video.status": "https://docs.platform.pixverse.ai/query-task-status-43051212e0",
});

const operationDefinitions = [
  ...ACCOUNT_OPERATIONS,
  ...UPLOAD_OPERATIONS,
  ...AUDIO_OPERATIONS,
  ...RESOURCE_OPERATIONS,
  ...VIDEO_GENERATION_OPERATIONS.filter(({ id }) => id !== "video.avatar"),
  ...VIDEO_EDITING_OPERATIONS.filter(({ id }) => id !== "video.status"),
  VIDEO_GENERATION_OPERATIONS.find(({ id }) => id === "video.avatar"),
  ...AGENT_OPERATIONS,
  VIDEO_EDITING_OPERATIONS.find(({ id }) => id === "video.status"),
];

export const PLATFORM_OPERATIONS = Object.freeze(operationDefinitions.map((definition) => Object.freeze({
  ...definition,
  command: Object.freeze([...definition.command]),
  documentationUrl: DOCUMENTATION_URLS[definition.id],
})));

const OPERATIONS_BY_ID = new Map(PLATFORM_OPERATIONS.map((operation) => [operation.id, operation]));
const OPERATIONS_BY_COMMAND = new Map(
  PLATFORM_OPERATIONS.map((operation) => [operation.command.join("\0"), operation]),
);

export function getPlatformOperation(id) {
  return OPERATIONS_BY_ID.get(id);
}

export function matchPlatformCommand(segments) {
  if (!Array.isArray(segments)) return undefined;
  return OPERATIONS_BY_COMMAND.get(segments.slice(0, 2).join("\0"));
}
