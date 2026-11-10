import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildCustomerPlugin } from "../../scripts/package-customer-plugin.js";
import { verifyManifest } from "../../scripts/customer-plugin/archive.js";
import { verifyCustomerPlugin } from "../../scripts/customer-plugin/verify.js";

const execFileAsync = promisify(execFile);

function cleanEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PIXVERSE_")),
  );
}

test("packaging command builds and re-verifies the extracted Codex plugin", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-customer-package-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputRoot = path.join(root, "output");
  const result = await buildCustomerPlugin({
    repoRoot: process.cwd(),
    outputRoot,
    installDependencies: true,
  });

  for (const artifactPath of [result.archivePath, result.checksumPath, result.reportPath]) {
    assert.equal((await fs.stat(artifactPath)).isFile(), true);
  }

  const extractRoot = path.join(root, "extract");
  await fs.mkdir(extractRoot);
  await execFileAsync("unzip", ["-q", result.archivePath, "-d", extractRoot]);
  const packageRoot = path.join(extractRoot, "pixverse-api-plugin-0.3.0-beta.4");
  const pluginRoot = path.join(packageRoot, "plugins/pixverse-api");
  const wrapper = path.join(pluginRoot, "scripts/pixverse-api");
  const packageEntrypoint = path.join(packageRoot, "dist/index.js");
  const processOptions = {
    cwd: pluginRoot,
    env: cleanEnvironment(),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  };

  assert.equal((await verifyManifest(packageRoot)).status, "passed");
  assert.equal((await verifyCustomerPlugin({ packageRoot })).status, "passed");

  const version = await execFileAsync(wrapper, ["--version"], processOptions);
  assert.equal(version.stdout, "0.3.0-beta.4\n");
  const entrypointVersion = await execFileAsync(packageEntrypoint, ["--version"], {
    ...processOptions,
    cwd: packageRoot,
  });
  assert.equal(entrypointVersion.stdout, "0.3.0-beta.4\n");
  const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(packageJson.bin, { "pixverse-api": "./dist/index.js" });

  const dryRun = await execFileAsync(wrapper, [
    "growth-studio",
    "pdp",
    "create",
    "--payload",
    path.join(pluginRoot, "examples/pdp-standard-high.json"),
    "--dry-run",
  ], processOptions);
  const dryRunResult = JSON.parse(dryRun.stdout);
  assert.equal(dryRunResult.billable, false);
  assert.equal(dryRunResult.path, "/openapi/v1/ecommerce_pdp/video");
  assert.equal("type" in dryRunResult.body, false);

  await assert.rejects(fs.access(path.join(pluginRoot, "runtime/node_modules/c8")), { code: "ENOENT" });
  assert.equal((await fs.stat(path.join(packageRoot, "install.command"))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, "auth.command"))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, "uninstall.command"))).isFile(), true);
});
