import fs from "node:fs";

export const DEFAULT_BASE_URL = "https://growth-api.pixverse.ai";
const OFFICIAL_GROWTH_ORIGIN = new URL(DEFAULT_BASE_URL).origin;
const DOTENV_KEYS = new Set([
  "PIXVERSE_GROWTH_API_KEY",
  "PIXVERSE_GROWTH_BASE_URL",
  "PIXVERSE_GROWTH_ALLOW_CUSTOM_BASE_URL",
]);

export function loadDotEnv(path = ".env") {
  if (!fs.existsSync(path)) return;

  const body = fs.readFileSync(path, "utf8");
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    if (!DOTENV_KEYS.has(key)) continue;
    const rawValue = trimmed.slice(index + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

export function getGrowthStudioConfig(env = process.env) {
  const apiKey = env.PIXVERSE_GROWTH_API_KEY;
  const baseUrl = normalizeBaseUrl(
    env.PIXVERSE_GROWTH_BASE_URL || DEFAULT_BASE_URL,
    env.PIXVERSE_GROWTH_ALLOW_CUSTOM_BASE_URL,
  );

  if (!apiKey) {
    throw new Error("Missing PIXVERSE_GROWTH_API_KEY. Add it to .env or the server environment.");
  }

  if (!apiKey.startsWith("mh_live_")) {
    throw new Error("PIXVERSE_GROWTH_API_KEY must be a production key starting with mh_live_.");
  }

  return { apiKey, baseUrl };
}

export const getConfig = getGrowthStudioConfig;

function normalizeBaseUrl(value, allowCustomBaseUrl) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("PIXVERSE_GROWTH_BASE_URL must be a valid HTTP or HTTPS URL.");
  }

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new TypeError("PIXVERSE_GROWTH_BASE_URL must be a valid HTTP or HTTPS URL.");
  }

  const isOfficial = url.origin === OFFICIAL_GROWTH_ORIGIN;
  const isLoopback = isLoopbackHostname(url.hostname);
  if (!isLoopback && url.protocol !== "https:") {
    throw new TypeError(
      "PIXVERSE_GROWTH_BASE_URL must use the official HTTPS origin or an HTTPS custom base URL.",
    );
  }
  if (!isOfficial && !isLoopback && !isExplicitlyEnabled(allowCustomBaseUrl)) {
    throw new TypeError(
      "Custom PIXVERSE_GROWTH_BASE_URL origins require PIXVERSE_GROWTH_ALLOW_CUSTOM_BASE_URL=true.",
    );
  }

  return url.toString().replace(/\/$/, "");
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isExplicitlyEnabled(value) {
  return value === true || value === "true";
}
