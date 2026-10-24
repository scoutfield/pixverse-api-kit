import { PixverseCliError } from "../../core/errors.js";
import { isIP } from "node:net";

const ID_KEY = /(?:^|_)(?:id|ids)$/i;
const URL_KEY = /(?:^|_)urls?$/i;

export function validationError(operation, message, details) {
  return new PixverseCliError(message, {
    category: "validation",
    provider: "platform",
    operation: operation?.id,
    code: "INVALID_PLATFORM_INPUT",
    retryable: false,
    details,
  });
}

export function cloneInput(operation, input) {
  if (!isPlainObject(input)) {
    throw validationError(operation, "Platform input must be an object.");
  }
  return cloneValue(input);
}

export function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

export function normalizeIdentifierFields(operation, value, key = "") {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeIdentifierFields(operation, item, key.replace(/s$/i, "")));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
      childKey,
      normalizeIdentifierFields(operation, item, childKey),
    ]));
  }
  if (!ID_KEY.test(key)) return value;
  return normalizeIdentifier(operation, key, value);
}

export function normalizeIdentifier(operation, field, value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw validationError(operation, `${field} must be supplied as a string because the numeric value is not a safe integer.`);
    }
    if (value < 0) throw validationError(operation, `${field} must be a non-negative identifier.`);
    return String(value);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw validationError(operation, `${field} is required and must be a non-empty string identifier.`);
  }
  return value;
}

export function requireField(operation, object, names, label = names[0]) {
  const found = names.find((name) => isPresent(object[name]));
  if (!found) throw validationError(operation, `${label} is required.`);
  return found;
}

export function requireExactlyOne(operation, object, names, label = names.join(" or ")) {
  const present = names.filter((name) => isPresent(object[name]));
  if (present.length !== 1) {
    throw validationError(operation, `Provide exactly one ${label}.`);
  }
  return present[0];
}

export function validateKnownUrls(operation, value) {
  visitEntries(value, (key, item) => {
    if (!URL_KEY.test(key) || !isPresent(item)) return;
    if (Array.isArray(item)) {
      for (const url of item) validateSafeRemoteUrl(operation, key, url);
      return;
    }
    validateSafeRemoteUrl(operation, key, item);
  });
}

export function validateSafeRemoteUrl(operation, field, value) {
  if (typeof value !== "string") throw validationError(operation, `${field} must be an HTTP or HTTPS URL.`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw validationError(operation, `${field} must be a valid HTTP or HTTPS URL.`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw validationError(operation, `${field} must be an HTTP or HTTPS URL.`);
  }
  if (parsed.username || parsed.password) throw validationError(operation, `${field} URL must not contain credentials.`);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateHostname(hostname)) throw validationError(operation, `${field} URL must not target a local or private host.`);
}

export function validatePrompt(operation, payload, options = {}) {
  if (!("prompt" in payload)) return;
  const maxLength = options.maxLength ?? 2048;
  if (typeof payload.prompt !== "string" || payload.prompt.trim() === "" || payload.prompt.length > maxLength) {
    throw validationError(operation, `prompt must be a non-empty string no longer than ${maxLength} characters.`);
  }
}

const V6_MAX_OPERATIONS = new Set(["video.text", "video.image"]);

export function validateModelScalars(operation, payload, options = {}) {
  validatePrompt(operation, payload, { maxLength: options.promptMaxLength ?? 5000 });
  if (payload.model !== undefined && (typeof payload.model !== "string" || payload.model.trim() === "")) {
    throw validationError(operation, "model must be a non-empty string.");
  }
  const qualities = options.qualities ?? ["360p", "540p", "720p", "1080p"];
  if (payload.quality !== undefined && !qualities.includes(String(payload.quality).toLowerCase())) {
    throw validationError(operation, "quality must be a supported resolution value.");
  }
  // V6 Max currently serves text-to-video and image-to-video only (pricing and capability map).
  if (payload.model === "v6-max" && !V6_MAX_OPERATIONS.has(operation.id)) {
    throw validationError(operation, "model v6-max supports only text-to-video and image-to-video.");
  }
  const documentedDurationMaximum = ["v6-max", "v6", "c1"].includes(payload.model) ? 15 : undefined;
  if (payload.duration !== undefined && (!Number.isInteger(payload.duration)
    || payload.duration < 1
    || (documentedDurationMaximum !== undefined && payload.duration > documentedDurationMaximum))) {
    const range = documentedDurationMaximum === undefined ? "a positive integer" : "an integer between 1 and 15 seconds";
    throw validationError(operation, `duration must be ${range}.`);
  }
  const aspectRatios = options.aspectRatios ?? ["16:9", "4:3", "1:1", "3:4", "9:16", "2:3", "3:2", "21:9"];
  if (payload.aspect_ratio !== undefined && !aspectRatios.includes(String(payload.aspect_ratio))) {
    throw validationError(operation, `aspect_ratio must be one of ${aspectRatios.join(", ")}.`);
  }
  if (payload.seed !== undefined && (!Number.isSafeInteger(payload.seed) || payload.seed < 0 || payload.seed > 2_147_483_647)) {
    throw validationError(operation, "seed must be a safe integer between 0 and 2147483647.");
  }
}

export function requireExactlyOneField(operation, object, names, label = names.join(" or ")) {
  return requireExactlyOne(operation, object, names, label);
}

export function requireFields(operation, object, names) {
  for (const name of names) requireField(operation, object, [name]);
}

export function isPresent(value) {
  return value !== undefined && value !== null && value !== "";
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function visitEntries(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) visitEntries(item, visitor);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    visitor(key, item);
    visitEntries(item, visitor);
  }
}

function isPrivateHostname(hostname) {
  if (["localhost", "localhost.localdomain", "0.0.0.0", "::", "::1"].includes(hostname)) return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) return true;
  const version = isIP(hostname);
  if (version === 4) return isPrivateIpv4(hostname.split(".").map(Number));
  if (version !== 6) return false;
  const mapped = mappedIpv4Octets(hostname);
  if (mapped) return isPrivateIpv4(mapped);
  const firstHextet = Number.parseInt(hostname.split(":", 1)[0] || "0", 16);
  return (firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80;
}

function mappedIpv4Octets(hostname) {
  const match = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);
  if (!match) return undefined;
  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255];
}

function isPrivateIpv4(octets) {
  return octets[0] === 10
    || octets[0] === 127
    || octets[0] === 0
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}
