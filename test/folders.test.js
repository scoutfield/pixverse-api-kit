import assert from "node:assert/strict";
import test from "node:test";
import { inferFolderName, normalizeFolderName, resolveFolderForPayload } from "../src/folders.js";

test("inferFolderName prefers customer folder grouping from metadata", () => {
  assert.equal(inferFolderName({
    metadata: { customer: "REVOLVE", brand: "LIONESS" },
    product: {
      brand: "LIONESS",
      source_url: "https://www.revolve.com/lioness-stars-align-mini-dress/dp/LIOR-WD140/",
    },
  }), "REVOLVE");
});

test("inferFolderName falls back to merchant domain before product brand", () => {
  assert.equal(inferFolderName({
    product: {
      brand: "LIONESS",
      source_url: "https://www.revolve.com/lioness-stars-align-mini-dress/dp/LIOR-WD140/",
    },
  }), "revolve");
});

test("normalizeFolderName produces stable brand-style names", () => {
  assert.equal(normalizeFolderName("revolve"), "REVOLVE");
  assert.equal(normalizeFolderName("summer_drop"), "Summer DROP");
});

test("resolveFolderForPayload reuses an existing folder by normalized name", async () => {
  const calls = [];
  const client = {
    async listFolders() {
      calls.push("list");
      return { body: { folders: [{ folder_id: "636771263750078906", name: "REVOLVE" }] } };
    },
    async createFolder() {
      throw new Error("createFolder should not be called");
    },
  };

  const folder = await resolveFolderForPayload(client, {
    product: { source_url: "https://www.revolve.com/item" },
  }, {
    autoFolder: true,
  });

  assert.deepEqual(folder, {
    folderId: "636771263750078906",
    folderName: "REVOLVE",
    folderCreated: false,
    source: "existing-folder",
  });
  assert.deepEqual(calls, ["list"]);
});

test("resolveFolderForPayload creates a missing folder", async () => {
  const calls = [];
  const client = {
    async listFolders() {
      calls.push("list");
      return { body: { folders: [] } };
    },
    async createFolder(payload) {
      calls.push(["create", payload]);
      return { body: { folder_id: "636771263750078906" } };
    },
  };

  const folder = await resolveFolderForPayload(client, {
    metadata: { customer: "REVOLVE" },
    product: { source_url: "https://www.revolve.com/item" },
  }, {
    autoFolder: true,
  });

  assert.deepEqual(folder, {
    folderId: "636771263750078906",
    folderName: "REVOLVE",
    folderCreated: true,
    source: "created-folder",
  });
  assert.deepEqual(calls, ["list", ["create", { name: "REVOLVE" }]]);
});

test("resolveFolderForPayload keeps an explicit video.folder_id without listing or creating", async () => {
  const client = {
    async listFolders() {
      throw new Error("listFolders should not be called");
    },
    async createFolder() {
      throw new Error("createFolder should not be called");
    },
  };
  const folder = await resolveFolderForPayload(client, {
    product: { source_url: "https://www.revolve.com/item" },
    video: { folder_id: "630251570268735431" },
  }, { folderName: "Another Folder", autoFolder: true });

  assert.equal(folder.folderId, "630251570268735431");
  assert.equal(folder.source, "explicit-folder-id");
  assert.equal(folder.folderCreated, false);
});

test("resolveFolderForPayload ignores a legacy top-level folder_id", async () => {
  const folder = await resolveFolderForPayload({}, {
    folder_id: "630251570268735431",
    product: { source_url: "https://www.revolve.com/item" },
  }, {});

  assert.equal(folder, null);
});

test("resolveFolderForPayload sends an explicit folder name trimmed but otherwise unchanged", async () => {
  const calls = [];
  const client = {
    async listFolders() {
      calls.push("list");
      return { body: { folders: [{ folder_id: "1", name: "SUMMER DROP" }, { folder_id: "2", name: "summer_drop" }] } };
    },
    async createFolder(payload) {
      calls.push(["create", payload]);
      return { body: { folder_id: "636771263750078906" } };
    },
  };

  const folder = await resolveFolderForPayload(client, {}, { folderName: "  summer drop  " });

  assert.deepEqual(calls, ["list", ["create", { name: "summer drop" }]]);
  assert.deepEqual(folder, {
    folderId: "636771263750078906",
    folderName: "summer drop",
    folderCreated: true,
    source: "created-folder",
  });
});

test("resolveFolderForPayload reuses an exact explicit folder name match", async () => {
  const client = {
    async listFolders() {
      return { body: { folders: [{ folder_id: "1", name: "Summer DROP" }, { folder_id: "2", name: "summer_drop" }] } };
    },
    async createFolder() {
      throw new Error("createFolder should not be called");
    },
  };

  const folder = await resolveFolderForPayload(client, {}, { folderName: "summer_drop" });

  assert.equal(folder.folderId, "2");
  assert.equal(folder.folderName, "summer_drop");
  assert.equal(folder.source, "existing-folder");
});

test("resolveFolderForPayload rejects a blank explicit folder name", async () => {
  await assert.rejects(resolveFolderForPayload({}, {}, { folderName: "   " }), /Folder name cannot be empty/);
});
