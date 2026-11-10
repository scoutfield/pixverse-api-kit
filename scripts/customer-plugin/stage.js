import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  CUSTOMER_PLUGIN_ALLOWLIST,
  CUSTOMER_PLUGIN_RELEASE,
  STANDALONE_SKILL_OWNER_MARKER,
  STANDALONE_SKILL_PREFIX,
} from "./config.js";

const execFileAsync = promisify(execFile);

export async function stageCustomerPlugin({
  repoRoot,
  stageRoot,
  installDependencies = true,
}) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedStageRoot = path.resolve(stageRoot);
  const packageRoot = path.join(resolvedStageRoot, CUSTOMER_PLUGIN_RELEASE.archiveBaseName);
  const pluginRoot = path.join(packageRoot, "plugins", CUSTOMER_PLUGIN_RELEASE.pluginName);
  const runtimeRoot = path.join(pluginRoot, "runtime");

  await fs.mkdir(pluginRoot, { recursive: true });
  await copyApprovedPluginSource(resolvedRepoRoot, packageRoot, pluginRoot);
  await copySkillReferences(resolvedRepoRoot, pluginRoot);
  await writeStandaloneSkills(packageRoot, pluginRoot);
  await copyRuntimeSources(resolvedRepoRoot, runtimeRoot);
  await sanitizeRuntimeSources(runtimeRoot);
  await writeRuntimeMetadata(resolvedRepoRoot, runtimeRoot);
  await writePackageEntrypoint(packageRoot);
  await writeWrapper(pluginRoot);

  if (installDependencies) {
    await installProductionDependencies(runtimeRoot);
  }

  return Object.freeze({
    packageRoot,
    pluginRoot,
    files: Object.freeze(await collectRelativeFiles(packageRoot)),
  });
}

async function copyApprovedPluginSource(repoRoot, packageRoot, pluginRoot) {
  const sourceRoot = path.join(repoRoot, CUSTOMER_PLUGIN_ALLOWLIST.pluginSource);
  await copyTree(path.join(sourceRoot, "plugin"), pluginRoot);
  for (const fileName of CUSTOMER_PLUGIN_ALLOWLIST.packageRootFiles) {
    await copyFile(path.join(sourceRoot, fileName), path.join(packageRoot, fileName));
  }

  for (const relativePath of CUSTOMER_PLUGIN_ALLOWLIST.apiDocuments) {
    const destination = path.join(pluginRoot, relativePath.replace(/^docs\//, "docs/"));
    await copyFile(path.join(repoRoot, relativePath), destination);
  }
}

async function copySkillReferences(repoRoot, pluginRoot) {
  for (const [skillName, references] of Object.entries(CUSTOMER_PLUGIN_ALLOWLIST.skillReferences)) {
    for (const relativePath of references) {
      await copyFile(
        path.join(repoRoot, relativePath),
        path.join(pluginRoot, "skills", skillName, "references", path.basename(relativePath)),
      );
    }
  }
}

async function writeStandaloneSkills(packageRoot, pluginRoot) {
  for (const skillName of Object.keys(CUSTOMER_PLUGIN_ALLOWLIST.skillReferences)) {
    const standaloneName = `${STANDALONE_SKILL_PREFIX}${skillName}`;
    const destination = path.join(packageRoot, "agent-skills", standaloneName);
    await copyTree(path.join(pluginRoot, "skills", skillName), destination);
    const skillPath = path.join(destination, "SKILL.md");
    const skillText = await fs.readFile(skillPath, "utf8");
    const renamed = skillText.replace(new RegExp(`^---\\nname: ${skillName}\\n`), `---\nname: ${standaloneName}\n`);
    if (renamed === skillText) throw new Error(`Skill frontmatter is invalid: ${skillName}`);
    await fs.writeFile(skillPath, renamed);
    await fs.writeFile(
      path.join(destination, STANDALONE_SKILL_OWNER_MARKER),
      `Installed by PixVerse API Plugin ${CUSTOMER_PLUGIN_RELEASE.version}. Removed by its uninstaller.\n`,
    );
  }
}

async function copyRuntimeSources(repoRoot, runtimeRoot) {
  for (const relativePath of CUSTOMER_PLUGIN_ALLOWLIST.runtimeFiles) {
    await copyFile(
      path.join(repoRoot, relativePath),
      path.join(runtimeRoot, relativePath),
    );
  }
}

async function sanitizeRuntimeSources(runtimeRoot) {
  const operationsPath = path.join(runtimeRoot, "src", "platform", "operations.js");
  const source = await fs.readFile(operationsPath, "utf8");
  const sanitized = source.replaceAll(
    "https://aisphere.feishu.cn/wiki/L8pgwGoSwiDbQ8ksGIHcppcvnrc",
    "https://docs.platform.pixverse.ai/",
  );
  await fs.writeFile(operationsPath, sanitized);
}

async function writeRuntimeMetadata(repoRoot, runtimeRoot) {
  const repositoryPackage = JSON.parse(
    await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  const repositoryLock = JSON.parse(
    await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf8"),
  );
  const runtimePackage = {
    name: "pixverse-api-plugin-runtime",
    version: CUSTOMER_PLUGIN_RELEASE.version,
    private: true,
    type: "module",
    bin: { "pixverse-api": "./src/cli.js" },
    engines: { node: ">=20" },
    dependencies: { ...repositoryPackage.dependencies },
  };
  const productionPackages = Object.fromEntries(
    Object.entries(repositoryLock.packages)
      .filter(([packagePath, metadata]) => packagePath === "" || metadata.dev !== true)
      .map(([packagePath, metadata]) => packagePath === ""
        ? [packagePath, {
            name: runtimePackage.name,
            version: runtimePackage.version,
            dependencies: { ...runtimePackage.dependencies },
            bin: { ...runtimePackage.bin },
            engines: { ...runtimePackage.engines },
          }]
        : [packagePath, { ...metadata }]),
  );
  const runtimeLock = {
    name: runtimePackage.name,
    version: runtimePackage.version,
    lockfileVersion: repositoryLock.lockfileVersion,
    requires: true,
    packages: productionPackages,
  };

  await fs.writeFile(
    path.join(runtimeRoot, "package.json"),
    `${JSON.stringify(runtimePackage, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(runtimeRoot, "package-lock.json"),
    `${JSON.stringify(runtimeLock, null, 2)}\n`,
  );
}

async function writePackageEntrypoint(packageRoot) {
  const packageJson = {
    name: "pixverse-api",
    version: CUSTOMER_PLUGIN_RELEASE.version,
    private: true,
    type: "module",
    description: "PixVerse API CLI and coding-agent plugin for Platform API and Growth Studio API workflows.",
    bin: { "pixverse-api": "./dist/index.js" },
    files: [
      ".agents",
      ".claude-plugin",
      "agent-skills",
      "INSTALL-MACOS.md",
      "MANIFEST.sha256",
      "auth.command",
      "dist",
      "install.command",
      "plugins",
      "uninstall.command",
    ],
    engines: { node: ">=20" },
  };
  const entrypoint = `#!/bin/sh
set -eu

SCRIPT_PATH="$0"
LINK_DEPTH=0
while [ -L "$SCRIPT_PATH" ]; do
  LINK_DEPTH=$((LINK_DEPTH + 1))
  if [ "$LINK_DEPTH" -gt 40 ]; then
    echo "PixVerse API CLI shortcut has too many symbolic links." >&2
    exit 1
  fi
  SCRIPT_DIR=$(CDPATH= cd -P -- "$(dirname -- "$SCRIPT_PATH")" && pwd)
  LINK_TARGET=$(readlink "$SCRIPT_PATH")
  case "$LINK_TARGET" in
    /*) SCRIPT_PATH="$LINK_TARGET" ;;
    *) SCRIPT_PATH="$SCRIPT_DIR/$LINK_TARGET" ;;
  esac
done
SCRIPT_DIR=$(CDPATH= cd -P -- "$(dirname -- "$SCRIPT_PATH")" && pwd)
WRAPPER="$SCRIPT_DIR/../plugins/pixverse-api/scripts/pixverse-api"

exec "$WRAPPER" "$@"
`;

  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  await fs.writeFile(path.join(packageRoot, "dist", "index.js"), entrypoint, { mode: 0o755 });
  await fs.chmod(path.join(packageRoot, "dist", "agents.js"), 0o755);
  await fs.chmod(path.join(packageRoot, "dist", "index.js"), 0o755);
}

async function writeWrapper(pluginRoot) {
  const scriptsRoot = path.join(pluginRoot, "scripts");
  const wrapperPath = path.join(scriptsRoot, "pixverse-api");
  const wrapper = `#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLI_ENTRY="$SCRIPT_DIR/../runtime/src/cli.js"

NODE_BIN=""
if [ -n "\${CODEX_MCP_NODE_PATH:-}" ] && [ -x "$CODEX_MCP_NODE_PATH" ]; then
  NODE_DIR=$(CDPATH= cd -- "$(dirname -- "$CODEX_MCP_NODE_PATH")" && pwd)
  PATH="$NODE_DIR\${PATH:+:$PATH}"
  export PATH
  NODE_BIN="$CODEX_MCP_NODE_PATH"
elif [ -n "\${HOME:-}" ] && [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
  NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  NODE_DIR=$(CDPATH= cd -- "$(dirname -- "$NODE_BIN")" && pwd)
  PATH="$NODE_DIR\${PATH:+:$PATH}"
  export PATH
else
  NODE_BIN=$(command -v node || true)
fi

if [ -z "$NODE_BIN" ]; then
  echo "PixVerse API Plugin requires Node.js 20 or newer." >&2
  exit 1
fi

NODE_MAJOR=$($NODE_BIN -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "PixVerse API Plugin requires Node.js 20 or newer." >&2
  exit 1
fi

exec "$NODE_BIN" "$CLI_ENTRY" "$@"
`;
  await fs.mkdir(scriptsRoot, { recursive: true });
  await fs.writeFile(wrapperPath, wrapper, { mode: 0o755 });
  await fs.chmod(wrapperPath, 0o755);
}

async function installProductionDependencies(runtimeRoot) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PIXVERSE_")),
  );
  try {
    await execFileAsync(
      "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: runtimeRoot, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    const details = `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim();
    throw new Error(`Unable to install embedded production dependencies.${details ? `\n${details}` : ""}`);
  }
}

async function copyTree(source, destination) {
  const stats = await fs.lstat(source);
  if (stats.isSymbolicLink()) throw new Error(`Symlink source is not allowed: ${source}`);
  if (!stats.isDirectory()) throw new Error(`Expected source directory: ${source}`);
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(sourcePath, destinationPath);
    else if (entry.isFile()) await copyFile(sourcePath, destinationPath);
    else throw new Error(`Unsupported source entry: ${sourcePath}`);
  }
}

async function copyFile(source, destination) {
  const stats = await fs.lstat(source);
  if (stats.isSymbolicLink()) throw new Error(`Symlink source is not allowed: ${source}`);
  if (!stats.isFile()) throw new Error(`Expected source file: ${source}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function collectRelativeFiles(root) {
  const files = await walk(root, root);
  return files.toSorted();
}

async function walk(root, current) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map(async (entry) => {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) return walk(root, fullPath);
    if (entry.isFile()) return [path.relative(root, fullPath).split(path.sep).join("/")];
    return [];
  }));
  return nestedFiles.flat();
}
