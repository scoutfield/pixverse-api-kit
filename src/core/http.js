import JSONBigFactory from "json-bigint";

import { PixverseCliError } from "./errors.js";

const JSON_BIG = JSONBigFactory({
  storeAsString: true,
  protoAction: "error",
  constructorAction: "error",
});
const RETRYABLE_METHODS = new Set(["GET", "HEAD"]);

export async function requestHttp(options) {
  const {
    url,
    method = "GET",
    headers,
    body,
    fetchImpl = globalThis.fetch,
    retry,
    sleep = defaultSleep,
    now = Date.now,
    provider,
    operation,
    traceId: initialTraceId,
    traceHeader = "Ai-trace-id",
    nextTraceId,
    signal,
  } = options;
  const normalizedMethod = method.toUpperCase();
  const maxAttempts = normalizeMaxAttempts(retry?.maxAttempts);
  const canRetry = RETRYABLE_METHODS.has(normalizedMethod) && maxAttempts > 1;
  if (nextTraceId !== undefined && typeof nextTraceId !== "function") {
    throw new TypeError("nextTraceId must be a function.");
  }
  let traceId = initialTraceId;
  let attemptHeaders = headers;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1 && nextTraceId) {
      // PixVerse treats a repeated Ai-trace-id as the same request and can
      // return the cached previous result, so each read-only retry gets a
      // fresh trace. Billable submissions never reach this path: they are
      // single-attempt and deliberately keep their persisted recovery trace.
      traceId = nextTraceId();
      attemptHeaders = withHeader(headers, traceHeader, traceId);
    }
    let response;
    try {
      response = await fetchImpl(url, { method: normalizedMethod, headers: attemptHeaders, body, signal });
    } catch (cause) {
      const aborted = signal?.aborted === true || cause?.name === "AbortError";
      const error = new PixverseCliError("PixVerse API transport request failed.", {
        category: "transport",
        provider,
        operation,
        retryable: canRetry && !aborted,
        traceId,
        cause,
        details: { cause: cause instanceof Error ? cause.message : String(cause) },
      });
      if (aborted || !canRetry || attempt === maxAttempts) throw error;
      await sleep(retryDelayMilliseconds(retry, attempt));
      continue;
    }

    const retryAfter = parseRetryAfter(response.headers.get("retry-after"), now());
    const retryableStatus = response.status === 429 || response.status >= 500;
    let responseBody;
    try {
      responseBody = await parseBody(response, { provider, operation, traceId });
    } catch (error) {
      if (!canRetry || !retryableStatus || attempt === maxAttempts) throw error;
      const delayMs = retryAfter === undefined
        ? retryDelayMilliseconds(retry, attempt)
        : retryAfter * 1_000;
      await sleep(delayMs);
      continue;
    }
    if (response.ok) {
      return {
        body: responseBody,
        headers: response.headers,
        status: response.status,
        retryAfter,
        traceId,
      };
    }

    const error = httpError(response, responseBody, {
      provider,
      operation,
      traceId,
      retryAfter,
      retryable: retryableStatus,
    });
    if (!canRetry || !retryableStatus || attempt === maxAttempts) throw error;

    const delayMs = retryAfter === undefined
      ? retryDelayMilliseconds(retry, attempt)
      : retryAfter * 1_000;
    await sleep(delayMs);
  }

  throw new PixverseCliError("PixVerse API retry policy exhausted.", {
    category: "transport",
    provider,
    operation,
    traceId,
  });
}

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, Math.ceil((dateMs - nowMs) / 1_000));
}

async function parseBody(response, context) {
  const text = await response.text();
  if (text === "") return null;

  try {
    return JSON_BIG.parse(text);
  } catch (cause) {
    throw new PixverseCliError("Could not parse JSON response from PixVerse API.", {
      category: "response",
      provider: context.provider,
      operation: context.operation,
      status: response.status,
      traceId: context.traceId,
      cause,
    });
  }
}

function httpError(response, body, context) {
  const apiError = body && typeof body === "object" ? body.error : undefined;
  const message = apiError && typeof apiError === "object"
    ? apiError.message
    : undefined;
  const code = apiError && typeof apiError === "object"
    ? apiError.code
    : undefined;

  return new PixverseCliError(message || `PixVerse API request failed with HTTP ${response.status}.`, {
    category: "http",
    provider: context.provider,
    operation: context.operation,
    status: response.status,
    code,
    retryable: context.retryable,
    retryAfter: context.retryAfter,
    traceId: context.traceId,
    details: body,
  });
}

function withHeader(headers, name, value) {
  if (headers instanceof Headers) {
    const copy = new Headers(headers);
    copy.set(name, value);
    return copy;
  }
  const copy = {};
  const lowerName = name.toLowerCase();
  for (const [key, entry] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== lowerName) copy[key] = entry;
  }
  copy[name] = value;
  return copy;
}

function normalizeMaxAttempts(value) {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("retry.maxAttempts must be a positive safe integer.");
  }
  return value;
}

function retryDelayMilliseconds(retry, attempt) {
  const baseDelay = retry?.delayMs ?? 0;
  const maxDelay = retry?.maxDelayMs ?? Number.MAX_SAFE_INTEGER;
  return Math.min(maxDelay, baseDelay * (2 ** Math.max(0, attempt - 1)));
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
