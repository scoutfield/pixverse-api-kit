// PixVerse Platform API pricing, transcribed from the official pricing page.
// The account ledger is the final source of truth; Resp.credits on creation
// and on the status result supersede these estimates whenever present.
export const PLATFORM_PRICING_SOURCE = Object.freeze({
  url: "https://docs.platform.pixverse.ai/pixverse-api-pricing-2394995m0",
  as_of: "2026-10-23",
});
export const CREDITS_PER_USD = 225;

const QUALITIES = ["360p", "540p", "720p", "1080p"];

function row(values) {
  return Object.freeze(Object.fromEntries(QUALITIES.map((quality, index) => [quality, values[index] ?? null])));
}

// Credits per generated second.
const PER_SECOND_MODELS = Object.freeze({
  "v6-max": { off: row([6, 9, 11, 22]), on: row([9, 11, 15, 28]) },
  c1: { off: row([6, 8, 10, 19]), on: row([8, 10, 13, 24]) },
  v6: { off: row([5, 7, 9, 18]), on: row([7, 9, 12, 23]) },
  "v6-video-reference": { off: row([10, 14, 18, 36]), on: row([14, 18, 24, 46]) },
});

// Fixed credits per request by duration; null means "Not supported".
const FIXED_TIER_MODELS = Object.freeze({
  "v5.6": {
    5: { off: row([35, 35, 45, 75]), on: row([80, 80, 90, 120]) },
    8: { off: row([70, 70, 90, 150]), on: row([115, 115, 135, 195]) },
    10: { off: row([77, 77, 99, null]), on: row([122, 122, 144, null]) },
  },
  "v5.5": {
    5: { off: row([45, 45, 60, 120]), on: row([55, 55, 70, 130]) },
    8: { off: row([90, 90, 120, 240]), on: row([100, 100, 130, 250]) },
    10: { off: row([99, 99, 132, null]), on: row([109, 109, 142, null]) },
  },
  "v5.5-multi-shot": {
    5: { off: row([75, 75, 90, 150]), on: row([85, 85, 100, 160]) },
    8: { off: row([120, 120, 150, 270]), on: row([130, 130, 160, 280]) },
    10: { off: row([129, 129, 162, null]), on: row([139, 139, 172, null]) },
  },
  v5: {
    5: { off: row([45, 45, 60, 120]) },
    8: { off: row([90, 90, 120, 240]) },
  },
});

// motion_mode=normal tiers; fast doubles the amount.
const MULTI_TRANSITION_TIERS = Object.freeze({
  1: row([23, 23, 30, 60]),
  2: row([27, 27, 36, 72]),
  3: row([32, 32, 42, 84]),
  4: row([36, 36, 48, 96]),
  5: row([45, 45, 60, 120]),
  6: row([59, 59, 78, 156]),
  7: row([72, 72, 96, 192]),
  8: row([90, 90, 120, 240]),
  9: row([95, 95, 126, 252]),
  10: row([99, 99, 132, 264]),
  15: row([135, 135, 180, 360]),
  20: row([180, 180, 240, 480]),
  25: row([225, 225, 300, 600]),
  30: row([270, 270, 360, 720]),
});

// Credits per source-video second (input duration is not known locally).
const SOURCE_SECOND_RATES = Object.freeze({
  "video.sound-effect": () => 2,
  "video.restyle": () => 10,
  "video.upscale": () => 5,
  "video.swap": (quality) => row([9, 9, 12, null])[quality],
  "video.motion-control": (quality) => row([9, 10, 12, null])[quality],
  "video.modify": (quality) => row([8, 10, 12, null])[quality],
  "video.expand": (quality) => ({ "720p": 12, "1080p": 24 })[quality] ?? null,
});

const AVATAR_UNIT_RATES = row([5, 10, 15, 20]);
const LIP_SYNC_UNIT_RATE = 4;
const SWAP_MASK_CREDITS = 2;
const VIRAL_RECREATION_RATES = row([null, null, 80, 157]);
const TTS_BYTES_PER_UNIT = 15;

export function creditsToUsd(credits) {
  if (!Number.isFinite(credits)) return null;
  return Math.round((credits / CREDITS_PER_USD) * 1000) / 1000;
}

// Pre-submission estimate from the published price table.
export function estimatePlatformCost(operation, payload = {}) {
  if (!operation) return unknown("Unknown operation.");
  if (operation.billing !== "billable") return nonBillable();
  const estimator = ESTIMATORS[operation.id];
  return estimator ? estimator(payload ?? {}) : unknown("No public rate is listed; read Resp.credits after creation.");
}

// Cost attached to every Platform call result. Provider-reported credits
// (creation or status Resp.credits) always win over the local estimate.
export function platformCallCost(operation, { payload, data } = {}) {
  if (operation?.id === "video.status" || operation?.id === "image.status") {
    const credits = readCredits(data);
    return credits === undefined
      ? { ...nonBillable(), task_credits: null, task_usd: null }
      : { ...nonBillable(), task_credits: credits, task_usd: creditsToUsd(credits) };
  }
  const estimate = estimatePlatformCost(operation, payload);
  if (operation?.billing !== "billable") return estimate;
  const credits = readCredits(data);
  if (credits === undefined) return estimate;
  return withSource(credits, "response", { estimate: stripSource(estimate) });
}

// Final job cost: the status result's credits are what the task consumed.
export function finalJobCost(submittedCost, statusData) {
  const credits = readCredits(statusData);
  if (credits === undefined) return submittedCost;
  const previous = submittedCost ? stripSource(submittedCost) : undefined;
  return withSource(credits, "status", previous ? { submitted: previous } : {});
}

export function formatPlatformCost(cost) {
  if (!cost) return undefined;
  if (cost.source === "non-billable") {
    return Number.isFinite(cost.task_credits)
      ? `Cost: $0 for this call (task cost ${cost.task_credits} credits ≈ $${cost.task_usd.toFixed(3)})`
      : "Cost: $0 (non-billable call)";
  }
  if (!Number.isFinite(cost.credits)) {
    return `Cost: unknown before submission${cost.basis ? ` (${cost.basis})` : ""}`;
  }
  const label = cost.source === "estimate" ? "Estimated cost" : "Cost";
  return `${label}: ${cost.credits} credits ≈ $${cost.usd.toFixed(3)}${cost.basis ? ` (${cost.basis})` : ""}`;
}

const ESTIMATORS = Object.freeze({
  "video.text": (payload) => estimateModelVideo(payload),
  "video.image": (payload) => estimateModelVideo(payload),
  "video.transition": (payload) => estimateModelVideo(payload),
  "video.extend": (payload) => estimateModelVideo(payload, "V6 Extend uses the V6 generated-duration rate"),
  "video.fusion": (payload) => estimateFusion(payload),
  "video.template": () => unknown("Template price is the template's credit_consume from resource templates."),
  "video.multi-transition": (payload) => estimateMultiTransition(payload),
  "video.lip-sync": (payload) => estimateSpeech(payload, () => LIP_SYNC_UNIT_RATE, "lip sync"),
  "video.avatar": (payload) => estimateSpeech(payload, (quality) => AVATAR_UNIT_RATES[quality], "avatar"),
  "video.swap-mask": () => withSource(SWAP_MASK_CREDITS, "estimate", { basis: "2 credits per request" }),
  "agent.viral-recreation": (payload) => estimateViralRecreation(payload),
  ...Object.fromEntries(Object.entries(SOURCE_SECOND_RATES).map(([id, rate]) => [id, (payload) => {
    const perSecond = rate(normalizeQuality(payload.quality));
    if (!Number.isFinite(perSecond)) return unknown(`No public rate for quality ${payload.quality ?? "(unset)"}.`);
    return unknown(`${perSecond} credits per source-video second (rounded up); total depends on source length`, {
      credits_per_source_second: perSecond,
      usd_per_source_second: creditsToUsd(perSecond),
    });
  }])),
});

function estimateModelVideo(payload, note) {
  const quality = normalizeQuality(payload.quality);
  const audio = audioOn(payload);
  const model = payload.model;
  const perSecond = PER_SECOND_MODELS[model];
  if (perSecond) {
    const rate = perSecond[audio ? "on" : "off"][quality];
    if (!Number.isFinite(rate)) return unknown(`No public rate for ${model} at ${payload.quality}.`);
    if (!Number.isInteger(payload.duration) || payload.duration < 1) {
      return unknown(`${rate} credits per generated second`, { credits_per_second: rate });
    }
    const basis = `${model} ${quality} audio ${audio ? "on" : "off"}: ${rate} × ${payload.duration}s${note ? `; ${note}` : ""}`;
    return withSource(rate * payload.duration, "estimate", { basis });
  }
  const tierKey = model === "v5.5" && payload.generate_multi_clip_switch === true ? "v5.5-multi-shot" : model;
  const tiers = FIXED_TIER_MODELS[tierKey];
  if (!tiers) return unknown(`No public rate is listed for model ${model ?? "(unset)"}.`);
  const tier = tiers[payload.duration]?.[audio && tiers[payload.duration]?.on ? "on" : "off"];
  const credits = tier?.[quality];
  if (!Number.isFinite(credits)) return unknown(`${model} ${payload.duration}s at ${payload.quality} is not supported or not listed.`);
  return withSource(credits, "estimate", { basis: `${tierKey} fixed tier ${payload.duration}s ${quality} audio ${audio ? "on" : "off"}` });
}

function estimateFusion(payload) {
  const videoReferences = Array.isArray(payload.video_references) && payload.video_references.length > 0;
  if (!videoReferences) return estimateModelVideo(payload);
  const rate = PER_SECOND_MODELS["v6-video-reference"][audioOn(payload) ? "on" : "off"][normalizeQuality(payload.quality)];
  return unknown(`${rate} credits per output second (2× V6); output follows the longest reference video`, {
    credits_per_second: rate,
  });
}

function estimateMultiTransition(payload) {
  const quality = normalizeQuality(payload.quality);
  const items = Array.isArray(payload.multi_transition) ? payload.multi_transition : [];
  const multiplier = payload.motion_mode === "fast" ? 2 : 1;
  let total = 0;
  for (const item of items.slice(0, -1)) {
    const credits = MULTI_TRANSITION_TIERS[item?.duration]?.[quality];
    if (!Number.isFinite(credits)) return unknown(`No listed multi-transition tier for ${item?.duration}s at ${payload.quality}.`);
    total += credits * multiplier;
  }
  if (items.length < 2) return unknown("Multi-transition needs at least two items to estimate.");
  return withSource(total, "estimate", { basis: `sum of segment tiers at ${quality}${multiplier === 2 ? ", fast mode ×2" : ""}` });
}

function estimateSpeech(payload, unitRate, label) {
  const rate = unitRate(normalizeQuality(payload.quality));
  if (!Number.isFinite(rate)) return unknown(`No public ${label} rate for quality ${payload.quality ?? "(unset)"}.`);
  if (typeof payload.lip_sync_tts_content === "string" && payload.lip_sync_tts_content !== "") {
    const bytes = Buffer.byteLength(payload.lip_sync_tts_content, "utf8");
    const units = Math.ceil(bytes / TTS_BYTES_PER_UNIT);
    return withSource(units * rate, "estimate", { basis: `${label} TTS: ceil(${bytes} bytes / 15) = ${units} units × ${rate}` });
  }
  return unknown(`${rate} credits per uploaded-audio second (rounded up); total depends on audio length`, {
    credits_per_audio_second: rate,
  });
}

function estimateViralRecreation(payload) {
  const rate = VIRAL_RECREATION_RATES[normalizeQuality(payload.quality)];
  if (!Number.isFinite(rate)) return unknown(`Viral Recreation supports 720p and 1080p only.`);
  if (!Number.isInteger(payload.duration) || payload.duration < 1) {
    return unknown(`${rate} credits per generated second`, { credits_per_second: rate });
  }
  return withSource(rate * payload.duration, "estimate", { basis: `viral recreation ${rate} × ${payload.duration}s` });
}

function audioOn(payload) {
  return payload.generate_audio_switch === true || payload.sound_effect_switch === true;
}

function normalizeQuality(value) {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function readCredits(data) {
  const value = data?.credits;
  const credits = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isFinite(credits) && credits >= 0 ? credits : undefined;
}

function withSource(credits, source, extra = {}) {
  return { credits, usd: creditsToUsd(credits), source, ...extra };
}

function stripSource(cost) {
  const { estimate, submitted, ...rest } = cost;
  return rest;
}

function nonBillable() {
  return { credits: 0, usd: 0, source: "non-billable" };
}

function unknown(basis, extra = {}) {
  return { credits: null, usd: null, source: "estimate", basis, ...extra };
}
