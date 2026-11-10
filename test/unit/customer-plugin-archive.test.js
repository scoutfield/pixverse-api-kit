import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { archiveCustomerPlugin, verifyManifest } from "../../scripts/customer-plugin/archive.js";
import { stageCustomerPlugin } from "../../scripts/customer-plugin/stage.js";

const execFileAsync = promisify(execFile);

async function buildArchive(root, name) {
  const stageRoot = path.join(root, `${name}-stage`);
  const outputDir = path.join(root, `${name}-output`);
  await fs.mkdir(stageRoot, { recursive: true });
  const staged = await stageCustomerPlugin({
    repoRoot: process.cwd(),
    stageRoot,
    installDependencies: true,
  });
  return archiveCustomerPlugin({ packageRoot: staged.packageRoot, outputDir });
}

test("customer plugin archive is deterministic and has verifiable sidecars", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-customer-archive-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const first = await buildArchive(root, "first");
  const second = await buildArchive(root, "second");
  assert.equal(first.archiveSha256, second.archiveSha256);

  const report = JSON.parse(await fs.readFile(first.reportPath, "utf8"));
  assert.equal(report.archive.sha256, first.archiveSha256);
  assert.equal(report.release.version, "0.3.0-beta.4");
  assert.equal(report.checks.every(({ status }) => status === "passed"), true);

  const checksum = await fs.readFile(first.checksumPath, "utf8");
  assert.equal(checksum, `${first.archiveSha256}  ${path.basename(first.archivePath)}\n`);

  const extractRoot = path.join(root, "extracted");
  await fs.mkdir(extractRoot);
  await execFileAsync("unzip", ["-q", first.archivePath, "-d", extractRoot]);
  const extractedPackage = path.join(extractRoot, "pixverse-api-plugin-0.3.0-beta.4");
  const manifest = await verifyManifest(extractedPackage);
  assert.equal(manifest.status, "passed");
  assert.equal(manifest.files.length > 0, true);
});
