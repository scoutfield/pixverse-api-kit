import { VIDEO_LANGUAGES } from "./validation.js";

// Resource identifiers are deliberately distinct: a run/task is not a video.
export const WORKFLOWS = Object.freeze({
  template: { path: "/template/videos/generations", readPath: "/videos", id: "video_id", terminal: ["succeeded", "failed", "canceled"] },
  "viral-clone": { path: "/viral-clone/runs", readPath: "/viral-clone/runs", id: "run_id", terminal: ["succeeded", "failed"] },
  variation: { path: "/variation/videos/generations", readPath: "/videos", id: "video_id", batch: true, terminal: ["succeeded", "failed", "canceled"] },
  "product-suite": { path: "/product-suite/images/generations", readPath: "/product-suite/images/generations", id: "task_id", terminal: ["completed", "failed"] },
  "video-import": { path: "/video/upload", readPath: "/videos", id: "video_id", synchronous: true, terminal: ["succeeded", "failed", "canceled"] },
});

export function workflowSpec(name) {
  if (!Object.hasOwn(WORKFLOWS, name)) throw new Error(`Unknown Growth Studio workflow: ${name}`);
  return WORKFLOWS[name];
}

export function assertResourceId(id, label = "resource_id") {
  if (typeof id !== "string" || !/^\d+$/.test(id)) throw new Error(`${label} must be a numeric string.`);
}

export function object(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} must be a plain object.`);
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new Error(`Unknown ${label} field: ${key}.`);
  }
}

function string(value, label, max = Infinity, required = true) {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) {
    throw new Error(`${label} must be ${required ? "a nonempty" : "a"} string of at most ${max} characters.`);
  }
}

function choice(value, values, label) {
  if (!values.includes(value)) throw new Error(`${label} must be one of: ${values.join(", ")}.`);
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
}

function array(value, label, max) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new Error(`${label} must contain 1 to ${max} entries.`);
  }
}

export function httpUrl(value, label, max = Infinity) {
  string(value, label, max);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an HTTP(S) URL.`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || value !== value.trim()) {
    throw new Error(`${label} must be an HTTP(S) URL without embedded credentials.`);
  }
  return url;
}

export function platformImage(value, label) {
  const url = httpUrl(value, label);
  if (url.protocol !== "https:" || !["media.pixverse.ai", "cdn.pixverse.ai"].includes(url.hostname)
    || url.port || /[?#]/.test(value) || url.pathname === "/") {
    throw new Error(`${label} must be an unchanged platform CDN image URL without query parameters or fragments.`);
  }
}

function product(value, maxImages) {
  object(value, ["title", "description", "brand", "price", "images", "source_url"], "product");
  const manual = value.source_url === undefined;
  if (!manual) httpUrl(value.source_url, "product.source_url", 2048);
  string(value.title, "product.title", 255, manual);
  string(value.description, "product.description", 5120, false);
  string(value.brand, "product.brand", 255, false);
  if (value.images !== undefined || manual) {
    array(value.images, "product.images", maxImages);
    for (const image of value.images) {
      object(image, ["url"], "product image");
      platformImage(image.url, "product.images[].url");
    }
  }
  if (value.price !== undefined) {
    object(value.price, ["amount", "currency"], "product.price");
    string(value.price.amount, "product.price.amount");
    if (typeof value.price.currency !== "string" || !/^[A-Za-z]{3}$/.test(value.price.currency)) {
      throw new Error("product.price.currency must be a three-letter currency code.");
    }
  }
}

function template(payload) {
  object(payload, ["template_id", "product", "video"], "template");
  if (!Number.isSafeInteger(payload.template_id) || payload.template_id < 0) {
    throw new Error("template_id must be a nonnegative safe integer from the live template catalog.");
  }
  product(payload.product, 10);
  object(payload.video, ["language", "voiceover", "captions", "background_music", "callout_text_switch", "avatar_url"], "video");
  choice(payload.video.language, VIDEO_LANGUAGES, "video.language");
  for (const field of ["voiceover", "captions", "background_music"]) boolean(payload.video[field], `video.${field}`);
  if (payload.video.callout_text_switch !== undefined && payload.video.callout_text_switch !== null) {
    boolean(payload.video.callout_text_switch, "video.callout_text_switch");
  }
  if (payload.video.avatar_url !== undefined && payload.video.avatar_url !== "") platformImage(payload.video.avatar_url, "video.avatar_url");
}

function viralClone(payload) {
  object(payload, ["source_video_id", "model", "script_language", "listing", "video", "avatar"], "viral-clone");
  assertResourceId(payload.source_video_id, "source_video_id");
  choice(payload.model, ["standard", "plus", "pro"], "model");
  string(payload.script_language, "script_language");
  try { Intl.getCanonicalLocales(payload.script_language); } catch { throw new Error("script_language must be a BCP 47 language code."); }
  const listing = payload.listing;
  object(listing, ["listing_id", "title", "description", "brand", "image_info"], "listing");
  if (listing.listing_id !== undefined) assertResourceId(listing.listing_id, "listing.listing_id");
  string(listing.title, "listing.title", 255, listing.listing_id === undefined);
  string(listing.description, "listing.description", 5120, false);
  string(listing.brand, "listing.brand", 255, false);
  if (listing.image_info !== undefined || listing.listing_id === undefined) {
    object(listing.image_info, ["items"], "listing.image_info");
    array(listing.image_info.items, "listing.image_info.items", 10);
    for (const item of listing.image_info.items) {
      object(item, ["url", "sort"], "listing image");
      httpUrl(item.url, "listing image URL");
      if (item.sort !== undefined && !Number.isSafeInteger(item.sort)) throw new Error("image sort must be a safe integer.");
    }
  }
  object(payload.video, ["aspect_ratio", "resolution", "language", "bgm_mode"], "video");
  choice(payload.video.aspect_ratio, ["1:1", "9:16", "16:9", "3:4", "4:3", "21:9"], "video.aspect_ratio");
  choice(payload.video.resolution, payload.model === "standard" ? ["768p", "1440p"] : ["480p", "720p", "1080p"], "video.resolution");
  choice(payload.video.language, VIDEO_LANGUAGES, "video.language");
  if (payload.video.bgm_mode !== undefined) choice(payload.video.bgm_mode, ["model_direct", "independent"], "video.bgm_mode");
  if (payload.avatar !== undefined) {
    object(payload.avatar, ["mode", "url", "avatar_id"], "avatar");
    const a = payload.avatar;
    choice(a.mode, ["custom", "disabled"], "avatar.mode");
    if (a.mode === "disabled") {
      if (a.url !== undefined || a.avatar_id !== undefined) throw new Error("disabled avatar must omit url and avatar_id.");
    } else {
      if ((a.url !== undefined) === (a.avatar_id !== undefined)) throw new Error("custom avatar requires exactly one of url and avatar_id.");
      if (a.url !== undefined) platformImage(a.url, "avatar.url");
      else assertResourceId(a.avatar_id, "avatar.avatar_id");
    }
  }
}

function variation(payload) {
  object(payload, ["source_video_id", "videos"], "variation");
  assertResourceId(payload.source_video_id, "source_video_id");
  array(payload.videos, "videos", 20);
  for (const video of payload.videos) {
    object(video, ["avatar", "scene", "language"], "variation video");
    object(video.language, ["code"], "language");
    string(video.language.code, "language.code");
    choice(video.language.code.trim(), VIDEO_LANGUAGES, "language.code");
    for (const field of ["avatar", "scene"]) {
      const setting = video[field];
      object(setting, ["mode", "description", "image_url"], field);
      choice(setting.mode, ["keep", "auto", "text", "image"], `${field}.mode`);
      string(setting.description, `${field}.description`, Infinity, setting.mode === "text");
      if (setting.image_url !== undefined) string(setting.image_url, `${field}.image_url`, Infinity, false);
      if (setting.mode === "image") platformImage(setting.image_url, `${field}.image_url`);
      else if (setting.image_url) throw new Error(`${field}.image_url conflicts with ${setting.mode} mode.`);
      if (["keep", "auto"].includes(setting.mode) && setting.description?.trim()) throw new Error(`${field}.description conflicts with ${setting.mode} mode.`);
    }
  }
}

export const SUITE_IMAGE_TYPES = Object.freeze({
  amazon: ["main", "angle", "structure", "feature", "lifestyle", "material", "dimensions", "category", "package_brand"],
  walmart: ["primary_silo", "alternate_silo", "structure_detail", "feature_graphic", "lifestyle", "material_detail", "dimensions_scale", "category_supplement", "package_contents"],
  tiktok_shop: ["cover", "multi_angle", "structure_contents", "key_benefit", "use_demo", "model_lifestyle", "material_detail", "size_spec", "category_proof"],
});

export const SUITE_MARKETPLACES = Object.freeze({
  amazon: {
    "amazon.com": ["en-US"], "amazon.ca": ["en-CA", "fr-CA"], "amazon.com.mx": ["es-MX"], "amazon.com.br": ["pt-BR"],
    "amazon.co.uk": ["en-GB"], "amazon.de": ["de-DE"], "amazon.fr": ["fr-FR"], "amazon.it": ["it-IT"], "amazon.es": ["es-ES"],
    "amazon.nl": ["nl-NL"], "amazon.se": ["sv-SE"], "amazon.pl": ["pl-PL"], "amazon.com.be": ["nl-BE", "fr-BE", "de-BE"],
    "amazon.ie": ["en-IE"], "amazon.com.tr": ["tr-TR"], "amazon.co.jp": ["ja-JP"], "amazon.in": ["en-IN", "hi-IN"],
    "amazon.sg": ["en-SG"], "amazon.com.au": ["en-AU"], "amazon.ae": ["ar-AE"], "amazon.sa": ["ar-SA"],
    "amazon.eg": ["ar-EG"], "amazon.co.za": ["en-ZA"],
  },
  walmart: { "walmart.com": ["en-US"], "walmart.ca": ["en-CA", "fr-CA"], "walmart.com.mx": ["es-MX"], "lider.cl": ["es-CL"] },
  tiktok_shop: Object.fromEntries([
    ["us", "en-US"], ["mx", "es-MX"], ["br", "pt-BR"], ["uk", "en-GB"], ["ie", "en-IE"], ["de", "de-DE"],
    ["fr", "fr-FR"], ["it", "it-IT"], ["es", "es-ES"], ["at", "de-AT"], ["be", "nl-BE"], ["nl", "nl-NL"],
    ["pl", "pl-PL"], ["cz", "cs-CZ"], ["gr", "el-GR"], ["pt", "pt-PT"], ["hu", "hu-HU"], ["id", "id-ID"],
    ["my", "ms-MY"], ["ph", "en-PH"], ["sg", "en-SG"], ["th", "th-TH"], ["vn", "vi-VN"], ["jp", "ja-JP"], ["sa", "ar-SA"],
  ].map(([market, language]) => [`tiktokshop-${market}`, [language]])),
});

function productSuite(payload) {
  object(payload, ["platform", "marketplace", "language", "quality", "product", "image_types"], "product-suite");
  choice(payload.platform, Object.keys(SUITE_MARKETPLACES), "platform");
  const markets = SUITE_MARKETPLACES[payload.platform];
  choice(payload.marketplace, Object.keys(markets), "marketplace");
  choice(payload.language, markets[payload.marketplace], "language");
  if (payload.quality !== undefined && payload.quality !== "") throw new Error("quality must be omitted or empty.");
  product(payload.product, 9);
  const types = payload.marketplace === "walmart.com.mx" ? SUITE_IMAGE_TYPES.walmart.slice(0, 6) : SUITE_IMAGE_TYPES[payload.platform];
  array(payload.image_types, "image_types", types.length);
  if (new Set(payload.image_types).size !== payload.image_types.length) throw new Error("image_types must not contain duplicates.");
  for (const type of payload.image_types) choice(type, types, "image_types");
}

export function normalizeWorkflowPayload(name, payload) {
  workflowSpec(name);
  if (name === "template") template(payload);
  else if (name === "viral-clone") viralClone(payload);
  else if (name === "variation") variation(payload);
  else if (name === "product-suite") productSuite(payload);
  else {
    object(payload, ["url"], "video-import");
    httpUrl(payload.url, "url");
  }
  const body = JSON.stringify(payload);
  const maximum = name === "video-import" ? 64 * 1024 : name === "template" ? Infinity : 1024 * 1024;
  if (Buffer.byteLength(body, "utf8") > maximum) throw new Error(`Request body exceeds ${maximum} bytes.`);
  return JSON.parse(body);
}

export function describeWorkflowDryRun(name, payload) {
  const spec = workflowSpec(name);
  return { capability: name, billable: false, method: "POST", path: `/openapi/v1${spec.path}`, body: normalizeWorkflowPayload(name, payload) };
}
