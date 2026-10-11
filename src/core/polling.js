import { PixverseCliError, serializeError } from "./errors.js";

export async function pollUntilTerminal(options) {
  const {
    poll,
    isTerminal,
    onSnapshot = async () => {},
    intervalMs = 3_000,
    timeoutMs = 10 * 60 * 1_000,
    sleep = defaultSleep,
    now = Date.now,
    provider,
    operation,
    traceId,
    // Opt-in: when provided and it returns true for a poll() failure, the loop
    // keeps polling (with backoff) until timeoutMs instead of failing. Errors
    // it rejects are rethrown immediately.
    isRetryableError,
    onPollError = async () => {},
    maxBackoffMs = Math.max(intervalMs, 60_000),
  } = options;
  validateOptions({ poll, isTerminal, intervalMs, timeoutMs, isRetryableError });

  const startedAt = now();
  let lastSnapshot;
  let lastError;
  let consecutiveErrors = 0;

  while (true) {
    try {
      lastSnapshot = await poll();
      consecutiveErrors = 0;
      lastError = undefined;
    } catch (error) {
      if (!isRetryableError || !(await isRetryableError(error))) throw error;
      consecutiveErrors += 1;
      lastError = error;
      await onPollError(error, { consecutiveErrors });
      const backoffMs = Math.min(maxBackoffMs, intervalMs * (2 ** (consecutiveErrors - 1)));
      const retryAfterMs = Number.isFinite(error?.retryAfter) ? error.retryAfter * 1_000 : 0;
      const delayMs = Math.max(backoffMs, retryAfterMs);
      const remaining = timeoutMs - (now() - startedAt);
      // Never poll again earlier than the provider asked; if its Retry-After
      // outlasts the deadline, stop now with a resumable timeout.
      if (remaining <= 0 || retryAfterMs > remaining) {
        throw timeoutError({ provider, operation, traceId, timeoutMs, lastSnapshot, lastError });
      }
      await sleep(Math.min(delayMs, remaining));
      continue;
    }
    await onSnapshot(lastSnapshot);
    if (await isTerminal(lastSnapshot)) return lastSnapshot;

    const elapsed = now() - startedAt;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) {
      throw timeoutError({ provider, operation, traceId, timeoutMs, lastSnapshot });
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

function validateOptions({ poll, isTerminal, intervalMs, timeoutMs, isRetryableError }) {
  if (typeof poll !== "function") throw new TypeError("poll must be a function.");
  if (typeof isTerminal !== "function") throw new TypeError("isTerminal must be a function.");
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError("intervalMs must be a positive number.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("timeoutMs must be a non-negative number.");
  }
  if (isRetryableError !== undefined && typeof isRetryableError !== "function") {
    throw new TypeError("isRetryableError must be a function.");
  }
}

function timeoutError({ provider, operation, traceId, timeoutMs, lastSnapshot, lastError }) {
  return new PixverseCliError(`PixVerse polling timed out after ${timeoutMs}ms.`, {
    category: "timeout",
    provider,
    operation,
    traceId,
    retryable: false,
    details: {
      timeout_ms: timeoutMs,
      last_snapshot: lastSnapshot,
      ...(lastError === undefined ? {} : { last_error: summarizeError(lastError) }),
    },
  });
}

function summarizeError(error) {
  const summary = serializeError(error);
  delete summary.details;
  return summary;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
