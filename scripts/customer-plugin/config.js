import path from "node:path";

export const CUSTOMER_PLUGIN_RELEASE = Object.freeze({
  pluginName: "pixverse-api",
  marketplaceName: "pixverse-private-beta",
  version: "0.3.0-beta.3",
  archiveBaseName: "pixverse-api-plugin-0.3.0-beta.3",
  sourceDateEpoch: 1_790_294_400,
});

export const CUSTOMER_PLUGIN_ALLOWLIST = Object.freeze({
  runtimeFiles: Object.freeze([
    "src/cli.js",
    "src/cli/options.js",
    "src/cli/output.js",
    "src/cli/router.js",
    "src/client.js",
    "src/config.js",
    "src/core/artifacts.js",
    "src/core/errors.js",
    "src/core/http.js",
    "src/core/media.js",
    "src/core/polling.js",
    "src/core/redaction.js",
    "src/core/trace.js",
    "src/credentials.js",
    "src/folders.js",
    "src/growth-studio/cli.js",
    "src/growth-studio/client.js",
    "src/growth-studio/config.js",
    "src/growth-studio/folders.js",
    "src/growth-studio/jobs.js",
    "src/growth-studio/pdp.js",
    "src/growth-studio/validation.js",
    "src/growth-studio/wallet.js",
    "src/http.js",
    "src/jobs.js",
    "src/platform/cli.js",
    "src/platform/client.js",
    "src/platform/config.js",
    "src/platform/envelope.js",
    "src/platform/jobs.js",
    "src/platform/operations.js",
    "src/platform/operations/account.js",
    "src/platform/operations/agents.js",
    "src/platform/operations/audio.js",
    "src/platform/operations/resources.js",
    "src/platform/operations/uploads.js",
    "src/platform/operations/video-editing.js",
    "src/platform/operations/video-generation.js",
    "src/platform/pricing.js",
    "src/platform/request.js",
    "src/platform/status.js",
    "src/platform/validation.js",
    "src/platform/validators/common.js",
    "src/platform/validators/media.js",
    "src/platform/validators/music-mv.js",
    "src/platform/validators/specialized.js",
    "src/platform/validators/video.js",
    "src/platform/webhooks.js",
  ]),
  apiDocuments: Object.freeze([
    "docs/api/command-reference.md",
    "docs/api/growth-studio-pdp.md",
    "docs/api/platform-operations.md",
    "docs/api/safety-and-recovery.md",
  ]),
  packageFiles: Object.freeze(["package.json", "package-lock.json"]),
  pluginSource: "packaging/customer-plugin",
  packageRootFiles: Object.freeze([
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
    "auth.command",
    "dist/agents.js",
    "INSTALL-MACOS.md",
    "install.command",
    "uninstall.command",
  ]),
  skillReferences: Object.freeze({
    "growth-studio": Object.freeze([
      "docs/api/growth-studio-pdp.md",
      "docs/api/safety-and-recovery.md",
      "packaging/customer-plugin/plugin/examples/pdp-standard-high.json",
    ]),
    platform: Object.freeze([
      "docs/api/command-reference.md",
      "docs/api/platform-operations.md",
      "docs/api/safety-and-recovery.md",
    ]),
    start: Object.freeze([
      "docs/api/command-reference.md",
      "docs/api/safety-and-recovery.md",
    ]),
  }),
});

// Standalone Agent Skills for agents without a plugin marketplace (Gemini CLI, Cursor, and others).
// Each is a copy of a plugin skill renamed with this prefix so it cannot collide with other skills.
export const STANDALONE_SKILL_PREFIX = "pixverse-api-";
export const STANDALONE_SKILL_OWNER_MARKER = ".pixverse-api-plugin";

export const CUSTOMER_PLUGIN_DENIED_PATHS = Object.freeze([
  ".env",
  ".git",
  "assets",
  "deploy",
  "docs/brand-pitches",
  "docs/superpowers",
  "jobs",
  "payloads",
  "pixverse-api-jobs",
  "pixverse-cli-jobs",
  "projects",
  "qa",
  "research",
  "test",
]);

export function customerPluginOutputDirectory(repoRoot) {
  return path.join(
    path.resolve(repoRoot),
    "dist",
    "customer-plugin",
    CUSTOMER_PLUGIN_RELEASE.version,
  );
}
