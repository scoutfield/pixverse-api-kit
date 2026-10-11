export async function resolveFolderForPayload(client, payload, options = {}) {
  const explicitFolderId = options.folderId || payload?.video?.folder_id;
  if (explicitFolderId) {
    assertFolderId(explicitFolderId);
    return {
      folderId: explicitFolderId,
      folderName: options.folderName || null,
      folderCreated: false,
      source: "explicit-folder-id",
    };
  }

  if (!options.folderName && !options.autoFolder) return null;

  // An explicit --folder-name is sent exactly as the user typed it (trimmed) and
  // matched exactly; normalization only applies to names inferred by --auto-folder.
  const explicitName = Boolean(options.folderName);
  const folderName = explicitName
    ? String(options.folderName).trim()
    : normalizeFolderName(inferFolderName(payload));
  if (!folderName) {
    if (explicitName) throw new Error("Folder name cannot be empty.");
    return null;
  }

  const listResult = await client.listFolders({ traceId: options.traceId && `${options.traceId}-folder-list` });
  const folders = Array.isArray(listResult.body?.folders) ? listResult.body.folders : [];
  const existing = folders.find((folder) => (explicitName
    ? typeof folder?.name === "string" && folder.name.trim() === folderName
    : folderNamesMatch(folder?.name, folderName)));
  if (existing) {
    const folderId = readFolderId(existing);
    return {
      folderId,
      folderName: existing.name || folderName,
      folderCreated: false,
      source: "existing-folder",
    };
  }

  const createResult = await client.createFolder(
    { name: folderName },
    { traceId: options.traceId && `${options.traceId}-folder-create` },
  );
  const folderId = readFolderId(createResult.body);
  return {
    folderId,
    folderName,
    folderCreated: true,
    source: "created-folder",
  };
}

export function inferFolderName(payload) {
  const metadata = asRecord(payload?.metadata);
  const product = asRecord(payload?.product);

  return firstNonEmpty([
    metadata.folder_name,
    metadata.folderName,
    metadata.customer,
    metadata.customer_name,
    merchantNameFromUrl(product.source_url || metadata.product_url || metadata.source_url),
    product.brand,
    metadata.brand,
    metadata.topic,
    metadata.campaign,
  ]);
}

export function normalizeFolderName(value) {
  const cleaned = String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";

  const words = cleaned.split(" ");
  if (words.length === 1 && words[0].length <= 12) return words[0].toUpperCase();

  return words.map((word) => (word.length <= 5 ? word.toUpperCase() : titleCase(word))).join(" ");
}

function merchantNameFromUrl(value) {
  if (!value) return "";
  try {
    const host = new URL(value).hostname.replace(/^www\./i, "");
    const [name] = host.split(".");
    return name || "";
  } catch {
    return "";
  }
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function folderNamesMatch(left, right) {
  return comparableFolderName(left) === comparableFolderName(right);
}

function comparableFolderName(value) {
  return normalizeFolderName(value).toLowerCase();
}

function firstNonEmpty(values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readFolderId(folder) {
  const folderId = folder?.folder_id;
  assertFolderId(folderId);
  return folderId;
}

function assertFolderId(folderId) {
  if (typeof folderId !== "string" || !/^\d+$/.test(folderId)) {
    throw new Error("folder_id must be a numeric string.");
  }
}
