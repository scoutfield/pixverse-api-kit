import path from "node:path";
import { GrowthStudioClient, createProductUrlPayload } from "./client.js";
import { getGrowthStudioConfig } from "./config.js";
import { resolveFolderForPayload } from "./folders.js";
import {
  readJsonFile,
  resumeGrowthStudioJob,
  runGrowthStudioJob,
  runPdpJob,
} from "./jobs.js";
import { describePdpDryRun } from "./pdp.js";
import { assertVideoId } from "./validation.js";

export const GROWTH_STUDIO_LEGACY_COMMAND_MAPPINGS = Object.freeze({
  avatars: ["avatars", "list"],
  folders: ["folders", "list"],
  "ensure-folder": ["folders", "ensure"],
  "upload-image": ["upload", "image"],
  "create-from-url": ["video", "create-from-url"],
  "create-from-json": ["video", "create-from-json"],
  get: ["video", "get"],
  poll: ["video", "poll"],
  list: ["video", "list"],
  edit: ["video", "edit"],
  "run-job": ["run-job"],
});

export async function runGrowthStudioCommand(args, context = {}) {
  const [resource, operation, ...rest] = args;
  let client;
  const getClient = () => {
    client ??= context.client || createClient(context);
    return client;
  };

  if (resource === "avatars" && operation === "list") {
    return (await getClient().listAvatars({ traceId: traceId("list-avatars") })).body;
  }
  if (resource === "folders" && operation === "list") {
    return (await getClient().listFolders({ traceId: traceId("list-folders") })).body;
  }
  if (resource === "folders" && operation === "ensure") {
    const options = parseEnsureFolderOptions(rest);
    if (!options.folderName) throw new Error("folders ensure requires a folder name.");
    return resolveFolderForPayload(getClient(), {}, {
      folderName: options.folderName,
      traceId: traceId("ensure-folder"),
    });
  }
  if (resource === "upload" && operation === "image") {
    const [filePath] = rest;
    if (!filePath) throw new Error("upload image requires a file path.");
    return (await getClient().uploadImage(filePath, { traceId: traceId("upload-image") })).body;
  }
  if (resource === "video" && operation === "create-from-url") {
    const options = parseCreateOptions(rest, "sourceUrl", "create-from-url");
    if (!options.sourceUrl) throw new Error("video create-from-url requires a product URL.");
    return createFromUrl(getClient(), options);
  }
  if (resource === "video" && operation === "create-from-json") {
    const options = parseCreateOptions(rest, "payloadPath", "create-from-json");
    if (!options.payloadPath) throw new Error("video create-from-json requires a JSON payload path.");
    return createFromJson(getClient(), options);
  }
  if (resource === "video" && (operation === "get" || operation === "status")) {
    const [videoId] = rest;
    return (await getClient().getVideo(videoId, { traceId: traceId("get-video") })).body;
  }
  if (resource === "video" && operation === "poll") {
    const [videoId] = rest;
    return getClient().pollVideo(videoId, { traceId: traceId("poll-video") });
  }
  if (resource === "video" && operation === "list") {
    const options = parseListOptions(rest);
    return (await getClient().listVideos({
      ...options,
      traceId: traceId("list-videos"),
    })).body;
  }
  if (resource === "video" && operation === "edit") {
    const [videoId, clipIndex, ...instructionParts] = rest;
    return (await getClient().editVideo(
      videoId,
      { clip_index: Number(clipIndex), instruction: instructionParts.join(" ") },
      { traceId: traceId("edit-video") },
    )).body;
  }
  if (resource === "pdp" && operation === "create") {
    const options = parsePdpCreateOptions(rest);
    if (!options.payloadPath) throw new Error("pdp create requires --payload <path>.");
    if (options.dryRun && options.confirmBillable) {
      throw new Error("pdp create accepts either --dry-run or --confirm-billable, not both.");
    }
    if (options.dryRun && hasPdpExecutionOptions(options)) {
      throw new Error("pdp create --dry-run does not accept job or polling options.");
    }
    if (!options.dryRun && !options.confirmBillable) {
      throw new Error("pdp create requires --confirm-billable for a live submission.");
    }

    const payload = await readJsonFile(resolveContextPath(context, options.payloadPath));
    if (options.dryRun) return describePdpDryRun(payload);
    return runPdpJob(getClient(), payload, toPdpJobOptions(options, context));
  }
  if (resource === "pdp" && operation === "get") {
    const [videoId, ...extra] = rest;
    if (!videoId || extra.length > 0) throw new Error("pdp get requires exactly one video_id.");
    assertVideoId(videoId);
    return (await getClient().getVideo(videoId, { traceId: traceId("get-pdp") })).body;
  }
  if (resource === "pdp" && operation === "poll") {
    const options = parsePdpPollOptions(rest);
    assertVideoId(options.videoId);
    return getClient().pollVideo(options.videoId, toPdpPollingOptions(options, "poll-pdp"));
  }
  if (resource === "pdp" && operation === "resume") {
    const options = parsePdpResumeOptions(rest);
    const jobDirectory = resolveContextPath(context, options.jobDirectory);
    const resumeClient = getContextClientValue(context) ?? createDeferredResumeClient(getClient);
    return (context.resumeGrowthStudioJob ?? resumeGrowthStudioJob)(resumeClient, jobDirectory, {
      expectedWorkflow: "pdp",
      ...toPdpPollingOptions(options),
    });
  }
  if (resource === "wallet" && operation === "balance") {
    if (rest.length > 0) throw new Error("wallet balance does not accept arguments.");
    return (await getClient().getWalletBalance({ traceId: traceId("wallet-balance") })).body;
  }
  if (resource === "wallet" && operation === "ledgers") {
    const options = parseWalletLedgerOptions(rest);
    return (await getClient().listWalletLedgers({
      ...options,
      traceId: traceId("wallet-ledgers"),
    })).body;
  }
  if (resource === "run-job") {
    const options = parseRunJobOptions([operation, ...rest].filter((value) => value !== undefined));
    if (!options.payloadPath) throw new Error("run-job requires --payload <path>.");
    return runJob(getClient(), options);
  }
  if (resource === "resume") {
    const options = parseResumeOptions([operation, ...rest].filter((value) => value !== undefined));
    const jobDirectory = path.resolve(context.cwd ?? process.cwd(), options.jobDirectory);
    const resumeClient = context.client ?? createDeferredResumeClient(getClient);
    return (context.resumeGrowthStudioJob ?? resumeGrowthStudioJob)(resumeClient, jobDirectory, options);
  }

  throw new Error(`Unknown Growth Studio command: ${args.join(" ")}`);
}

export function mapLegacyGrowthStudioCommand(command, args = []) {
  const mapped = GROWTH_STUDIO_LEGACY_COMMAND_MAPPINGS[command];
  if (!mapped) return null;
  return [...mapped, ...args];
}

export function getGrowthStudioHelp() {
  return `Usage:
  pixverse-api growth-studio avatars list
  pixverse-api growth-studio folders list
  pixverse-api growth-studio folders ensure <name>
  pixverse-api growth-studio upload image /absolute/path/product.webp
  pixverse-api growth-studio video create-from-url <url> [folder options]
  pixverse-api growth-studio video create-from-json <payload.json> [folder options]
  pixverse-api growth-studio video status <video_id>
  pixverse-api growth-studio video poll <video_id>
  pixverse-api growth-studio video list [--limit 20] [--status succeeded] [--cursor <cursor>]
  pixverse-api growth-studio video edit <video_id> <clip_index> <instruction>
  pixverse-api growth-studio run-job --payload <payload.json> [job options]
  pixverse-api growth-studio resume <job-directory> [polling options]

PDP video:
  pixverse-api growth-studio pdp create --payload <pdp.json> --dry-run
  pixverse-api growth-studio pdp create --payload <pdp.json> --confirm-billable [job options]
  pixverse-api growth-studio pdp get <video_id>
  pixverse-api growth-studio pdp poll <video_id> [polling options]
  pixverse-api growth-studio pdp resume <job-directory> [polling options]
  PDP create is billable and requires --confirm-billable for live submission.

Wallet (read-only):
  pixverse-api growth-studio wallet balance
  pixverse-api growth-studio wallet ledgers [--offset 0] [--limit 20]`;
}

function createClient(context) {
  const options = { ...getGrowthStudioConfig(context.env) };
  if (context.fetchImpl) options.fetchImpl = context.fetchImpl;
  if (context.sleep) options.sleep = context.sleep;
  return new GrowthStudioClient(options);
}

function createDeferredResumeClient(getClient) {
  return Object.freeze({
    pollVideo(...args) {
      return getClient().pollVideo(...args);
    },
  });
}

function getContextClientValue(context) {
  const descriptor = Object.getOwnPropertyDescriptor(context, "client");
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

async function createFromUrl(client, options) {
  const prepared = await prepareCreatePayload(
    client,
    createProductUrlPayload(options.sourceUrl),
    options,
    traceId("create-video"),
  );
  const result = (await client.createVideo(prepared.payload, { traceId: prepared.traceId })).body;
  return withFolderResult(result, prepared.folder);
}

async function createFromJson(client, options) {
  const prepared = await prepareCreatePayload(
    client,
    await readJsonFile(options.payloadPath),
    options,
    traceId("create-video"),
  );
  const result = (await client.createVideo(prepared.payload, { traceId: prepared.traceId })).body;
  return withFolderResult(result, prepared.folder);
}

async function runJob(client, options) {
  return runGrowthStudioJob(client, await readJsonFile(options.payloadPath), {
    folderId: options.folderId,
    folderName: options.folderName,
    autoFolder: options.autoFolder,
    jobsDir: options.jobsDir,
    jobName: options.jobName,
    poll: options.poll,
    timeoutMs: options.timeoutMinutes === undefined ? undefined : options.timeoutMinutes * 60 * 1000,
    initialDelaySeconds: options.initialDelaySeconds,
    fallbackDelaySeconds: options.fallbackDelaySeconds,
    traceId: traceId("job"),
  });
}

async function prepareCreatePayload(client, payload, options, createTraceId) {
  const folder = await resolveFolderForPayload(client, payload, {
    autoFolder: options.autoFolder,
    folderId: options.folderId,
    folderName: options.folderName,
    traceId: createTraceId,
  });
  return {
    folder,
    payload: withFolderId(payload, folder?.folderId),
    traceId: createTraceId,
  };
}

function withFolderResult(result, folder) {
  if (!folder) return result;
  return {
    ...result,
    folder_id: folder.folderId,
    folder_name: folder.folderName,
    folder_created: folder.folderCreated,
  };
}

function parseCreateOptions(args, positionalKey, command) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--folder-id") options.folderId = readOptionValue(args, ++index, arg);
    else if (arg === "--folder-name") options.folderName = readOptionValue(args, ++index, arg);
    else if (arg === "--auto-folder") options.autoFolder = true;
    else if (!options[positionalKey]) options[positionalKey] = arg;
    else throw new Error(`Unknown ${command} option: ${arg}`);
  }
  return options;
}

function parseEnsureFolderOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--folder-name") options.folderName = readOptionValue(args, ++index, arg);
    else if (!options.folderName) options.folderName = arg;
    else throw new Error(`Unknown folders ensure option: ${arg}`);
  }
  return options;
}

function parseListOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      options.limit = readSafeIntegerOption(args, ++index, arg, { minimum: 1, maximum: 100 });
    }
    else if (arg === "--status") options.status = readOptionValue(args, ++index, arg);
    else if (arg === "--cursor") options.cursor = readOptionValue(args, ++index, arg);
    else throw new Error(`Unknown video list option: ${arg}`);
  }
  return options;
}

function parsePdpCreateOptions(args) {
  let options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--payload") {
      options = addUniqueOption(options, "payloadPath", readOptionValue(args, ++index, arg), arg);
    } else if (arg === "--dry-run") {
      options = addUniqueOption(options, "dryRun", true, arg);
    } else if (arg === "--confirm-billable") {
      options = addUniqueOption(options, "confirmBillable", true, arg);
    } else if (arg === "--jobs-dir") {
      options = addUniqueOption(options, "jobsDir", readOptionValue(args, ++index, arg), arg);
    } else if (arg === "--job-name") {
      options = addUniqueOption(options, "jobName", readOptionValue(args, ++index, arg), arg);
    } else if (arg === "--timeout-minutes") {
      options = addUniqueOption(options, "timeoutMinutes", readPdpFiniteOption(
        args,
        ++index,
        arg,
        { minimum: 0, exclusive: true, scale: 60_000 },
      ), arg);
    } else if (arg === "--initial-delay-seconds") {
      options = addUniqueOption(options, "initialDelaySeconds", readPdpFiniteOption(
        args,
        ++index,
        arg,
        { minimum: 0, scale: 1_000 },
      ), arg);
    } else if (arg === "--fallback-delay-seconds") {
      options = addUniqueOption(options, "fallbackDelaySeconds", readPdpFiniteOption(
        args,
        ++index,
        arg,
        { minimum: 0, scale: 1_000 },
      ), arg);
    } else if (arg === "--no-poll") {
      options = addUniqueOption(options, "noPoll", true, arg);
    } else {
      throw new Error(`Unknown pdp create option: ${arg}`);
    }
  }
  return options;
}

function parsePdpPollOptions(args) {
  return parsePdpTargetAndTimingOptions(args, "poll", "videoId", "video_id");
}

function parsePdpResumeOptions(args) {
  return parsePdpTargetAndTimingOptions(args, "resume", "jobDirectory", "job directory");
}

function parsePdpTargetAndTimingOptions(args, command, targetKey, targetLabel) {
  let options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--timeout-minutes") {
      options = addUniqueOption(options, "timeoutMinutes", readPdpFiniteOption(
        args,
        ++index,
        arg,
        { minimum: 0, exclusive: true, scale: 60_000 },
      ), arg);
    } else if (arg === "--initial-delay-seconds") {
      options = addUniqueOption(options, "initialDelaySeconds", readPdpFiniteOption(
        args,
        ++index,
        arg,
        { minimum: 0, scale: 1_000 },
      ), arg);
    } else if (arg === "--fallback-delay-seconds") {
      options = addUniqueOption(options, "fallbackDelaySeconds", readPdpFiniteOption(
        args,
        ++index,
        arg,
        { minimum: 0, scale: 1_000 },
      ), arg);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown pdp ${command} option: ${arg}`);
    } else if (!Object.hasOwn(options, targetKey)) {
      options = { ...options, [targetKey]: arg };
    } else {
      throw new Error(`pdp ${command} requires exactly one ${targetLabel}.`);
    }
  }
  if (!options[targetKey]) throw new Error(`pdp ${command} requires exactly one ${targetLabel}.`);
  return options;
}

function parseWalletLedgerOptions(args) {
  let options = { offset: 0, limit: 20 };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--offset" && arg !== "--limit") {
      throw new Error(`Unknown wallet ledgers option: ${arg}`);
    }
    if (seen.has(arg)) throw new Error(`Duplicate wallet ledgers option: ${arg}`);
    seen.add(arg);
    const constraints = arg === "--offset"
      ? { minimum: 0 }
      : { minimum: 1, maximum: 100 };
    options = {
      ...options,
      [arg === "--offset" ? "offset" : "limit"]: readSafeIntegerOption(
        args,
        ++index,
        arg,
        constraints,
      ),
    };
  }
  return options;
}

function hasPdpExecutionOptions(options) {
  return [
    "jobsDir",
    "jobName",
    "timeoutMinutes",
    "initialDelaySeconds",
    "fallbackDelaySeconds",
    "noPoll",
  ].some((key) => Object.hasOwn(options, key));
}

function toPdpJobOptions(options, context) {
  return {
    jobsDir: resolveContextPath(context, options.jobsDir ?? "jobs"),
    ...(options.jobName === undefined ? {} : { jobName: options.jobName }),
    poll: options.noPoll !== true,
    ...toPdpPollingOptions(options),
    traceId: traceId("pdp-job"),
  };
}

function toPdpPollingOptions(options, tracePrefix) {
  return {
    ...(tracePrefix === undefined ? {} : { traceId: traceId(tracePrefix) }),
    ...(options.timeoutMinutes === undefined
      ? {}
      : { timeoutMs: options.timeoutMinutes * 60 * 1000 }),
    ...(options.initialDelaySeconds === undefined
      ? {}
      : { initialDelaySeconds: options.initialDelaySeconds }),
    ...(options.fallbackDelaySeconds === undefined
      ? {}
      : { fallbackDelaySeconds: options.fallbackDelaySeconds }),
  };
}

function parseRunJobOptions(args) {
  const options = { poll: true };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--payload") options.payloadPath = readOptionValue(args, ++index, arg);
    else if (arg === "--folder-id") options.folderId = readOptionValue(args, ++index, arg);
    else if (arg === "--folder-name") options.folderName = readOptionValue(args, ++index, arg);
    else if (arg === "--auto-folder") options.autoFolder = true;
    else if (arg === "--jobs-dir") options.jobsDir = readOptionValue(args, ++index, arg);
    else if (arg === "--job-name") options.jobName = readOptionValue(args, ++index, arg);
    else if (arg === "--timeout-minutes") options.timeoutMinutes = readFiniteOption(args, ++index, arg, { minimum: 0, exclusive: true });
    else if (arg === "--initial-delay-seconds") options.initialDelaySeconds = readFiniteOption(args, ++index, arg, { minimum: 0 });
    else if (arg === "--fallback-delay-seconds") options.fallbackDelaySeconds = readFiniteOption(args, ++index, arg, { minimum: 0 });
    else if (arg === "--no-poll") options.poll = false;
    else throw new Error(`Unknown run-job option: ${arg}`);
  }
  return options;
}

function parseResumeOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--timeout-minutes") options.timeoutMs = readFiniteOption(args, ++index, arg, { minimum: 0, exclusive: true }) * 60 * 1000;
    else if (arg === "--initial-delay-seconds") options.initialDelaySeconds = readFiniteOption(args, ++index, arg, { minimum: 0 });
    else if (arg === "--fallback-delay-seconds") options.fallbackDelaySeconds = readFiniteOption(args, ++index, arg, { minimum: 0 });
    else if (arg.startsWith("--")) throw new Error(`Unknown resume option: ${arg}`);
    else if (!options.jobDirectory) options.jobDirectory = arg;
    else throw new Error("resume accepts exactly one job directory.");
  }
  if (!options.jobDirectory) throw new Error("resume requires a job directory.");
  return options;
}

function readOptionValue(args, index, optionName) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value.`);
  return value;
}

function addUniqueOption(options, key, value, optionName) {
  if (Object.hasOwn(options, key)) throw new Error(`Duplicate pdp option: ${optionName}`);
  return { ...options, [key]: value };
}

function readPdpFiniteOption(args, index, optionName, constraints = {}) {
  const rawValue = readOptionValue(args, index, optionName);
  const strictDecimal = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
  const value = Number(rawValue);
  const scaledValue = value * (constraints.scale ?? 1);
  const belowMinimum = constraints.exclusive
    ? value <= constraints.minimum
    : value < constraints.minimum;
  if (
    !strictDecimal.test(rawValue)
    || !Number.isFinite(value)
    || !Number.isFinite(scaledValue)
    || Math.abs(scaledValue) > Number.MAX_SAFE_INTEGER
    || belowMinimum
  ) {
    const comparison = constraints.exclusive ? "greater than" : "at least";
    throw new Error(
      `${optionName} must be a finite safe number ${comparison} ${constraints.minimum}.`,
    );
  }
  return value;
}

function readSafeIntegerOption(args, index, optionName, constraints = {}) {
  const rawValue = readOptionValue(args, index, optionName);
  const value = Number(rawValue);
  const outsideRange = value < constraints.minimum
    || (constraints.maximum !== undefined && value > constraints.maximum);
  if (!/^(?:0|[1-9]\d*)$/.test(rawValue) || !Number.isSafeInteger(value) || outsideRange) {
    const range = constraints.maximum === undefined
      ? `at least ${constraints.minimum}`
      : `from ${constraints.minimum} through ${constraints.maximum}`;
    throw new Error(`${optionName} must be a safe integer ${range}.`);
  }
  return value;
}

function readFiniteOption(args, index, optionName, constraints = {}) {
  const rawValue = readOptionValue(args, index, optionName);
  const value = Number(rawValue);
  const belowMinimum = constraints.exclusive
    ? value <= constraints.minimum
    : value < constraints.minimum;
  if (!Number.isFinite(value) || belowMinimum) {
    const comparison = constraints.exclusive ? "greater than" : "at least";
    throw new Error(`${optionName} must be a finite number ${comparison} ${constraints.minimum}.`);
  }
  return value;
}

function withFolderId(payload, folderId) {
  if (!folderId || payload?.video?.folder_id === folderId) return payload;
  return { ...payload, video: { ...payload.video, folder_id: folderId } };
}

function resolveContextPath(context, value) {
  return path.resolve(context.cwd ?? process.cwd(), value);
}

function traceId(prefix) {
  return `${prefix}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}
