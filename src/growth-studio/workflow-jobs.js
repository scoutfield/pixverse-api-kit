import path from "node:path";
import { randomUUID } from "node:crypto";
import { createJobDirectory, writeJsonArtifact, readJsonArtifact, appendJsonLineArtifact } from "../core/artifacts.js";
import { redact } from "../core/redaction.js";
import { serializeError } from "../core/errors.js";
import { workflowSpec, normalizeWorkflowPayload, assertResourceId } from "./workflows.js";

// Signed import URLs can contain credentials in arbitrary query names. Retain the
// origin/path for reconciliation, but do not persist any URL query or fragment.
function evidence(value) {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const sensitive = url.search || url.hash || url.username || url.password;
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      return sensitive ? `${url.href}#[REDACTED]` : value;
    } catch { return value; }
  }
  if (Array.isArray(value)) return value.map(evidence);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(redact(value)).map(([key, item]) => [key, evidence(item)]));
  return value;
}

async function write(jobDir, file, value) {
  return writeJsonArtifact(path.join(jobDir, file), evidence(value), { rootDir: jobDir });
}

async function optional(jobDir, file) {
  try { return await readJsonArtifact(path.join(jobDir, file), { rootDir: jobDir }); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

function resources(name, body) {
  const spec = workflowSpec(name);
  const entries = spec.batch ? body?.videos : [body];
  if (!Array.isArray(entries) || !entries.length) throw new Error("Create response has no resource identifiers; reconciliation required.");
  const ids = entries.map((entry) => {
    assertResourceId(entry?.[spec.id], spec.id);
    return { [spec.id]: entry[spec.id], ...(entry.input_indices === undefined ? {} : { input_indices: entry.input_indices }) };
  });
  if (new Set(ids.map((entry) => entry[spec.id])).size !== ids.length) throw new Error("Duplicate resource IDs in create response; reconciliation required.");
  return ids;
}

async function failure(jobDir, error) {
  const safe = serializeError(error);
  const record = {
    ...safe, message: "Growth Studio request interrupted. Resume saved IDs; never repeat creation automatically.",
    job_dir: jobDir,
  };
  await write(jobDir, `error-${randomUUID()}.json`, record);
  await write(jobDir, "error.json", record);
  // Return the durable recovery location even when the submission outcome is unknown.
  error.details = { ...error.details, job_dir: jobDir, recovery: "resume; reconcile if no resource IDs were saved" };
}

export async function runWorkflowJob(client, name, payload, options = {}) {
  const spec = workflowSpec(name);
  const body = normalizeWorkflowPayload(name, payload);
  const jobDir = await createJobDirectory(path.resolve(options.jobsDir ?? "jobs"), { name: options.jobName ?? name });
  const traceId = options.traceId ?? randomUUID();
  await write(jobDir, "request.json", {
    provider: "growth-studio", workflow: name, endpoint: `/openapi/v1${spec.path}`,
    trace_id: traceId, created_at: new Date().toISOString(), payload: body,
  });
  try {
    const result = await client.createWorkflow(name, body, { traceId });
    // Keep the response before interpreting any identifiers, including on malformed acceptance.
    await write(jobDir, "create-response.json", result.body);
    const ids = resources(name, result.body);
    await write(jobDir, "resource-ids.json", ids);
    if (name === "viral-clone") await write(jobDir, "run-id.json", ids[0]);
    if (result.body.ledger_source_id !== undefined) {
      assertResourceId(result.body.ledger_source_id, "ledger_source_id");
      await write(jobDir, "ledger-source-id.json", { ledger_source_id: result.body.ledger_source_id });
    }
    if (spec.synchronous) {
      await write(jobDir, "final.json", result.body);
      return { job_dir: jobDir, workflow: name, ...result.body };
    }
    if (options.poll === false) return { job_dir: jobDir, workflow: name, ...result.body };
    return await pollSaved(client, jobDir, name, ids, { ...options, traceId });
  } catch (error) {
    await failure(jobDir, error);
    throw error;
  }
}

export async function resumeWorkflowJob(getClient, name, directory, options = {}) {
  workflowSpec(name);
  const jobDir = path.resolve(directory);
  const request = await optional(jobDir, "request.json");
  if (request?.provider !== "growth-studio" || request.workflow !== name) throw new Error(`Job is not a Growth Studio ${name} workflow.`);
  const ids = await optional(jobDir, "resource-ids.json");
  if (!ids) return { job_dir: jobDir, workflow: name, status: "reconciliation_required", retryable: false };
  // Validate all persisted IDs before loading credentials or making any query.
  resources(name, workflowSpec(name).batch ? { videos: ids } : ids[0]);
  const final = await optional(jobDir, "final.json");
  if (final) return workflowResult(jobDir, name, final);
  try { return await pollSaved(getClient(), jobDir, name, ids, { ...options, traceId: request.trace_id }); }
  catch (error) { await failure(jobDir, error); throw error; }
}

function workflowResult(jobDir, name, body) {
  const output = name === "viral-clone" ? {
    video_url: body.output?.video_url,
    thumbnail_url: body.output?.thumbnail_url,
    mime_type: body.output?.mime_type,
  } : {};
  return { job_dir: jobDir, workflow: name, ...output, ...body };
}

async function pollSaved(client, jobDir, name, ids, options) {
  const spec = workflowSpec(name);
  const results = [];
  for (const entry of ids) {
    const id = entry[spec.id];
    assertResourceId(id, spec.id);
    const file = `result-${id}.json`;
    let result = await optional(jobDir, file);
    if (!result) {
      result = await client.pollWorkflow(name, id, {
        ...options,
        onSnapshot: (snapshot) => appendJsonLineArtifact(path.join(jobDir, "polling.jsonl"), evidence({ ...entry, resource: snapshot }), { rootDir: jobDir }),
      });
      if (!spec.terminal.includes(result.status)) throw new Error("Polling returned a nonterminal resource.");
      await write(jobDir, file, result);
    }
    results.push({ ...result, ...entry });
  }
  const ledger = await optional(jobDir, "ledger-source-id.json");
  // A completed batch is settled, not necessarily successful. Keep each status/error.
  const final = spec.batch ? { status: "completed", videos: results, ...ledger } : { ...results[0], ...ledger };
  await write(jobDir, "final.json", final);
  return workflowResult(jobDir, name, final);
}
