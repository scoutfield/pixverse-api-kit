import fs from "node:fs/promises";
import path from "node:path";

import {
  appendJsonLineArtifact,
  createJobDirectory,
  readJsonArtifact,
  writeJsonArtifact,
} from "../core/artifacts.js";
import { isTransientReadError, PixverseCliError, serializeError } from "../core/errors.js";
import { pollUntilTerminal } from "../core/polling.js";
import { redact } from "../core/redaction.js";
import { createTraceId } from "../core/trace.js";
import { getPlatformOperation } from "./operations.js";
import { normalizePlatformStatus } from "./status.js";
import { normalizeAndValidatePlatformInput } from "./validation.js";

// Official status guidance: poll no more often than every 5 seconds.
const DEFAULT_INTERVAL_MS = 5_000;
// Generation can legitimately run well past 10 minutes (the FAQ covers jobs
// exceeding 10 minutes and 2 hours). A timeout is resumable from the job
// directory, so this only bounds a single waiting session.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;

export async function submitPlatformJob(client, operationId, input, options = {}) {
  const operation = requireBillableOperation(operationId);
  const validate = options.validate ?? normalizeAndValidatePlatformInput;
  const normalized = await validate(operation, input, {
    inspectLocalMedia: options.inspectLocalMedia,
  });
  const traceId = (options.traceIdFactory ?? createTraceId)();
  const jobRoot = path.resolve(options.jobRoot ?? defaultJobRoot(options.cwd));
  const jobDir = await createJobDirectory(jobRoot, {
    name: operation.id,
    now: options.jobNow ?? options.now,
  });

  await writeArtifact(jobDir, "request.json", redact({
    provider: "platform",
    operation: operation.id,
    documentation_url: operation.documentationUrl,
    trace_id: traceId,
    headers: { "API-KEY": "[REDACTED]", "Ai-trace-id": traceId },
    input: normalized,
  }));

  try {
    const executionInput = {
      payload: normalized.payload,
      query: normalized.query,
      pathParams: normalized.pathParams,
      files: normalized.files,
    };
    const created = await client.execute(operation.id, executionInput, {
      recovery: true,
      traceId,
      inspectLocalMedia: options.inspectLocalMedia,
      signal: options.signal,
    });
    await writeArtifact(jobDir, "create-response.json", redact(created.envelope));
    const id = extractResultId(operation, created.envelope);
    if (id !== undefined) await writeIdArtifact(jobDir, operation, id);

    if (!operation.asynchronous || !options.poll) {
      if (!operation.asynchronous) {
        const final = {
          ...submittedResult({ operation, created, id, jobDir, status: "succeeded" }),
          terminal: true,
        };
        await writeArtifact(jobDir, "final.json", final);
        return final;
      }
      return submittedResult({ operation, created, id, jobDir, status: "submitted" });
    }
    if (id === undefined) throw jobError("Platform response did not contain the documented result ID.", {
      category: "response", operation: operation.id, traceId, code: "MISSING_PLATFORM_JOB_ID",
    });
    return await pollKnownJob(client, {
      jobDir, operation, id, traceId, options,
    });
  } catch (error) {
    await persistFailure(jobDir, error, { operation: operation.id, traceId });
    throw error;
  }
}

export async function resumePlatformJob(client, jobDirectory, options = {}) {
  const jobDir = path.resolve(jobDirectory);
  const request = await readJsonArtifact(path.join(jobDir, "request.json"), { rootDir: jobDir });
  const operation = requireBillableOperation(request.operation);
  const completed = await readOptionalArtifact(jobDir, "final.json");
  if (completed?.terminal === true) return { ...completed, job_dir: jobDir };

  const idRecord = await readOptionalArtifact(jobDir, idArtifactName(operation));
  const id = idRecord?.[idField(operation)];
  if (typeof id !== "string" || id === "") {
    return {
      provider: "platform",
      operation: operation.id,
      trace_id: request.trace_id,
      job_dir: jobDir,
      status: "reconciliation_required",
      retryable: false,
    };
  }

  if (completed) await archiveTimeoutFinal(jobDir);

  return pollKnownJob(client, {
    jobDir,
    operation,
    id,
    traceId: request.trace_id,
    options,
  });
}

async function archiveTimeoutFinal(jobDir) {
  const source = path.join(jobDir, "final.json");
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const target = path.join(jobDir, `final-timeout-${index}.json`);
    try {
      await fs.link(source, target);
      await fs.unlink(source);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not preserve the prior timeout artifact.");
}

async function pollKnownJob(client, { jobDir, operation, id, traceId, options }) {
  let lastSnapshot;
  let retryAfterMs = 0;
  try {
    const finalSnapshot = await pollUntilTerminal({
      poll: async () => {
        const statusOperation = operation.id.startsWith("image.") ? "image.status" : "video.status";
        const idInput = statusOperation === "image.status" ? { image_id: id } : { video_id: id };
        const result = await client.execute(statusOperation, idInput, { signal: options.signal });
        retryAfterMs = Number.isFinite(result.retryAfter) ? result.retryAfter * 1_000 : 0;
        const normalizedStatus = normalizePlatformStatus(result.data?.status);
        lastSnapshot = {
          status: normalizedStatus.status,
          raw_status: normalizedStatus.rawStatus,
          terminal: normalizedStatus.terminal,
          trace_id: result.traceId,
          ...(result.retryAfter === undefined ? {} : { retry_after: result.retryAfter }),
          envelope: redact(result.envelope),
          data: redact(result.data),
        };
        return lastSnapshot;
      },
      isTerminal: (snapshot) => snapshot.terminal,
      onSnapshot: (snapshot) => appendJsonLineArtifact(
        path.join(jobDir, "polling.jsonl"), snapshot, { rootDir: jobDir },
      ),
      // A status read is read-only: transport failures, HTTP 429/5xx, and
      // retryable ErrCodes (for example 500069 high load) must not abandon a
      // job that is still generating. Keep polling with backoff until the
      // overall timeout. The billable submission above is never retried.
      isRetryableError: (error) => options.signal?.aborted !== true && isTransientReadError(error),
      onPollError: (error, { consecutiveErrors }) => appendJsonLineArtifact(
        path.join(jobDir, "polling.jsonl"),
        transientPollRecord(error, consecutiveErrors),
        { rootDir: jobDir },
      ),
      intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      sleep: async (milliseconds) => {
        const delay = Math.max(milliseconds, retryAfterMs);
        retryAfterMs = 0;
        await (options.sleep ?? defaultSleep)(delay);
      },
      now: options.now,
      provider: "platform",
      operation: operation.id,
      traceId,
    });
    const final = finalJobSnapshot({ operation, traceId, jobDir, id, snapshot: finalSnapshot });
    await writeArtifact(jobDir, "final.json", final);
    if (final.status !== "succeeded") throw terminalStatusError(final);
    return final;
  } catch (error) {
    const recoveryError = error?.category === "timeout"
      ? timeoutRecoveryError(error, { jobDir, id })
      : error;
    if (error?.category === "timeout" && lastSnapshot) {
      await writeArtifactIfMissing(jobDir, "final.json", finalJobSnapshot({
        operation, traceId, jobDir, id, snapshot: lastSnapshot,
      }));
    }
    await persistFailure(jobDir, recoveryError, { operation: operation.id, traceId });
    throw recoveryError;
  }
}

function transientPollRecord(error, consecutiveErrors) {
  const publicError = serializeError(error);
  return redact({
    status: "poll_error",
    terminal: false,
    transient: true,
    consecutive_errors: consecutiveErrors,
    error: {
      category: publicError.category ?? inferErrorCategory(error),
      ...(publicError.status === undefined ? {} : { status: publicError.status }),
      ...(publicError.code === undefined ? {} : { code: publicError.code }),
      ...(publicError.retry_after === undefined ? {} : { retry_after: publicError.retry_after }),
      ...(publicError.trace_id === undefined ? {} : { trace_id: publicError.trace_id }),
    },
  });
}

function timeoutRecoveryError(error, { jobDir, id }) {
  return new PixverseCliError(error.message, {
    category: error.category,
    provider: error.provider,
    operation: error.operation,
    status: error.status,
    code: error.code,
    retryable: error.retryable,
    retryAfter: error.retryAfter,
    traceId: error.traceId,
    requestId: error.requestId,
    details: redact({
      ...(error.details ?? {}),
      job_dir: jobDir,
      id: String(id),
    }),
    cause: error,
  });
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function submittedResult({ operation, created, id, jobDir, status }) {
  return {
    provider: "platform",
    operation: operation.id,
    trace_id: created.traceId,
    job_dir: jobDir,
    ...(id === undefined ? {} : { id }),
    status,
    envelope: redact(created.envelope),
    data: redact(created.data),
  };
}

function finalJobSnapshot({ operation, traceId, jobDir, id, snapshot }) {
  return {
    provider: "platform",
    operation: operation.id,
    job_dir: jobDir,
    id: String(id),
    ...snapshot,
    status_trace_id: snapshot.trace_id,
    trace_id: traceId,
  };
}

function extractResultId(operation, envelope) {
  if (!operation.resultIdPath) return undefined;
  const value = operation.resultIdPath.split(".").reduce((current, segment) => current?.[segment], envelope);
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

async function writeIdArtifact(jobDir, operation, id) {
  await writeArtifact(jobDir, idArtifactName(operation), { [idField(operation)]: String(id) });
}

function idArtifactName(operation) {
  return operation.id.startsWith("image.") ? "image-id.json" : "video-id.json";
}

function idField(operation) {
  return operation.id.startsWith("image.") ? "image_id" : "video_id";
}

function terminalStatusError(final) {
  const messages = {
    deleted: "Platform job was deleted.",
    moderation_failed: "Platform job failed moderation.",
    failed: "Platform generation failed.",
  };
  return jobError(messages[final.status] ?? "Platform job ended unsuccessfully.", {
    category: final.status,
    operation: final.operation,
    traceId: final.trace_id,
    code: `PLATFORM_${final.status.toUpperCase()}`,
    details: { id: final.id, status: final.status, raw_status: final.raw_status },
  });
}

function requireBillableOperation(operationId) {
  const operation = getPlatformOperation(operationId);
  if (!operation || operation.billing !== "billable") {
    throw jobError("A billable Platform catalog operation is required.", {
      category: "validation", operation: typeof operationId === "string" ? operationId : undefined,
      code: "INVALID_PLATFORM_JOB_OPERATION",
    });
  }
  return operation;
}

function defaultJobRoot(cwd) {
  return path.join(cwd ?? process.cwd(), "pixverse-api-jobs", "platform");
}

async function writeArtifact(jobDir, name, value) {
  await writeJsonArtifact(path.join(jobDir, name), value, { rootDir: jobDir });
}

async function writeArtifactIfMissing(jobDir, name, value) {
  if (await readOptionalArtifact(jobDir, name)) return;
  await writeArtifact(jobDir, name, value);
}

async function readOptionalArtifact(jobDir, name) {
  try {
    return await readJsonArtifact(path.join(jobDir, name), { rootDir: jobDir });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function persistFailure(jobDir, error, context) {
  const publicError = serializeError(error);
  await writeArtifactIfMissing(jobDir, "error.json", redact({
    name: publicError.name,
    message: "Platform job failed. Inspect category, code, trace_id, and saved artifacts before recovery.",
    category: publicError.category ?? inferErrorCategory(error),
    provider: "platform",
    operation: publicError.operation ?? context.operation,
    ...(publicError.status === undefined ? {} : { status: publicError.status }),
    ...(publicError.code === undefined ? {} : { code: publicError.code }),
    ...(publicError.retryable === undefined ? {} : { retryable: publicError.retryable }),
    ...(publicError.retry_after === undefined ? {} : { retry_after: publicError.retry_after }),
    trace_id: publicError.trace_id ?? context.traceId,
  }));
}

function inferErrorCategory(error) {
  if (error instanceof TypeError) return "transport";
  return "unknown";
}

function jobError(message, fields) {
  return new PixverseCliError(message, {
    provider: "platform",
    retryable: false,
    ...fields,
  });
}
