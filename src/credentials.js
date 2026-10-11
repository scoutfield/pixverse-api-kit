import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const USER_CREDENTIAL_KEYS = Object.freeze([
  "PIXVERSE_PLATFORM_API_KEY",
  "PIXVERSE_PLATFORM_BASE_URL",
  "PIXVERSE_PLATFORM_ALLOW_CUSTOM_BASE_URL",
  "PIXVERSE_GROWTH_API_KEY",
  "PIXVERSE_GROWTH_BASE_URL",
  "PIXVERSE_GROWTH_ALLOW_CUSTOM_BASE_URL",
]);

const USER_CREDENTIAL_KEY_SET = new Set(USER_CREDENTIAL_KEYS);
const PROVIDER_KEYS = Object.freeze({
  platform: "PIXVERSE_PLATFORM_API_KEY",
  "growth-studio": "PIXVERSE_GROWTH_API_KEY",
});

export function getUserCredentialsPath(env = process.env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".pixverse-api-kit", "credentials.env");
}

export function getLegacyUserCredentialsPaths(env = process.env) {
  const home = env.HOME || os.homedir();
  return [
    path.join(home, "Library", "Application Support", "PixVerse", "api-plugin", "credentials.env"),
    path.join(home, "Library", "Application Support", "PixVerse", "API Plugin", "credentials.env"),
  ];
}

export function loadUserCredentials(env = process.env, filePath = getUserCredentialsPath(env)) {
  for (const [key, value] of Object.entries(readCredentialFile(filePath))) {
    if (!USER_CREDENTIAL_KEY_SET.has(key) || env[key]) continue;
    env[key] = value;
  }
}

export function readCredentialFile(filePath = getUserCredentialsPath()) {
  const resolvedPath = resolveCredentialFilePath(filePath);
  let stats;
  try {
    stats = fs.statSync(resolvedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  if (!stats.isFile()) return {};

  const values = {};
  for (const line of fs.readFileSync(resolvedPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!USER_CREDENTIAL_KEY_SET.has(key)) continue;
    values[key] = unquoteValue(trimmed.slice(separator + 1).trim());
  }
  return values;
}

export function writeCredentialFile(values, filePath = getUserCredentialsPath()) {
  const filtered = Object.fromEntries(
    Object.entries(values).filter(([key, value]) => USER_CREDENTIAL_KEY_SET.has(key)
      && typeof value === "string"
      && value !== ""),
  );
  const rows = [
    "# PixVerse API Plugin credentials",
    "# Created by pixverse-api auth. Keep this file private.",
    ...USER_CREDENTIAL_KEYS
      .filter((key) => filtered[key])
      .map((key) => `${key}=${quoteValue(filtered[key])}`),
  ];
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${rows.join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function setProviderCredential(provider, apiKey, filePath = getUserCredentialsPath()) {
  const keyName = providerKey(provider);
  const trimmed = String(apiKey ?? "").trim();
  if (!trimmed) throw new Error(`${provider} API key cannot be empty.`);
  if (provider === "growth-studio" && !trimmed.startsWith("mh_live_")) {
    throw new Error("Growth Studio API key must be a production key starting with mh_live_.");
  }
  const values = readCredentialFile(filePath);
  values[keyName] = trimmed;
  writeCredentialFile(values, filePath);
  return { provider, keyName, filePath };
}

export function clearProviderCredential(provider, filePath = getUserCredentialsPath()) {
  const values = readCredentialFile(filePath);
  if (provider === "all") {
    for (const key of Object.values(PROVIDER_KEYS)) delete values[key];
  } else {
    delete values[providerKey(provider)];
  }
  writeCredentialFile(values, filePath);
  return { provider, filePath };
}

export function getCredentialStatus(env = process.env, filePath = getUserCredentialsPath(env)) {
  const saved = readCredentialFile(filePath);
  return Object.freeze({
    filePath,
    platform: providerStatus("platform", env, saved),
    growthStudio: providerStatus("growth-studio", env, saved),
  });
}

function resolveCredentialFilePath(filePath) {
  if (fs.existsSync(filePath)) return filePath;
  const parent = path.dirname(filePath);
  if (path.basename(filePath) !== "credentials.env" || path.basename(parent) !== ".pixverse-api-kit") {
    return filePath;
  }
  const home = path.dirname(parent);
  return getLegacyUserCredentialsPaths({ HOME: home }).find((legacyPath) => fs.existsSync(legacyPath)) ?? filePath;
}

function providerStatus(provider, env, saved) {
  const keyName = providerKey(provider);
  const source = env[keyName] ? "environment" : saved[keyName] ? "user-file" : "missing";
  return Object.freeze({
    configured: source !== "missing",
    source,
    variable: keyName,
  });
}

function providerKey(provider) {
  const keyName = PROVIDER_KEYS[provider];
  if (!keyName) throw new Error(`Unknown credential provider: ${provider}`);
  return keyName;
}

function quoteValue(value) {
  return JSON.stringify(value);
}

function unquoteValue(value) {
  return value.replace(/^['"]|['"]$/g, "");
}
