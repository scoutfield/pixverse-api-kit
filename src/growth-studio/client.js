import fs from "node:fs";
import path from "node:path";
import JSONBigFactory from "json-bigint";
import {
  assertVideoId,
  validateCreatePayload,
  validateEditPayload,
  validateFolderPayload,
  validateListVideosOptions,
} from "./validation.js";
import { PDP_CREATE_ROUTE, normalizePdpPayload } from "./pdp.js";
import { normalizeWalletLedgerOptions } from "./wallet.js";

export {
  validateCreatePayload,
  validateEditPayload,
  validateFolderPayload,
  validateListVideosOptions,
} from "./validation.js";
export {
  PDP_CREATE_PATH,
  PDP_CREATE_ROUTE,
  describePdpDryRun,
  normalizePdpPayload,
  validatePdpPayload,
} from "./pdp.js";
export { normalizeWalletLedgerOptions } from "./wallet.js";

const API_PREFIX = "/openapi/v1";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled"]);
const DEFAULT_RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const JSON_BIG = JSONBigFactory({
  storeAsString: true,
  protoAction: "error",
  constructorAction: "error",
});
const DEFAULT_READ_RETRY = Object.freeze({ maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 30_000 });

export const MIN_INITIAL_POLL_DELAY_SECONDS = 5;
export const MIN_FALLBACK_POLL_DELAY_SECONDS = 1;
export const MAX_UPLOAD_IMAGE_BYTES = 20 * 1024 * 1024;
const UPLOAD_IMAGE_TYPES = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});

export class GrowthStudioApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "GrowthStudioApiError";
    this.category = options.category;
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.retryAfter = options.retryAfter;
    this.details = options.details;
  }
}

export function buildUrl(baseUrl, requestPath, query = {}) {
  const url = new URL(requestPath, withTrailingSlash(baseUrl));
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export function getRetryAfterSeconds(headers) {
  const value = headers.get("retry-after");
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return undefined;
}

export async function parseResponse(response) {
  const requestId = response.headers.get("x-request-id");
  const retryAfter = getRetryAfterSeconds(response.headers);
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = toPlainJson(JSON_BIG.parse(text));
    } catch {
      if (response.ok) {
        throw new GrowthStudioApiError("PixVerse API returned invalid JSON in a successful response.", {
          category: "protocol",
          status: response.status,
          code: "INVALID_JSON_RESPONSE",
          retryable: false,
          requestId,
        });
      }
    }
  }

  if (!response.ok) {
    const error = isRecord(body?.error) ? body.error : {};
    throw new GrowthStudioApiError(error.message || `PixVerse API request failed with HTTP ${response.status}.`, {
      status: response.status,
      code: error.code,
      retryable: typeof error.retryable === "boolean"
        ? error.retryable
        : DEFAULT_RETRYABLE_STATUSES.has(response.status),
      requestId: body?.request_id || requestId,
      retryAfter,
      details: error.details,
    });
  }

  return {
    body,
    headers: response.headers,
    requestId: body?.request_id || requestId,
    retryAfter,
  };
}

export class GrowthStudioClient {
  constructor({
    apiKey,
    baseUrl,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    now = Date.now,
    readRetry = DEFAULT_READ_RETRY,
  }) {
    if (!fetchImpl) throw new Error("A fetch implementation is required.");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    this.readRetry = { ...DEFAULT_READ_RETRY, ...readRetry };
  }

  async listAvatars(options = {}) {
    return this.request("GET", "/avatars", { traceId: options.traceId });
  }

  async uploadImage(filePath, options = {}) {
    const type = UPLOAD_IMAGE_TYPES[path.extname(String(filePath)).toLowerCase()];
    if (!type) throw new Error("upload image accepts only .jpg, .jpeg, .png, or .webp files.");
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) throw new Error("upload image requires a regular file.");
    if (stats.size > MAX_UPLOAD_IMAGE_BYTES) {
      throw new Error("upload image files must be 20 MiB or smaller.");
    }
    const file = await fs.openAsBlob(filePath, { type });
    const form = new FormData();
    form.set("image", file, path.basename(filePath));
    return this.request("POST", "/image/upload", {
      body: form,
      traceId: options.traceId,
    });
  }

  async createVideo(payload, options = {}) {
    validateCreatePayload(payload);
    return this.request("POST", "/videos", {
      json: payload,
      traceId: options.traceId,
    });
  }

  async createPdpVideo(payload, options = {}) {
    return this.request("POST", PDP_CREATE_ROUTE, {
      json: normalizePdpPayload(payload),
      traceId: options.traceId,
    });
  }

  async getWalletBalance(options = {}) {
    return this.request("GET", "/wallet/balance", {
      traceId: options.traceId,
    });
  }

  async listWalletLedgers(options = {}) {
    const query = normalizeWalletLedgerOptions(options);
    return this.request("GET", "/wallet/ledgers", {
      query,
      traceId: options.traceId,
    });
  }

  async getVideo(videoId, options = {}) {
    assertVideoId(videoId);
    return this.request("GET", `/videos/${encodeURIComponent(videoId)}`, {
      traceId: options.traceId,
    });
  }

  async listVideos(options = {}) {
    validateListVideosOptions(options);
    return this.request("GET", "/videos", {
      query: {
        limit: options.limit,
        status: options.status,
        cursor: options.cursor,
      },
      traceId: options.traceId,
    });
  }

  async listFolders(options = {}) {
    return this.request("GET", "/folders", {
      traceId: options.traceId,
    });
  }

  async createFolder(payload, options = {}) {
    validateFolderPayload(payload);
    return this.request("POST", "/folders", {
      json: payload,
      traceId: options.traceId,
    });
  }

  async editVideo(videoId, payload, options = {}) {
    assertVideoId(videoId);
    validateEditPayload(payload);
    return this.request("POST", `/videos/${encodeURIComponent(videoId)}/edit`, {
      json: payload,
      traceId: options.traceId,
    });
  }

  async pollVideo(videoId, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    const startedAt = this.now();
    const fallbackDelaySeconds = Math.max(
      MIN_FALLBACK_POLL_DELAY_SECONDS,
      options.fallbackDelaySeconds ?? 5,
    );
    let waitSeconds = Math.max(MIN_INITIAL_POLL_DELAY_SECONDS, options.initialDelaySeconds ?? 5);

    while (true) {
      await this.sleep(waitSeconds * 1000);

      let result;
      try {
        result = await this.getVideo(videoId, { traceId: options.traceId });
      } catch (error) {
        if (!isRetryableReadError(error) || this.now() - startedAt > timeoutMs) throw error;
        waitSeconds = Math.max(MIN_FALLBACK_POLL_DELAY_SECONDS, error.retryAfter ?? fallbackDelaySeconds);
        continue;
      }
      const body = result.body;
      const editStatus = body.edit?.status || body.edit?.latest?.status;
      await options.onSnapshot?.(body);

      if (TERMINAL_STATUSES.has(body.status) && !isEditRunning(editStatus)) {
        return body;
      }

      if (this.now() - startedAt > timeoutMs) {
        throw new Error(`Polling timed out for video_id ${videoId}.`);
      }

      waitSeconds = Math.max(MIN_FALLBACK_POLL_DELAY_SECONDS, result.retryAfter ?? fallbackDelaySeconds);
    }
  }

  async request(method, path, options = {}) {
    const url = buildUrl(this.baseUrl, `${API_PREFIX}${path}`, options.query);
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    headers.set("Accept", "application/json");
    if (options.traceId) headers.set("Ai-Trace-Id", options.traceId);

    let body = options.body;
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.json);
    }

    // Only read-only GET requests are retried. Create, edit, upload, and folder
    // creation have no idempotency keys, so a retry could duplicate billing or data.
    const maxAttempts = method === "GET" ? Math.max(1, this.readRetry.maxAttempts) : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await parseResponse(await this.fetch(url, { method, headers, body }));
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableReadError(error)) throw error;
        await this.sleep(readRetryDelayMs(error.retryAfter, attempt, this.readRetry));
      }
    }
  }
}

export function createProductUrlPayload(sourceUrl, video = {}) {
  return {
    product: {
      source_url: sourceUrl,
    },
    video: {
      aspect_ratio: video.aspectRatio || "9:16",
      duration_seconds: video.durationSeconds || 30,
      resolution: video.resolution || "1080p",
      language: video.language || "en-US",
      voiceover: video.voiceover ?? true,
      captions: video.captions ?? true,
      background_music: video.backgroundMusic ?? true,
      avatar: video.avatar || { mode: "auto" },
      ...(video.folderId ? { folder_id: video.folderId } : {}),
    },
    ...(video.metadata ? { metadata: video.metadata } : {}),
  };
}

function isRetryableReadError(error) {
  return error instanceof GrowthStudioApiError
    && error.retryable === true
    && (error.status === 429 || error.status >= 500);
}

function readRetryDelayMs(retryAfter, attempt, policy) {
  if (retryAfter !== undefined) return retryAfter * 1000;
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** (attempt - 1)));
}

function toPlainJson(value) {
  if (Array.isArray(value)) return value.map(toPlainJson);
  if (value === null || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = toPlainJson(item);
  return output;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEditRunning(status) {
  return status === "queued" || status === "processing";
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}
