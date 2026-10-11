import { PixverseCliError } from "../core/errors.js";
import { requestHttp } from "../core/http.js";
import { createTraceId } from "../core/trace.js";
import { DEFAULT_PLATFORM_BASE_URL } from "./config.js";
import { parsePlatformEnvelope } from "./envelope.js";
import { getPlatformOperation } from "./operations.js";
import { buildPlatformRequest } from "./request.js";
import { normalizeAndValidatePlatformInput } from "./validation.js";

const RECOVERY_TRACE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETRYABLE_METHODS = new Set(["GET", "HEAD"]);

export class PlatformClient {
  constructor({
    apiKey,
    baseUrl = DEFAULT_PLATFORM_BASE_URL,
    fetchImpl = globalThis.fetch,
    sleep,
    inspectLocalMedia,
    traceIdFactory = createTraceId,
    retry = { maxAttempts: 3, delayMs: 250, maxDelayMs: 2_000 },
  }) {
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new TypeError("A Platform API key is required.");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
    if (typeof traceIdFactory !== "function") throw new TypeError("A trace ID factory is required.");
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.inspectLocalMedia = inspectLocalMedia;
    this.traceIdFactory = traceIdFactory;
    this.retry = Object.freeze({ ...retry });
  }

  async execute(operationId, input, options = {}) {
    const operation = getPlatformOperation(operationId);
    if (!operation) throw unknownOperationError(operationId);
    const traceId = resolveTraceId(operation, options, this.traceIdFactory);
    const normalizedInput = await normalizeAndValidatePlatformInput(operation, input, {
      inspectLocalMedia: options.inspectLocalMedia ?? this.inspectLocalMedia,
    });
    const request = await buildPlatformRequest(operation, normalizedInput);
    const headers = new Headers(request.headers);
    headers.set("Accept", "application/json");
    headers.set("API-KEY", this.apiKey);
    headers.set("Ai-trace-id", traceId);
    const retrySafe = operation.billing === "read-only" && RETRYABLE_METHODS.has(operation.method);
    const retry = retrySafe ? this.retry : { maxAttempts: 1 };

    let response;
    try {
      response = await requestHttp({
        url: new URL(request.path, `${this.baseUrl}/`),
        method: request.method,
        headers,
        body: request.body,
        fetchImpl: this.fetchImpl,
        retry,
        sleep: this.sleep,
        provider: "platform",
        operation: operation.id,
        traceId,
        // Read-only retries need a unique Ai-trace-id per attempt. A recovery
        // trace is never rotated: it only exists for single-attempt submissions.
        nextTraceId: retrySafe && options.recovery !== true ? this.traceIdFactory : undefined,
        signal: options.signal,
      });
    } catch (error) {
      if (hasPlatformEnvelope(error?.details)) {
        parsePlatformEnvelope(normalizePlatformResponseIdentifiers(error.details), {
          operation: operation.id,
          httpStatus: error.status,
          traceId: error.traceId ?? traceId,
          retryAfter: error.retryAfter,
        });
      }
      throw error;
    }
    const attemptTraceId = response.traceId ?? traceId;
    const parsed = parsePlatformEnvelope(normalizePlatformResponseIdentifiers(response.body), {
      operation: operation.id,
      httpStatus: response.status,
      traceId: attemptTraceId,
      retryAfter: response.retryAfter,
    });

    return {
      operation: operation.id,
      traceId: attemptTraceId,
      envelope: parsed.envelope,
      data: parsed.data,
      retryAfter: response.retryAfter,
    };
  }
}

export function normalizePlatformResponseIdentifiers(value, fieldName = "") {
  if (Array.isArray(value)) {
    return value.map((item) => normalizePlatformResponseIdentifiers(item, fieldName));
  }
  if (value !== null && typeof value === "object") {
    const normalized = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
    for (const [name, item] of Object.entries(value)) {
      normalized[name] = normalizePlatformResponseIdentifiers(item, name);
    }
    return normalized;
  }
  if (isResourceIdentifierField(fieldName)
    && typeof value === "number"
    && Number.isSafeInteger(value)) {
    return String(value);
  }
  return value;
}

function resolveTraceId(operation, options, traceIdFactory) {
  if (options.recovery !== true) return traceIdFactory();
  if (typeof options.traceId !== "string" || !RECOVERY_TRACE_PATTERN.test(options.traceId)) {
    throw new PixverseCliError("Recovery requires a saved UUID trace ID.", {
      category: "validation",
      provider: "platform",
      operation: operation.id,
      code: "INVALID_RECOVERY_TRACE",
      retryable: false,
    });
  }
  return options.traceId;
}

function hasPlatformEnvelope(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.hasOwn(value, "ErrCode");
}

function isResourceIdentifierField(fieldName) {
  return fieldName.toLowerCase() !== "keyframe_id"
    && /(?:^|_)(?:id|ids)$/i.test(fieldName);
}

function unknownOperationError(operationId) {
  return new PixverseCliError(`Unknown Platform operation: ${String(operationId)}.`, {
    category: "validation",
    provider: "platform",
    operation: typeof operationId === "string" ? operationId : undefined,
    code: "UNKNOWN_PLATFORM_OPERATION",
    retryable: false,
  });
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Platform base URL must be a valid HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new TypeError("Platform base URL must be a valid HTTP or HTTPS URL.");
  }
  return url.toString().replace(/\/$/, "");
}
