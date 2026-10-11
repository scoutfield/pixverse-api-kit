import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SAFE_CHILD_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "pixverse-cli-process-"));

export function runCli(args = [], options = {}) {
  return runNode([path.join(REPOSITORY_ROOT, "src/cli.js"), ...args], options);
}

export function importCli(options = {}) {
  return runNode([
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(path.join(REPOSITORY_ROOT, "src/cli.js"))})`,
  ], options);
}

function runNode(args, options) {
  const cwd = options.cwd ?? SAFE_CHILD_CWD;
  const childEnv = { ...withoutPixverseSecrets(process.env), ...options.env };
  assertLoopbackProviderUrls(options.env ?? {});
  assertDotEnvProviderUrlIsLoopback(args, cwd, options.env ?? {});
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

function withoutPixverseSecrets(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !/^PIXVERSE_.*(?:API_KEY|TOKEN|SECRET)$/i.test(name)),
  );
}

function assertLoopbackProviderUrls(overrides) {
  for (const [name, value] of Object.entries(overrides)) {
    if (/^PIXVERSE_.*_BASE_URL$/i.test(name) && value && !isLoopbackUrl(value)) {
      throw new Error(`${name} must use a loopback URL in child CLI tests.`);
    }
  }

  const providers = [
    ["PIXVERSE_PLATFORM_API_KEY", "PIXVERSE_PLATFORM_BASE_URL"],
    ["PIXVERSE_GROWTH_API_KEY", "PIXVERSE_GROWTH_BASE_URL"],
  ];
  for (const [credentialName, baseUrlName] of providers) {
    if (overrides[credentialName] && !isLoopbackUrl(overrides[baseUrlName])) {
      throw new Error(`${credentialName} requires an explicit loopback ${baseUrlName} in child CLI tests.`);
    }
  }
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function assertDotEnvProviderUrlIsLoopback(args, cwd, overrides) {
  const provider = providerForChildArgs(args);
  if (!provider) return;
  const dotEnv = readDotEnv(path.join(cwd, ".env"));
  const credentialNames = provider === "platform"
    ? ["PIXVERSE_PLATFORM_API_KEY"]
    : ["PIXVERSE_GROWTH_API_KEY"];
  const baseUrlName = provider === "platform"
    ? "PIXVERSE_PLATFORM_BASE_URL"
    : "PIXVERSE_GROWTH_BASE_URL";
  const hasDotEnvCredential = credentialNames.some((name) => dotEnv[name] && !overrides[name]);
  if (!hasDotEnvCredential) return;

  const baseUrl = overrides[baseUrlName] || dotEnv[baseUrlName];
  if (!isLoopbackUrl(baseUrl)) {
    throw new Error(`${provider} credentials in cwd/.env require a loopback ${baseUrlName} in child CLI tests.`);
  }
}

function providerForChildArgs(args) {
  if (args[0] !== path.join(REPOSITORY_ROOT, "src/cli.js")) return null;
  const command = args[1];
  if (command === "platform") return "platform";
  if (command === "growth-studio") return "growth-studio";
  return new Set([
    "avatars", "folders", "ensure-folder", "upload-image", "create-from-url",
    "create-from-json", "get", "poll", "list", "edit", "run-job",
  ]).has(command) ? "growth-studio" : null;
}

function readDotEnv(filePath) {
  try {
    if (!fs.statSync(filePath).isFile()) return {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }

  const values = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const name = trimmed.slice(0, separator).trim();
    if (!/^PIXVERSE_/.test(name)) continue;
    values[name] = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return values;
}
