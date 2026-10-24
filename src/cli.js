#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getTopLevelHelp, isHelpRequest } from "./cli/options.js";
import { formatError, formatSuccess } from "./cli/output.js";
import { routeCommand } from "./cli/router.js";
import {
  clearProviderCredential,
  getCredentialStatus,
  getUserCredentialsPath,
  loadUserCredentials,
  setProviderCredential,
} from "./credentials.js";

const LEGACY_WARNING = 'Warning: legacy command syntax is deprecated; use the "pixverse-api growth-studio" namespace.\n';
export const CLI_VERSION = "0.3.0-beta.3";

export async function main(argv = [], context = {}) {
  const stdout = context.stdout ?? process.stdout;
  const stderr = context.stderr ?? process.stderr;

  if (isHelpRequest(argv)) {
    stdout.write(`${getTopLevelHelp()}\n`);
    return 0;
  }

  if (argv.length === 1 && ["--version", "-v"].includes(argv[0])) {
    stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  if (argv[0] === "auth") {
    try {
      stdout.write(formatSuccess(await runAuthCommand(argv.slice(1), createProviderContext(context))));
      return 0;
    } catch (error) {
      stderr.write(formatError(error));
      return 1;
    }
  }

  const route = routeCommand(argv);
  const providerContext = createProviderContext(context);

  try {
    if (route.provider === "growth-studio") {
      if (isHelpRequest(route.providerArgs)) {
        const { getGrowthStudioHelp } = await import("./growth-studio/cli.js");
        stdout.write(`${getGrowthStudioHelp()}\n`);
        return 0;
      }
      if (route.legacy) {
        stderr.write(LEGACY_WARNING);
      }
      const runGrowthStudio = context.runGrowthStudioCommand ?? runDefaultGrowthStudioCommand;
      stdout.write(formatSuccess(await runGrowthStudio(route.providerArgs, providerContext)));
      return 0;
    }

    if (route.provider === "platform") {
      if (isHelpRequest(route.providerArgs)) {
        const { getPlatformHelp } = await import("./platform/cli.js");
        stdout.write(`${getPlatformHelp()}\n`);
        return 0;
      }
      const runPlatform = context.runPlatformCommand ?? runDefaultPlatformCommand;
      const result = await runPlatform(route.providerArgs, providerContext);
      stdout.write(formatSuccess(result));
      const { formatPlatformCost } = await import("./platform/pricing.js");
      const costLine = formatPlatformCost(result?.cost ?? result?.cost_estimate);
      if (costLine) stderr.write(`${costLine}\n`);
      return 0;
    }

    throw new Error(`Unknown provider or command: ${route.command || argv.join(" ")}`);
  } catch (error) {
    stderr.write(formatError(error));
    return 1;
  }
}

function createProviderContext(context) {
  return {
    env: context.env ?? process.env,
    fetchImpl: context.fetchImpl ?? globalThis.fetch,
    stdout: context.stdout ?? process.stdout,
    stderr: context.stderr ?? process.stderr,
    stdin: context.stdin ?? process.stdin,
    cwd: context.cwd ?? process.cwd(),
    sleep: context.sleep,
    now: context.now,
    inspectLocalMedia: context.inspectLocalMedia,
    signal: context.signal,
  };
}

async function runDefaultPlatformCommand(args, context) {
  if (context.env === process.env) {
    loadUserCredentials(process.env);
    loadPlatformDotEnv(path.join(context.cwd, ".env"));
  }
  const { runPlatformCommand } = await import("./platform/cli.js");
  return runPlatformCommand(args, context);
}

function loadPlatformDotEnv(filePath) {
  loadEnvFile(filePath, new Set([
    "PIXVERSE_PLATFORM_API_KEY",
    "PIXVERSE_PLATFORM_BASE_URL",
    "PIXVERSE_PLATFORM_ALLOW_CUSTOM_BASE_URL",
  ]));
}

async function runDefaultGrowthStudioCommand(args, context) {
  if (context.env === process.env) {
    loadUserCredentials(process.env);
    const { loadDotEnv } = await import("./growth-studio/config.js");
    loadDotEnv(path.join(context.cwd, ".env"));
  }
  const { runGrowthStudioCommand } = await import("./growth-studio/cli.js");
  return runGrowthStudioCommand(args, context);
}

function loadEnvFile(filePath, allowed) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stats.isFile()) return;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!allowed.has(key) || process.env[key]) continue;
    const rawValue = trimmed.slice(separator + 1).trim();
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

async function runAuthCommand(args, context) {
  const [command, provider, ...rest] = args;
  if (!command || isHelpRequest(args)) return { usage: getAuthHelp() };
  if (command === "path") return { path: getUserCredentialsPath(context.env) };
  if (command === "status") return getCredentialStatus(context.env, getUserCredentialsPath(context.env));
  if (command === "logout") {
    if (!provider) throw new Error("auth logout requires platform, growth-studio, or all.");
    return {
      action: "logout",
      ...clearProviderCredential(provider, getUserCredentialsPath(context.env)),
    };
  }
  if (command === "login" || command === "set") {
    if (!["platform", "growth-studio"].includes(provider)) {
      throw new Error("auth login requires platform or growth-studio.");
    }
    const apiKey = await resolveApiKeyInput(rest, context);
    return {
      action: "login",
      ...setProviderCredential(provider, apiKey, getUserCredentialsPath(context.env)),
    };
  }
  throw new Error(`Unknown auth command: ${command}`);
}

async function resolveApiKeyInput(args, context) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--stdin")) {
    const value = await readAllStdin(context.stdin ?? process.stdin);
    if (!value.trim()) {
      throw new Error("Pass the API key on stdin, for example: printf '%s' \"$KEY\" | pixverse-api auth login platform --stdin");
    }
    return value;
  }
  if (args.length === 2 && args[0] === "--key") {
    return args[1];
  }
  throw new Error("Use pixverse-api auth login <platform|growth-studio> --stdin.");
}

async function readAllStdin(stdin) {
  if (typeof stdin === "string") return stdin;
  let text = "";
  stdin.setEncoding?.("utf8");
  for await (const chunk of stdin) text += chunk;
  return text;
}

function getAuthHelp() {
  return [
    "Usage:",
    "  pixverse-api auth login platform --stdin",
    "  pixverse-api auth login growth-studio --stdin",
    "  pixverse-api auth status",
    "  pixverse-api auth logout platform|growth-studio|all",
    "  pixverse-api auth path",
  ].join("\n");
}

function isExecutedDirectly() {
  if (!process.argv[1]) return false;
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));
}

function canonicalPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

if (isExecutedDirectly()) {
  main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
