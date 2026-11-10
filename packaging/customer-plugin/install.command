#!/bin/zsh
set -euo pipefail

PLUGIN_NAME="pixverse-api"
MARKETPLACE_NAME="pixverse-private-beta"
CLI_PACKAGE_NAME="pixverse-api"
VERSION="0.3.0-beta.4"
SCRIPT_PATH="${0:A}"
SOURCE_ROOT="${SCRIPT_PATH:h}"
SUPPORT_ROOT="$HOME/Library/Application Support/PixVerse/api-plugin"
LEGACY_SUPPORT_ROOT="$HOME/Library/Application Support/PixVerse/API Plugin"
CREDENTIALS_ROOT="$HOME/.pixverse-api-kit"
CREDENTIALS_PATH="$CREDENTIALS_ROOT/credentials.env"
LEGACY_CREDENTIALS_PATH="$SUPPORT_ROOT/credentials.env"
OLDER_LEGACY_CREDENTIALS_PATH="$LEGACY_SUPPORT_ROOT/credentials.env"
RECEIPT_PATH="$SUPPORT_ROOT/install-receipt.json"
LEGACY_RECEIPT_PATH="$LEGACY_SUPPORT_ROOT/install-receipt.json"
TEMP_ROOT=""
NPM_PREFIX=""
INSTALL_PARENT=""
INSTALL_ROOT=""
BIN_ROOT=""
BIN_PATH=""
BIN_TARGET="../lib/node_modules/$CLI_PACKAGE_NAME/dist/index.js"
BACKUP_ROOT=""
BACKUP_BIN_PATH=""
INSTALLED_NEW=0
BIN_INSTALLED=0
MARKETPLACE_ADDED=0
PLUGIN_ADDED=0
SUCCEEDED=0
PRIOR_INSTALL_ROOT=""
PRIOR_VERSION=""
PRIOR_BIN_PATH=""
PRIOR_BIN_TARGET=""
PRIOR_RECEIPT_PATH=""
CODEX_BIN=""
SELECTED_AGENTS=()
OTHER_AGENTS=()
AGENT_RESULT_PATH=""

set_install_paths() {
  INSTALL_PARENT="$NPM_PREFIX/lib/node_modules"
  INSTALL_ROOT="$INSTALL_PARENT/$CLI_PACKAGE_NAME"
  BIN_ROOT="$NPM_PREFIX/bin"
  BIN_PATH="$BIN_ROOT/$CLI_PACKAGE_NAME"
  BACKUP_ROOT="$INSTALL_PARENT/.pixverse-api-backup-$VERSION-$$"
  BACKUP_BIN_PATH="$BIN_ROOT/.pixverse-api-bin-backup-$VERSION-$$"
}

safe_remove_directory() {
  local target="$1"
  SUPPORT_ROOT_VALUE="$SUPPORT_ROOT" LEGACY_SUPPORT_ROOT_VALUE="$LEGACY_SUPPORT_ROOT" INSTALL_PARENT_VALUE="$INSTALL_PARENT" PRIOR_INSTALL_ROOT_VALUE="$PRIOR_INSTALL_ROOT" TARGET_VALUE="$target" "$NODE_BIN" -e '
const fs = require("node:fs");
const path = require("node:path");
const roots = [
  path.resolve(process.env.SUPPORT_ROOT_VALUE),
  path.resolve(process.env.LEGACY_SUPPORT_ROOT_VALUE),
  path.resolve(process.env.INSTALL_PARENT_VALUE),
];
const priorInstallRoot = path.resolve(process.env.PRIOR_INSTALL_ROOT_VALUE || "");
const target = path.resolve(process.env.TARGET_VALUE);
if (!(roots.some((root) => root && target.startsWith(root + path.sep)) || (priorInstallRoot && target === priorInstallRoot))) process.exit(2);
fs.rmSync(target, { recursive: true, force: true });
' || {
    echo "Refusing to remove a path outside PixVerse API Plugin support storage." >&2
    return 1
  }
}

remove_registration_or_accept_absent() {
  local output
  if output="$("$@" 2>&1)"; then
    return 0
  fi
  if [[ "$output" == *"not configured or installed"* || "$output" == *"not installed"* ]]; then
    return 0
  fi
  return 1
}

restore_previous_install() {
  local restore_root=""
  if [[ -d "$BACKUP_ROOT" ]]; then
    /bin/mv -- "$BACKUP_ROOT" "$INSTALL_ROOT"
    restore_root="$INSTALL_ROOT"
  elif [[ -n "$PRIOR_INSTALL_ROOT" && -d "$PRIOR_INSTALL_ROOT" ]]; then
    restore_root="$PRIOR_INSTALL_ROOT"
  else
    return 0
  fi
  if [[ -n "$BIN_PATH" && -n "$PRIOR_BIN_TARGET" && ! -e "$BIN_PATH" ]]; then
    /bin/mkdir -p -- "${BIN_PATH:h}"
    /bin/ln -s -- "$PRIOR_BIN_TARGET" "$BIN_PATH"
  fi
  if [[ -z "$CODEX_BIN" ]]; then
    return 0
  fi
  if ! "$CODEX_BIN" plugin marketplace add "$restore_root" --json >/dev/null; then
    echo "The previous plugin files were restored, but Codex could not restore their marketplace registration." >&2
    return 1
  fi
  if ! "$CODEX_BIN" plugin add "$PLUGIN_NAME@$MARKETPLACE_NAME" --json >/dev/null; then
    echo "The previous plugin files were restored, but Codex could not restore the plugin registration." >&2
    return 1
  fi
}

cleanup() {
  local exit_status=$?
  if [[ "$SUCCEEDED" -ne 1 ]]; then
    if [[ "$PLUGIN_ADDED" -eq 1 ]]; then
      "$CODEX_BIN" plugin remove "$PLUGIN_NAME@$MARKETPLACE_NAME" --json >/dev/null 2>&1 || true
    fi
    if [[ "$MARKETPLACE_ADDED" -eq 1 ]]; then
      "$CODEX_BIN" plugin marketplace remove "$MARKETPLACE_NAME" --json >/dev/null 2>&1 || true
    fi
    if [[ "$INSTALLED_NEW" -eq 1 && -d "$INSTALL_ROOT" ]]; then
      safe_remove_directory "$INSTALL_ROOT" || true
    fi
    if [[ "$BIN_INSTALLED" -eq 1 && -L "$BIN_PATH" ]]; then
      /bin/rm -f -- "$BIN_PATH" || true
    fi
    if [[ -d "$BACKUP_ROOT" ]]; then
      /bin/mv -- "$BACKUP_ROOT" "$INSTALL_ROOT"
    fi
    if [[ -n "$BACKUP_BIN_PATH" && -L "$BACKUP_BIN_PATH" ]]; then
      /bin/mv -f -- "$BACKUP_BIN_PATH" "$BIN_PATH" || true
    elif [[ -n "$PRIOR_BIN_TARGET" && -n "$BIN_PATH" ]]; then
      /bin/ln -s -- "$PRIOR_BIN_TARGET" "$BIN_PATH" || true
    fi
  elif [[ -d "$BACKUP_ROOT" ]]; then
    safe_remove_directory "$BACKUP_ROOT"
  elif [[ -n "$BACKUP_BIN_PATH" && -L "$BACKUP_BIN_PATH" ]]; then
    /bin/rm -f -- "$BACKUP_BIN_PATH" || true
  fi
  if [[ -n "$TEMP_ROOT" && -d "$TEMP_ROOT" ]]; then
    safe_remove_directory "$TEMP_ROOT" || true
  fi
  if [[ -n "$AGENT_RESULT_PATH" ]]; then
    /bin/rm -f -- "$AGENT_RESULT_PATH" || true
  fi
  return "$exit_status"
}
trap cleanup EXIT

if [[ "$(/usr/bin/uname -s)" != "Darwin" ]]; then
  echo "PixVerse API Plugin private demo installation currently supports macOS only." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Install Node.js 20 or newer, then run this installer again." >&2
  exit 1
fi
NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "PixVerse API Plugin requires Node.js 20 or newer." >&2
  exit 1
fi

NPM_BIN="$(command -v npm || true)"
if [[ -z "$NPM_BIN" ]]; then
  echo "Install npm with Node.js, then run this installer again." >&2
  exit 1
fi
NPM_PREFIX="$("$NPM_BIN" prefix -g)"
if [[ -z "$NPM_PREFIX" || "$NPM_PREFIX" == "/" ]]; then
  echo "Unable to resolve a safe global npm prefix." >&2
  exit 1
fi
PIXVERSE_BIN=""
if [[ "${PIXVERSE_API_SKIP_PIXVERSE_PREFIX:-0}" != "1" ]]; then
  PIXVERSE_BIN="$(command -v pixverse || true)"
fi
if [[ -n "$PIXVERSE_BIN" ]]; then
  PIXVERSE_PREFIX="$(
    PIXVERSE_BIN_VALUE="$PIXVERSE_BIN" "$NODE_BIN" -e '
const fs = require("node:fs");
const path = require("node:path");
const bin = path.resolve(process.env.PIXVERSE_BIN_VALUE);
try {
  const stats = fs.lstatSync(bin);
  if (!stats.isSymbolicLink()) process.exit(0);
  const target = fs.readlinkSync(bin);
  if (!target.includes("lib/node_modules/pixverse/")) process.exit(0);
  const binDirectory = path.dirname(bin);
  if (path.basename(binDirectory) !== "bin") process.exit(0);
  process.stdout.write(path.dirname(binDirectory));
} catch {
  process.exit(0);
}
'
  )"
  if [[ -n "$PIXVERSE_PREFIX" ]]; then
    NPM_PREFIX="$PIXVERSE_PREFIX"
  fi
fi
set_install_paths

if [[ -f "$RECEIPT_PATH" || -f "$LEGACY_RECEIPT_PATH" ]]; then
  RECEIPT_TO_READ="$RECEIPT_PATH"
  RECEIPT_SUPPORT_ROOT="$SUPPORT_ROOT"
  if [[ ! -f "$RECEIPT_TO_READ" && -f "$LEGACY_RECEIPT_PATH" ]]; then
    RECEIPT_TO_READ="$LEGACY_RECEIPT_PATH"
    RECEIPT_SUPPORT_ROOT="$LEGACY_SUPPORT_ROOT"
  fi
  PRIOR_RECEIPT="$({
    SUPPORT_ROOT_VALUE="$RECEIPT_SUPPORT_ROOT" INSTALL_ROOT_VALUE="$INSTALL_ROOT" BIN_PATH_VALUE="$BIN_PATH" "$NODE_BIN" -e '
const fs = require("node:fs");
const path = require("node:path");
const receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const key of ["install_root", "marketplace", "plugin", "version"]) {
  if (typeof receipt[key] !== "string" || !receipt[key] || /[\r\n]/.test(receipt[key])) process.exit(1);
}
if (receipt.marketplace !== "pixverse-private-beta" || receipt.plugin !== "pixverse-api") process.exit(1);
if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(receipt.version)) process.exit(1);
const installRoot = path.resolve(receipt.install_root);
const acceptedRoots = [
  path.resolve(process.env.INSTALL_ROOT_VALUE),
  path.join(path.resolve(process.env.SUPPORT_ROOT_VALUE), receipt.version),
];
if (!acceptedRoots.includes(installRoot) && !installRoot.endsWith("/lib/node_modules/pixverse-api")) process.exit(1);
const stats = fs.lstatSync(installRoot);
if (!stats.isDirectory() || stats.isSymbolicLink()) process.exit(1);
const binPath = typeof receipt.bin_path === "string" && receipt.bin_path && !/[\r\n]/.test(receipt.bin_path)
  ? receipt.bin_path
  : process.env.BIN_PATH_VALUE;
const binTarget = typeof receipt.bin_target === "string" && receipt.bin_target && !/[\r\n]/.test(receipt.bin_target)
  ? receipt.bin_target
  : "";
process.stdout.write(`${installRoot}\n${receipt.version}\n${binPath}\n${binTarget}`);
' "$RECEIPT_TO_READ"
  } 2>/dev/null)" || {
    echo "The existing PixVerse API Plugin installation receipt is invalid. No changes were made." >&2
    exit 1
  }
  PRIOR_RECEIPT_PATH="$RECEIPT_TO_READ"
  PRIOR_RECEIPT_LINES=("${(@f)PRIOR_RECEIPT}")
  if [[ "${#PRIOR_RECEIPT_LINES[@]}" -lt 3 || "${#PRIOR_RECEIPT_LINES[@]}" -gt 4 ]]; then
    echo "The existing PixVerse API Plugin installation receipt is invalid. No changes were made." >&2
    exit 1
  fi
  PRIOR_INSTALL_ROOT="${PRIOR_RECEIPT_LINES[1]}"
  PRIOR_VERSION="${PRIOR_RECEIPT_LINES[2]}"
  PRIOR_BIN_PATH="${PRIOR_RECEIPT_LINES[3]}"
  PRIOR_BIN_TARGET="${PRIOR_RECEIPT_LINES[4]:-}"
  if [[ "$PRIOR_INSTALL_ROOT" == */lib/node_modules/pixverse-api ]]; then
    NPM_PREFIX="${PRIOR_INSTALL_ROOT%/lib/node_modules/pixverse-api}"
    set_install_paths
  fi
fi

for required_file in .agents/plugins/marketplace.json .claude-plugin/marketplace.json MANIFEST.sha256 dist/agents.js plugins/pixverse-api/.codex-plugin/plugin.json plugins/pixverse-api/.claude-plugin/plugin.json; do
  if [[ ! -f "$SOURCE_ROOT/$required_file" ]]; then
    echo "The extracted plugin package is incomplete: $required_file is missing." >&2
    exit 1
  fi
done

SOURCE_ROOT_VALUE="$SOURCE_ROOT" "$NODE_BIN" -e '
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(process.env.SOURCE_ROOT_VALUE);
const manifestPath = path.join(root, "MANIFEST.sha256");
const rows = fs.readFileSync(manifestPath, "utf8").split("\n").filter(Boolean);
const expected = rows.map((row) => {
  const match = /^[a-f0-9]{64}  ([^\n]+)$/.exec(row);
  if (!match) throw new Error("invalid manifest row");
  const relativePath = match[1];
  if (path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
    throw new Error("unsafe manifest path");
  }
  return relativePath;
});
if (new Set(expected).size !== expected.length) throw new Error("duplicate manifest path");
const actual = [];
function walk(current) {
  for (const name of fs.readdirSync(current).sort()) {
    const fullPath = path.join(current, name);
    const stats = fs.lstatSync(fullPath);
    if (stats.isSymbolicLink()) throw new Error("symlink is not allowed");
    if (stats.isDirectory()) walk(fullPath);
    else if (stats.isFile()) {
      const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
      if (relativePath !== "MANIFEST.sha256") actual.push(relativePath);
    } else throw new Error("unsupported package entry");
  }
}
walk(root);
expected.sort();
actual.sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("inventory mismatch");
' 2>/dev/null || {
  echo "The extracted plugin package inventory is invalid." >&2
  exit 1
}

(
  cd "$SOURCE_ROOT"
  /usr/bin/shasum -a 256 -c MANIFEST.sha256 >/dev/null
)

"$NODE_BIN" -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (manifest.name !== "pixverse-api" || manifest.version !== "0.3.0-beta.4") process.exit(1);
' "$SOURCE_ROOT/plugins/pixverse-api/.codex-plugin/plugin.json" || {
  echo "The PixVerse API Plugin manifest is invalid." >&2
  exit 1
}

# PIXVERSE_API_AGENTS=auto (default) registers every supported agent found on this Mac.
# A comma-separated list such as "codex,claude,cursor" limits registration to those agents.
SELECTED_OUTPUT="$("$NODE_BIN" "$SOURCE_ROOT/dist/agents.js" select)" || {
  echo "No changes were made." >&2
  exit 1
}
SELECTED_AGENTS=("${(@f)SELECTED_OUTPUT}")
SELECTED_AGENTS=(${SELECTED_AGENTS:#})
if [[ "${#SELECTED_AGENTS[@]}" -eq 0 ]]; then
  echo "No supported coding agent was found. Install Codex, Claude Code, Gemini CLI, Cursor, GitHub Copilot CLI, or OpenCode, then run this installer again." >&2
  exit 1
fi
if (( ${SELECTED_AGENTS[(Ie)codex]} )); then
  CODEX_BIN="$(command -v codex)"
fi
OTHER_AGENTS=(${SELECTED_AGENTS:#codex})

/bin/mkdir -p -- "$SUPPORT_ROOT" "$CREDENTIALS_ROOT" "$INSTALL_PARENT" "$BIN_ROOT"
if [[ ! -f "$CREDENTIALS_PATH" && -f "$LEGACY_CREDENTIALS_PATH" ]]; then
  /bin/cp -p -- "$LEGACY_CREDENTIALS_PATH" "$CREDENTIALS_PATH"
  /bin/chmod 600 "$CREDENTIALS_PATH"
elif [[ ! -f "$CREDENTIALS_PATH" && -f "$OLDER_LEGACY_CREDENTIALS_PATH" ]]; then
  /bin/cp -p -- "$OLDER_LEGACY_CREDENTIALS_PATH" "$CREDENTIALS_PATH"
  /bin/chmod 600 "$CREDENTIALS_PATH"
fi
TEMP_ROOT="$(/usr/bin/mktemp -d "$INSTALL_PARENT/.pixverse-api-install-$VERSION-XXXXXX")"
/usr/bin/ditto "$SOURCE_ROOT" "$TEMP_ROOT"

if [[ -d "$INSTALL_ROOT" ]]; then
  /bin/mv -- "$INSTALL_ROOT" "$BACKUP_ROOT"
fi
if [[ -e "$BIN_PATH" || -L "$BIN_PATH" ]]; then
  if [[ ! -L "$BIN_PATH" ]]; then
    echo "Refusing to replace an existing non-symlink command: $BIN_PATH" >&2
    exit 1
  fi
  EXISTING_BIN_TARGET="$(/bin/ls -l "$BIN_PATH" | /usr/bin/sed 's/^.* -> //')"
  case "$EXISTING_BIN_TARGET" in
    *"pixverse-api"*) /bin/mv -- "$BIN_PATH" "$BACKUP_BIN_PATH" ;;
    *) echo "Refusing to replace an unrelated pixverse-api symlink: $BIN_PATH" >&2; exit 1 ;;
  esac
fi
/bin/mv -- "$TEMP_ROOT" "$INSTALL_ROOT"
TEMP_ROOT=""
INSTALLED_NEW=1
/bin/ln -s -- "$BIN_TARGET" "$BIN_PATH"
BIN_INSTALLED=1

if [[ -n "$CODEX_BIN" && -n "$PRIOR_INSTALL_ROOT" && "$PRIOR_INSTALL_ROOT" != "$INSTALL_ROOT" ]]; then
  remove_registration_or_accept_absent \
    "$CODEX_BIN" plugin remove "$PLUGIN_NAME@$MARKETPLACE_NAME" --json || true
  remove_registration_or_accept_absent \
    "$CODEX_BIN" plugin marketplace remove "$MARKETPLACE_NAME" --json || true
fi

if [[ -n "$CODEX_BIN" ]] && ! "$CODEX_BIN" plugin marketplace add "$INSTALL_ROOT" --json >/dev/null; then
  safe_remove_directory "$INSTALL_ROOT"
  INSTALLED_NEW=0
  if [[ -d "$BACKUP_ROOT" ]]; then
    /bin/mv -- "$BACKUP_ROOT" "$INSTALL_ROOT"
  fi
  if ! restore_previous_install; then
    SUCCEEDED=1
    exit 1
  fi
  SUCCEEDED=1
  echo "Codex could not register the PixVerse private marketplace. The installation was rolled back." >&2
  exit 1
fi
if [[ -n "$CODEX_BIN" ]]; then
  MARKETPLACE_ADDED=1
fi
if [[ -n "$CODEX_BIN" ]] && ! "$CODEX_BIN" plugin add "$PLUGIN_NAME@$MARKETPLACE_NAME" --json >/dev/null; then
  "$CODEX_BIN" plugin marketplace remove "$MARKETPLACE_NAME" --json >/dev/null 2>&1 || true
  MARKETPLACE_ADDED=0
  safe_remove_directory "$INSTALL_ROOT"
  INSTALLED_NEW=0
  if ! restore_previous_install; then
    SUCCEEDED=1
    exit 1
  fi
  SUCCEEDED=1
  echo "Codex could not install the PixVerse API Plugin. The installation was rolled back." >&2
  exit 1
fi
REGISTERED_CODEX=0
if [[ -n "$CODEX_BIN" ]]; then
  PLUGIN_ADDED=1
  REGISTERED_CODEX=1
fi

AGENT_RESULT_PATH="$SUPPORT_ROOT/.agent-result-$$.json"
AGENT_INSTALL_ARGS=(install --root "$INSTALL_ROOT" --agents "${(j:,:)OTHER_AGENTS}" --result "$AGENT_RESULT_PATH")
if [[ -n "$PRIOR_RECEIPT_PATH" ]]; then
  AGENT_INSTALL_ARGS+=(--previous-receipt "$PRIOR_RECEIPT_PATH")
fi
if [[ -n "$PRIOR_INSTALL_ROOT" && "$PRIOR_INSTALL_ROOT" != "$INSTALL_ROOT" ]]; then
  AGENT_INSTALL_ARGS+=(--replace)
fi
"$NODE_BIN" "$INSTALL_ROOT/dist/agents.js" "${AGENT_INSTALL_ARGS[@]}"

RECEIPT_TEMP="$SUPPORT_ROOT/.install-receipt-$$.json"
INSTALL_ROOT_VALUE="$INSTALL_ROOT" MARKETPLACE_VALUE="$MARKETPLACE_NAME" VERSION_VALUE="$VERSION" BIN_PATH_VALUE="$BIN_PATH" BIN_TARGET_VALUE="$BIN_TARGET" \
  REGISTERED_CODEX_VALUE="$REGISTERED_CODEX" AGENT_RESULT_VALUE="$AGENT_RESULT_PATH" \
  "$NODE_BIN" -e '
const fs = require("node:fs");
const agentResult = JSON.parse(fs.readFileSync(process.env.AGENT_RESULT_VALUE, "utf8"));
const agents = [
  ...(process.env.REGISTERED_CODEX_VALUE === "1" ? [{ name: "codex" }] : []),
  ...agentResult.agents,
];
if (agents.length === 0) {
  process.stderr.write("PixVerse API Plugin could not be registered with any coding agent.\n");
  process.exit(3);
}
const receipt = {
  install_root: process.env.INSTALL_ROOT_VALUE,
  marketplace: process.env.MARKETPLACE_VALUE,
  plugin: "pixverse-api",
  version: process.env.VERSION_VALUE,
  bin_path: process.env.BIN_PATH_VALUE,
  bin_target: process.env.BIN_TARGET_VALUE,
  agents,
};
fs.writeFileSync(process.argv[1], JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
' "$RECEIPT_TEMP"
/bin/chmod 600 "$RECEIPT_TEMP"
/bin/mv -f -- "$RECEIPT_TEMP" "$RECEIPT_PATH"

SUCCEEDED=1
if [[ -n "$PRIOR_BIN_PATH" && "$PRIOR_BIN_PATH" != "$BIN_PATH" && -L "$PRIOR_BIN_PATH" ]]; then
  CURRENT_PRIOR_BIN_TARGET="$(/bin/ls -l "$PRIOR_BIN_PATH" | /usr/bin/sed 's/^.* -> //')"
  if [[ -z "$PRIOR_BIN_TARGET" || "$CURRENT_PRIOR_BIN_TARGET" == "$PRIOR_BIN_TARGET" || "$CURRENT_PRIOR_BIN_TARGET" == *"pixverse-api"* ]]; then
    /bin/rm -f -- "$PRIOR_BIN_PATH" || \
      echo "The new plugin is installed, but the older pixverse-api shortcut could not be removed." >&2
  fi
fi
if [[ -n "$PRIOR_INSTALL_ROOT" && "$PRIOR_INSTALL_ROOT" != "$INSTALL_ROOT" && -d "$PRIOR_INSTALL_ROOT" ]]; then
  safe_remove_directory "$PRIOR_INSTALL_ROOT" || \
    echo "The new plugin is installed, but the older package directory could not be removed." >&2
fi
AGENT_SUMMARY="$(REGISTERED_CODEX_VALUE="$REGISTERED_CODEX" AGENT_RESULT_VALUE="$AGENT_RESULT_PATH" "$NODE_BIN" -e '
const fs = require("node:fs");
const labels = { codex: "Codex", claude: "Claude Code", gemini: "Gemini CLI", cursor: "Cursor", copilot: "GitHub Copilot CLI", opencode: "OpenCode" };
const result = JSON.parse(fs.readFileSync(process.env.AGENT_RESULT_VALUE, "utf8"));
const names = [...(process.env.REGISTERED_CODEX_VALUE === "1" ? ["codex"] : []), ...result.agents.map(({ name }) => name)];
process.stdout.write(names.map((name) => labels[name] ?? name).join(", "));
')"
echo "PixVerse API Plugin $VERSION is installed for: $AGENT_SUMMARY."
echo "Close and reopen each agent, then start a new task."
