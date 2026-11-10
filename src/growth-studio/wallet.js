const WALLET_OPTION_FIELDS = new Set(["offset", "limit", "traceId"]);

function assertKnownOptionFields(options) {
  if (
    options === null
    || typeof options !== "object"
    || Array.isArray(options)
    || (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) {
    throw new TypeError("Wallet ledger options must be a plain object.");
  }

  for (const field of Object.keys(options)) {
    if (!WALLET_OPTION_FIELDS.has(field)) {
      throw new Error(`Unknown wallet ledger option: ${field}.`);
    }
  }
}

function readInteger(value, label, { minimum, maximum } = {}) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer.`);
  }
  if (minimum !== undefined && value < minimum) {
    throw new RangeError(`${label} must be at least ${minimum}.`);
  }
  if (maximum !== undefined && value > maximum) {
    throw new RangeError(`${label} must be at most ${maximum}.`);
  }
  return value;
}

export function normalizeWalletLedgerOptions(options = {}) {
  assertKnownOptionFields(options);
  return {
    offset: readInteger(options.offset ?? 0, "offset", { minimum: 0 }),
    limit: readInteger(options.limit ?? 20, "limit", { minimum: 0, maximum: 100 }) || 20,
  };
}
