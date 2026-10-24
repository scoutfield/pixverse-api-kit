import { PixverseCliError } from "../core/errors.js";

// Documented transient ErrCodes. 500069 is "system under high load, try again
// later"; 500044 is the concurrent-generation limit, which clears as running
// jobs finish. Marking them retryable lets read-only callers (status polling)
// keep waiting. It never authorizes an automatic billable resubmission: POST
// submissions are single-attempt regardless of this flag.
const RETRYABLE_PLATFORM_ERROR_CODES = new Set([500044, 500069]);

export function isRetryablePlatformErrorCode(code) {
  return RETRYABLE_PLATFORM_ERROR_CODES.has(Number(code));
}

export function parsePlatformEnvelope(body, context = {}) {
  if (!isEnvelope(body)) {
    throw new PixverseCliError("Invalid Platform API response envelope.", {
      category: "response",
      provider: "platform",
      operation: context.operation,
      status: context.httpStatus,
      traceId: context.traceId,
      details: body,
    });
  }

  const errorCode = Number(body.ErrCode);
  if (errorCode !== 0) {
    throw new PixverseCliError(platformErrorMessage(body), {
      category: "provider",
      provider: "platform",
      operation: context.operation,
      status: context.httpStatus,
      code: body.ErrCode,
      traceId: context.traceId,
      retryable: isRetryablePlatformErrorCode(errorCode),
      ...(Number.isFinite(context.retryAfter) ? { retryAfter: context.retryAfter } : {}),
      details: body,
    });
  }

  return {
    envelope: body,
    data: body.Resp,
  };
}

// Error Details: an optional Error object explains the cause, the related
// fields, and the values the endpoint accepts.
function platformErrorMessage(body) {
  const base = body.ErrMsg || `Platform API failed with ErrCode ${body.ErrCode}.`;
  const detail = body.Error;
  if (detail === null || typeof detail !== "object" || typeof detail.Message !== "string" || detail.Message === "") {
    return base;
  }
  const allowed = Array.isArray(detail.Param?.AllowedValues) && detail.Param.AllowedValues.length > 0
    ? ` Allowed values: ${detail.Param.AllowedValues.join(", ")}.`
    : "";
  return `${base}: ${detail.Message}${allowed}`;
}

function isEnvelope(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("ErrCode" in value)) return false;
  if (typeof value.ErrCode === "number") return Number.isFinite(value.ErrCode);
  return typeof value.ErrCode === "string" && /^\d+$/.test(value.ErrCode);
}
