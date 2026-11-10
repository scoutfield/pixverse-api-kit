import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLAUDE_PLUGIN_ID,
  OWNER_MARKER,
  STANDALONE_SKILLS,
  installAgents,
  normalizeReceiptAgents,
  selectAgents,
  uninstallAgents,
} from "../../packaging/customer-plugin/dist/agents.js";

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-agents-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const binRoot = path.join(root, "bin");
  const installRoot = path.join(root, "install");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(binRoot, { recursive: true });
  for (const name of STANDALONE_SKILLS) {
    const skillRoot = path.join(installRoot, "agent-skills", name);
    await fs.mkdir(path.join(skillRoot, "references"), { recursive: true });
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: Test.\n---\n`);
    await fs.writeFile(path.join(skillRoot, "references", "doc.md"), "reference\n");
    await fs.writeFile(path.join(skillRoot, OWNER_MARKER), "owned\n");
  }
  const logPath = path.join(root, "claude-calls.jsonl");
  const env = { PATH: binRoot, CLAUDE_CALL_LOG: logPath };
  return { root, home, binRoot, installRoot, logPath, env };
}

async function addCommand(binRoot, name, source = "#!/bin/sh\nexit 0\n") {
  const commandPath = path.join(binRoot, name);
  await fs.writeFile(commandPath, source, { mode: 0o755 });
  await fs.chmod(commandPath, 0o755);
}

async function addFakeClaude(binRoot) {
  await addCommand(binRoot, "claude", `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const joined = args.join(" ");
fs.appendFileSync(process.env.CLAUDE_CALL_LOG, JSON.stringify(args) + "\\n");
if (process.env.FAKE_CLAUDE_FAIL_ON && joined.includes(process.env.FAKE_CLAUDE_FAIL_ON)) {
  process.stderr.write("simulated failure\\n");
  process.exit(1);
}
if (joined === "plugin marketplace list --json") {
  process.stdout.write(process.env.FAKE_CLAUDE_MARKETPLACES || "[]");
} else if (joined.startsWith("plugin install")) {
  process.stdout.write((process.env.FAKE_CLAUDE_INSTALL_JSON || JSON.stringify({ outcome: "ok" })) + "\\n");
}
`);
}

async function readCalls(logPath) {
  const text = await fs.readFile(logPath, "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

test("agent selection detects installed agents and validates explicit lists", async (t) => {
  const { home, binRoot, env } = await createFixture(t);
  assert.deepEqual(selectAgents({ requested: "auto", env, home }), []);

  await addCommand(binRoot, "codex");
  await addCommand(binRoot, "claude");
  await addCommand(binRoot, "cursor-agent");
  await fs.mkdir(path.join(home, ".gemini"));
  assert.deepEqual(selectAgents({ env, home }), ["codex", "claude", "gemini", "cursor"]);

  assert.deepEqual(selectAgents({ requested: "cursor, claude", env, home }), ["claude", "cursor"]);
  assert.deepEqual(selectAgents({ requested: "opencode", env, home }), ["opencode"]);
  assert.throws(() => selectAgents({ requested: "claude,vim", env, home }), /Unknown agent.*vim/);
  await fs.rm(path.join(binRoot, "codex"));
  assert.throws(() => selectAgents({ requested: "codex", env, home }), /`codex` command was not found/);
});

test("skill agents receive owned standalone skills that uninstall removes", async (t) => {
  const { home, installRoot, env } = await createFixture(t);
  const result = installAgents({ root: installRoot, agents: ["cursor", "gemini"], env, home });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.agents.map(({ name }) => name), ["cursor", "gemini"]);
  const cursorSkill = path.join(home, ".cursor/skills/pixverse-api-platform");
  assert.equal(await exists(path.join(cursorSkill, "SKILL.md")), true);
  assert.equal(await exists(path.join(cursorSkill, "references/doc.md")), true);
  assert.equal(await exists(path.join(home, ".gemini/skills/pixverse-api-start", OWNER_MARKER)), true);
  assert.deepEqual((await fs.readdir(path.join(home, ".cursor/skills"))).toSorted(), [...STANDALONE_SKILLS]);

  // Reinstalling replaces owned copies in place.
  const again = installAgents({ root: installRoot, agents: ["cursor"], env, home });
  assert.deepEqual(again.failures, []);

  assert.deepEqual(uninstallAgents({ agents: result.agents, env }), []);
  assert.deepEqual(await fs.readdir(path.join(home, ".cursor/skills")), []);
  assert.deepEqual(await fs.readdir(path.join(home, ".gemini/skills")), []);
});

test("skill install refuses to replace a same-named skill it does not own", async (t) => {
  const { home, installRoot, env } = await createFixture(t);
  const foreign = path.join(home, ".cursor/skills/pixverse-api-platform");
  await fs.mkdir(foreign, { recursive: true });
  await fs.writeFile(path.join(foreign, "SKILL.md"), "user skill\n");

  const result = installAgents({ root: installRoot, agents: ["cursor", "gemini"], env, home });
  assert.deepEqual(result.agents.map(({ name }) => name), ["gemini"]);
  assert.equal(result.failures[0].name, "cursor");
  assert.match(result.failures[0].message, /was not installed by PixVerse API Plugin/);
  assert.equal(await fs.readFile(path.join(foreign, "SKILL.md"), "utf8"), "user skill\n");
  assert.equal(await exists(path.join(home, ".cursor/skills/pixverse-api-start")), false);

  const failures = uninstallAgents({ agents: [{ name: "cursor", skill_dirs: [foreign] }], env });
  assert.match(failures[0].message, /not installed by PixVerse API Plugin/);
  assert.equal(await exists(foreign), true);
});

test("uninstall refuses skill paths outside the owned skill names", async (t) => {
  const { home, env } = await createFixture(t);
  const unrelated = path.join(home, "Documents");
  await fs.mkdir(unrelated);
  const failures = uninstallAgents({ agents: [{ name: "cursor", skill_dirs: [unrelated] }], env });
  assert.match(failures[0].message, /unexpected skill path/);
  assert.equal(await exists(unrelated), true);
});

test("Claude Code registration adds the marketplace and installs the plugin", async (t) => {
  const { home, binRoot, installRoot, logPath, env } = await createFixture(t);
  await addFakeClaude(binRoot);

  const result = installAgents({ root: installRoot, agents: ["codex", "claude"], env, home });
  assert.deepEqual(result, { agents: [{ name: "claude" }], failures: [] });
  assert.deepEqual(await readCalls(logPath), [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "add", installRoot],
    ["plugin", "install", CLAUDE_PLUGIN_ID, "--json"],
  ]);

  await fs.rm(logPath);
  assert.deepEqual(uninstallAgents({ agents: result.agents, env }), []);
  assert.deepEqual(await readCalls(logPath), [
    ["plugin", "uninstall", CLAUDE_PLUGIN_ID, "--json"],
    ["plugin", "marketplace", "remove", "pixverse-private-beta"],
  ]);
});

test("Claude Code upgrade refreshes an in-place marketplace and re-records the version", async (t) => {
  const { home, binRoot, installRoot, logPath, env } = await createFixture(t);
  await addFakeClaude(binRoot);
  const upgradeEnv = {
    ...env,
    FAKE_CLAUDE_MARKETPLACES: JSON.stringify([{ name: "pixverse-private-beta", path: installRoot }]),
    FAKE_CLAUDE_INSTALL_JSON: JSON.stringify({ outcome: "ok", installedVersion: "0.3.0-beta.1", availableVersion: "0.3.0-beta.4" }),
  };

  const result = installAgents({ root: installRoot, agents: ["claude"], env: upgradeEnv, home });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(await readCalls(logPath), [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "add", installRoot],
    ["plugin", "marketplace", "update", "pixverse-private-beta"],
    ["plugin", "install", CLAUDE_PLUGIN_ID, "--json"],
    ["plugin", "update", CLAUDE_PLUGIN_ID],
  ]);
});

test("Claude Code registration replaces a marketplace registered at another path", async (t) => {
  const { home, binRoot, installRoot, logPath, env } = await createFixture(t);
  await addFakeClaude(binRoot);
  const movedEnv = {
    ...env,
    FAKE_CLAUDE_MARKETPLACES: JSON.stringify([{ name: "pixverse-private-beta", path: "/old/prefix/pixverse-api" }]),
  };

  assert.deepEqual(installAgents({ root: installRoot, agents: ["claude"], env: movedEnv, home }).failures, []);
  assert.deepEqual((await readCalls(logPath)).map((args) => args.slice(0, 3).join(" ")), [
    "plugin marketplace list",
    "plugin uninstall pixverse-api@pixverse-private-beta",
    "plugin marketplace remove",
    "plugin marketplace add",
    "plugin install pixverse-api@pixverse-private-beta",
  ]);
});

test("failed Claude Code install removes the marketplace it added and reports the failure", async (t) => {
  const { home, binRoot, installRoot, logPath, env } = await createFixture(t);
  await addFakeClaude(binRoot);

  const result = installAgents({
    root: installRoot,
    agents: ["claude", "cursor"],
    env: { ...env, FAKE_CLAUDE_FAIL_ON: "plugin install" },
    home,
  });
  assert.deepEqual(result.agents.map(({ name }) => name), ["cursor"]);
  assert.equal(result.failures[0].name, "claude");
  assert.match(result.failures[0].message, /simulated failure/);
  assert.deepEqual((await readCalls(logPath)).at(-1), ["plugin", "marketplace", "remove", "pixverse-private-beta"]);
});

test("upgrades remove registrations the new install no longer selects", async (t) => {
  const { home, installRoot, env } = await createFixture(t);
  const first = installAgents({ root: installRoot, agents: ["cursor", "gemini"], env, home });
  const previous = { agents: [{ name: "codex" }, ...first.agents] };

  const second = installAgents({ root: installRoot, agents: ["gemini"], previous, env, home });
  assert.deepEqual(second.agents.map(({ name }) => name), ["gemini"]);
  assert.deepEqual(await fs.readdir(path.join(home, ".cursor/skills")), []);
  assert.deepEqual((await fs.readdir(path.join(home, ".gemini/skills"))).toSorted(), [...STANDALONE_SKILLS]);
});

test("legacy receipts without an agent list are treated as Codex-only", () => {
  assert.deepEqual(normalizeReceiptAgents(null), []);
  assert.deepEqual(normalizeReceiptAgents({ install_root: "/x" }), [{ name: "codex" }]);
  assert.deepEqual(
    normalizeReceiptAgents({ agents: [{ name: "claude" }, { name: "vim" }, { name: "cursor", skill_dirs: ["/a", 3] }] }),
    [{ name: "claude" }, { name: "cursor", skill_dirs: ["/a"] }],
  );
});
