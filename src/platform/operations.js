import { ACCOUNT_OPERATIONS } from "./operations/account.js";
import { AGENT_OPERATIONS } from "./operations/agents.js";
import { AUDIO_OPERATIONS } from "./operations/audio.js";
import { RESOURCE_OPERATIONS } from "./operations/resources.js";
import { UPLOAD_OPERATIONS } from "./operations/uploads.js";
import { VIDEO_EDITING_OPERATIONS } from "./operations/video-editing.js";
import { VIDEO_GENERATION_OPERATIONS } from "./operations/video-generation.js";

const DOCUMENTATION_URLS = Object.freeze({
  "account.balance": "https://docs.platform.pixverse.ai/get-user-credit-balance-13778989e0",
  "account.usage": "https://docs.platform.pixverse.ai/usage-deduction-query-41209884e0",
  "upload.image": "https://docs.platform.pixverse.ai/upload-image-13016631e0",
  "upload.media": "https://docs.platform.pixverse.ai/upload-videoaudio-19094401e0",
  "audio.verify": "https://aisphere.feishu.cn/wiki/L8pgwGoSwiDbQ8ksGIHcppcvnrc",
  "resource.templates": "https://docs.platform.pixverse.ai/get-template-list-38573064e0",
  "resource.tts-speakers": "https://docs.platform.pixverse.ai/get-speechlipsync-tts-list-19094355e0",
  "resource.restyle-effects": "https://docs.platform.pixverse.ai/restyle-effect-list-21992862e0",
  "voice.create": "https://docs.platform.pixverse.ai/create-custom-voice-40528181e0",
  "voice.delete": "https://docs.platform.pixverse.ai/delete-custom-voice-40528243e0",
  "image.template": "https://docs.platform.pixverse.ai/image-template-generation-27564921e0",
  "image.status": "https://docs.platform.pixverse.ai/get-image-generation-27565028e0",
  "video.text": "https://docs.platform.pixverse.ai/text-to-video-generation-13016634e0",
  "video.image": "https://docs.platform.pixverse.ai/image-to-video-generation-13016633e0",
  "video.template": "https://docs.platform.pixverse.ai/template-video-generation-33889423e0",
  "video.transition": "https://docs.platform.pixverse.ai/transitionfirst-last-frame-generation-15123014e0",
  "video.multi-transition": "https://docs.platform.pixverse.ai/multi-transition-video-generation-24001841e0",
  "video.lip-sync": "https://docs.platform.pixverse.ai/speechlipsync-generation-19094278e0",
  "video.fusion": "https://docs.platform.pixverse.ai/fusionreference-to-video-generation-19884194e0",
  "video.restyle": "https://docs.platform.pixverse.ai/restyle-video-generation-21992681e0",
  "video.swap-mask": "https://docs.platform.pixverse.ai/swap-mask-generation-24001877e0",
  "video.swap": "https://docs.platform.pixverse.ai/swap-video-generation-24001839e0",
  "video.sound-effect": "https://docs.platform.pixverse.ai/sound-effect-generation-19884196e0",
  "video.extend": "https://docs.platform.pixverse.ai/extend-generation-19094393e0",
  "video.motion-control": "https://docs.platform.pixverse.ai/motion-control-mimic-generation-28748523e0",
  "video.modify": "https://docs.platform.pixverse.ai/modify-generation-33365578e0",
  "video.upscale": "https://docs.platform.pixverse.ai/upscale-video-37938008e0",
  "video.avatar": "https://docs.platform.pixverse.ai/avatar-generation-40528034e0",
  "agent.viral-recreation": "https://docs.platform.pixverse.ai/viral-recreation-agent-41205382e0",
  "agent.real-estate": "https://docs.platform.pixverse.ai/one-click-real-estate-video-42843647e0",
  "agent.music-mv": "https://docs.platform.pixverse.ai/one-click-vibemv-44175576e0",
  "video.status": "https://docs.platform.pixverse.ai/get-video-generation-status-13016632e0",
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
