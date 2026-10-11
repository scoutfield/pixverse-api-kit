import fs from "node:fs/promises";
import path from "node:path";
import {
  appendJsonLineArtifact,
  createJobDirectory,
  readJsonArtifact,
  writeJsonArtifact,
} from "../core/artifacts.js";
import { serializeError } from "../core/errors.js";
import { redact } from "../core/redaction.js";
import { resolveFolderForPayload } from "./folders.js";
import { PDP_CREATE_PATH, normalizePdpPayload } from "./pdp.js";

const DEFAULT_JOBS_DIR = "jobs";

export async function runVideoJob(client, payload, options = {}) {
  const jobDir = await createJobDir(options.jobsDir || DEFAULT_JOBS_DIR, options.jobName);
  const traceBase = options.traceId || path.basename(jobDir);
  try {
    const folder = await resolveFolderForPayload(client, payload, {
      autoFolder: options.autoFolder,
      folderId: options.folderId,
      folderName: options.folderName,
      traceId: traceBase,
    });
    const createPayload = withFolderId(payload, folder?.folderId);

    if (folder) await writeArtifact(jobDir, "folder.json", redact(folder));

    return await runDurableVideoSubmission(
      client,
      createPayload,
      { ...options, workflow: undefined, endpoint: undefined },
      (requestOptions) => client.createVideo(createPayload, requestOptions),
      { jobDir, traceBase, folder, deferFailure: true },
    );
  } catch (error) {
    await persistFailure(jobDir, error, traceBase);
    throw error;
  }
}

export const runGrowthStudioJob = runVideoJob;

export async function runPdpJob(client, publicPayload, options = {}) {
  const wirePayload = normalizePdpPayload(publicPayload);
  const submissionPayload = {
    product: wirePayload.product,
    video: wirePayload.video,
  };
  return runDurableVideoSubmission(client, wirePayload, {
    ...options,
    workflow: "pdp",
    endpoint: PDP_CREATE_PATH,
  }, (requestOptions) => client.createPdpVideo(submissionPayload, requestOptions));
}

export async function resumeGrowthStudioJob(client, jobDirectory, options = {}) {
  const jobDir = path.resolve(jobDirectory);
  const request = await readJsonArtifact(path.join(jobDir, "request.json"), { rootDir: jobDir });
  if (options.expectedWorkflow && request.workflow !== options.expectedWorkflow) {
    throw new Error(`Growth Studio job is not a ${options.expectedWorkflow} workflow.`);
  }

  const ledgerSourceId = await readSavedLedgerSourceId(jobDir);
  const resultOptions = {
    workflow: request.workflow,
    ledgerSourceId,
    includeFolderFields: request.workflow !== "pdp",
  };
  const videoId = (await readOptionalArtifact(jobDir, "video-id.json"))?.video_id;
  if (request.workflow === "pdp" && !isNonEmptyString(videoId)) {
    return reconciliationResult(jobDir, request, ledgerSourceId);
  }

  const completed = await readOptionalArtifact(jobDir, "final.json");
  if (completed && isTerminal(completed.status)) {
    return resultFromFinal(jobDir, videoId, completed, undefined, resultOptions);
  }

  if (typeof videoId !== "string" || videoId === "") {
    return reconciliationResult(jobDir, request, ledgerSourceId);
  }

  if (completed) await archivePriorFinal(jobDir);

  try {
    const final = await pollKnownVideo(client, jobDir, videoId, request.trace_id, options);
    return resultFromFinal(jobDir, videoId, final, undefined, resultOptions);
  } catch (error) {
    await persistFailure(jobDir, error, request.trace_id, { preserveExisting: true });
    throw error;
  }
}

export async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function createJobDir(rootDir, jobName) {
  return createJobDirectory(path.resolve(rootDir), { name: jobName || "pixverse-api-job" });
}

async function runDurableVideoSubmission(client, artifactPayload, options, submission, context = {}) {
  const jobDir = context.jobDir
    ?? await createJobDir(options.jobsDir || DEFAULT_JOBS_DIR, options.jobName);
  const traceBase = context.traceBase ?? options.traceId ?? path.basename(jobDir);

  try {
    await writeArtifact(jobDir, "request.json", redact({
      provider: "growth-studio",
      ...(options.workflow ? { workflow: options.workflow } : {}),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      trace_id: traceBase,
      created_at: new Date().toISOString(),
      payload: artifactPayload,
    }));
    const createResult = await submission({ traceId: `${traceBase}-create` });
    return persistCreatedVideo(client, jobDir, createResult, traceBase, options, context.folder);
  } catch (error) {
    if (!context.deferFailure) await persistFailure(jobDir, error, traceBase);
    throw error;
  }
}

async function persistCreatedVideo(client, jobDir, createResult, traceBase, options, folder) {
  await writeArtifact(jobDir, "create-response.json", redact(createResult.body));

  const videoId = requireStringIdentifier(
    createResult.body.video_id,
    "Create response did not include a string video_id.",
  );
  await writeArtifact(jobDir, "video-id.json", { video_id: videoId });

  let ledgerSourceId;
  if (options.workflow === "pdp" && createResult.body.ledger_source_id !== undefined) {
    ledgerSourceId = requireStringIdentifier(
      createResult.body.ledger_source_id,
      "Create response did not include a string ledger_source_id.",
    );
    await writeArtifact(jobDir, "ledger-source-id.json", { ledger_source_id: ledgerSourceId });
  }

  const final = options.poll === false
    ? createResult.body
    : await pollKnownVideo(client, jobDir, videoId, traceBase, options);

  if (options.poll === false) await writeArtifact(jobDir, "final.json", redact(final));

  return resultFromFinal(jobDir, videoId, final, folder, {
    workflow: options.workflow,
    ledgerSourceId,
    includeFolderFields: options.workflow !== "pdp",
  });
}

async function pollKnownVideo(client, jobDir, videoId, traceBase, options) {
  const final = await client.pollVideo(videoId, {
    traceId: `${traceBase}-poll`,
    timeoutMs: options.timeoutMs,
    initialDelaySeconds: options.initialDelaySeconds,
    fallbackDelaySeconds: options.fallbackDelaySeconds,
    onSnapshot: async (snapshot) => {
      await appendJsonLineArtifact(path.join(jobDir, "polling.jsonl"), redact(snapshot), { rootDir: jobDir });
    },
  });
  await writeArtifact(jobDir, "final.json", redact(final));
  return final;
}

function resultFromFinal(jobDir, videoId, final, folder, options = {}) {
  const result = {
    job_dir: jobDir,
    video_id: videoId,
    status: final.status,
    video_url: final.output?.video_url,
    thumbnail_url: final.output?.thumbnail_url,
    request_id: final.request_id,
  };
  if (options.workflow !== undefined) result.workflow = options.workflow;
  if (options.workflow === "pdp" && options.ledgerSourceId !== undefined) {
    result.ledger_source_id = options.ledgerSourceId;
  }
  if (options.includeFolderFields !== false) {
    result.folder_id = folder?.folderId;
    result.folder_name = folder?.folderName;
  }
  return result;
}

async function writeArtifact(jobDir, name, value) {
  await writeJsonArtifact(path.join(jobDir, name), value, { rootDir: jobDir });
}

async function readOptionalArtifact(jobDir, name) {
  try {
    return await readJsonArtifact(path.join(jobDir, name), { rootDir: jobDir });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readSavedLedgerSourceId(jobDir) {
  const artifact = await readOptionalArtifact(jobDir, "ledger-source-id.json");
  if (artifact === undefined) return undefined;
  return requireStringIdentifier(
    artifact.ledger_source_id,
    "Saved Growth Studio job did not include a string ledger_source_id.",
  );
}

async function writeArtifactIfMissing(jobDir, name, value) {
  if (await readOptionalArtifact(jobDir, name)) return;
  await writeArtifact(jobDir, name, value);
}

async function persistFailure(jobDir, error, traceId, options = {}) {
  if (options.preserveExisting) await archivePriorArtifact(jobDir, "error.json", "error-prior");
  const publicError = serializeError(error);
  await writeArtifactIfMissing(jobDir, "error.json", redact({
    name: publicError.name,
    message: "Growth Studio job failed. Inspect saved artifacts before recovery.",
    category: publicError.category ?? (error instanceof TypeError ? "transport" : "unknown"),
    provider: "growth-studio",
    ...(publicError.status === undefined ? {} : { status: publicError.status }),
    ...(publicError.code === undefined ? {} : { code: publicError.code }),
    ...(publicError.retryable === undefined ? {} : { retryable: publicError.retryable }),
    ...(publicError.retry_after === undefined ? {} : { retry_after: publicError.retry_after }),
    ...(publicError.request_id === undefined ? {} : { request_id: publicError.request_id }),
    ...(publicError.details === undefined ? {} : { details: publicError.details }),
    trace_id: publicError.trace_id ?? traceId,
  }));
}

async function archivePriorFinal(jobDir) {
  await archivePriorArtifact(jobDir, "final.json", "final-prior");
}

async function archivePriorArtifact(jobDir, sourceName, targetPrefix) {
  const source = path.join(jobDir, sourceName);
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const target = path.join(jobDir, `${targetPrefix}-${index}.json`);
    try {
      await fs.link(source, target);
      await fs.unlink(source);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not preserve the prior Growth Studio ${sourceName} artifact.`);
}

function isTerminal(status) {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function reconciliationResult(jobDir, request, ledgerSourceId) {
  return {
    provider: "growth-studio",
    ...(request.workflow === undefined ? {} : { workflow: request.workflow }),
    ...(ledgerSourceId === undefined ? {} : { ledger_source_id: ledgerSourceId }),
    trace_id: request.trace_id,
    job_dir: jobDir,
    status: "reconciliation_required",
    retryable: false,
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function requireStringIdentifier(value, message) {
  if (!isNonEmptyString(value)) throw new Error(message);
  return value;
}

function withFolderId(payload, folderId) {
  if (!folderId || payload?.video?.folder_id === folderId) return payload;
  return {
    ...payload,
    video: { ...payload.video, folder_id: folderId },
  };
}
