const VIDEO_EDITING_ENDPOINTS = [
  ["video.restyle", "restyle", "/openapi/v2/video/restyle/generate"],
  ["video.swap-mask", "swap-mask", "/openapi/v2/video/mask/selection"],
  ["video.swap", "swap", "/openapi/v2/video/swap/generate"],
  ["video.sound-effect", "sound-effect", "/openapi/v2/video/sound_effect/generate"],
  ["video.extend", "extend", "/openapi/v2/video/extend/generate"],
  ["video.motion-control", "motion-control", "/openapi/v2/video/mimic/generate"],
  ["video.modify", "modify", "/openapi/v2/video/modify/generate"],
  ["video.upscale", "upscale", "/openapi/v2/video/upscale/generate"],
  ["video.expand", "expand", "/openapi/v2/video/expand/generate"],
];

export const VIDEO_EDITING_OPERATIONS = [
  ...VIDEO_EDITING_ENDPOINTS.map(([id, command, path]) => ({
    id,
    command: ["video", command],
    method: "POST",
    path,
    bodyMode: "json",
    validationPolicy: id,
    billing: "billable",
    asynchronous: id !== "video.swap-mask",
    resultIdPath: id === "video.swap-mask" ? null : "Resp.video_id",
  })),
  {
    id: "video.status",
    command: ["video", "status"],
    method: "GET",
    path: "/openapi/v2/video/result/{video_id}",
    bodyMode: "none",
    validationPolicy: "video.status",
    billing: "read-only",
    asynchronous: false,
    resultIdPath: "Resp.id",
  },
];
