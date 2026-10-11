import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../../src/cli.js";
import { formatError, formatSuccess } from "../../src/cli/output.js";
import { routeCommand } from "../../src/cli/router.js";
import { importCli, runCli } from "../helpers/cli-process.js";

test("routeCommand separates provider commands from legacy Growth Studio aliases", () => {
  assert.deepEqual(routeCommand(["growth-studio", "folders", "list"]), {
    provider: "growth-studio",
    providerArgs: ["folders", "list"],
    legacy: false,
  });
  assert.deepEqual(routeCommand(["platform", "account", "balance"]), {
    provider: "platform",
    providerArgs: ["account", "balance"],
    legacy: false,
  });
  assert.deepEqual(routeCommand(["get", "627410861853514292"]), {
    provider: "growth-studio",
    providerArgs: ["video", "get", "627410861853514292"],
    legacy: true,
    legacyCommand: "get",
  });
  assert.equal(routeCommand(["not-a-provider"]).provider, "unknown");
});

test("formatters preserve JSON output and redact structured errors", () => {
  assert.equal(formatSuccess({ video_id: "627410861853514292" }), '{\n  "video_id": "627410861853514292"\n}\n');
  const keyField = "api" + "_key";
  const formatted = formatError(Object.assign(new Error("request failed"), {
    details: { [keyField]: "do-not-print" },
  }));
  assert.match(formatted, /"message": "request failed"/);
  assert.doesNotMatch(formatted, /do-not-print/);
});

test("main prints top-level help without loading either provider configuration", async () => {
  const output = captureOutput();
  let providerCalls = 0;
  const exitCode = await main(["--help"], {
    env: {},
    ...output.context,
    runGrowthStudioCommand: async () => { providerCalls += 1; },
    runPlatformCommand: async () => { providerCalls += 1; },
  });

  assert.equal(exitCode, 0);
  assert.equal(providerCalls, 0);
  assert.match(output.stdout(), /pixverse-api growth-studio/);
  assert.match(output.stdout(), /pixverse-api platform/);
  assert.equal(output.stderr(), "");
});

test("main prints the top-level version without loading either provider configuration", async () => {
  const output = captureOutput();
  let providerCalls = 0;
  const exitCode = await main(["--version"], {
    env: {},
    ...output.context,
    runGrowthStudioCommand: async () => { providerCalls += 1; },
    runPlatformCommand: async () => { providerCalls += 1; },
  });

  assert.equal(exitCode, 0);
  assert.equal(providerCalls, 0);
  assert.equal(output.stdout(), "0.3.0-beta.3\n");
  assert.equal(output.stderr(), "");
});

test("main injects the full context into canonical Growth Studio commands", async () => {
  const output = captureOutput();
  const env = Object.freeze({ TEST_ENVIRONMENT: "fixture" });
  const fetchImpl = async () => new Response();
  const sleep = async () => {};
  const now = () => 42;
  let received;

  const exitCode = await main(["growth-studio", "folders", "list"], {
    env,
    fetchImpl,
    sleep,
    now,
    cwd: "/tmp/pixverse-cli-fixture",
    ...output.context,
    runGrowthStudioCommand: async (args, context) => {
      received = { args, context };
      return { folders: [] };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(received.args, ["folders", "list"]);
  assert.equal(received.context.env, env);
  assert.equal(received.context.fetchImpl, fetchImpl);
  assert.equal(received.context.sleep, sleep);
  assert.equal(received.context.now, now);
  assert.equal(received.context.cwd, "/tmp/pixverse-cli-fixture");
  assert.equal(JSON.parse(output.stdout()).folders.length, 0);
});

test("main routes Platform JSON to stdout and keeps diagnostics on stderr", async () => {
  const output = captureOutput();
  const exitCode = await main(["platform", "account", "balance"], {
    env: {},
    ...output.context,
    runPlatformCommand: async (args) => {
      assert.deepEqual(args, ["account", "balance"]);
      return { operation: "account.balance", data: { credit_monthly: 10 } };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output.stdout()), {
    operation: "account.balance",
    data: { credit_monthly: 10 },
  });
  assert.equal(output.stderr(), "");
});

test("legacy commands write one deprecation line and unchanged JSON stdout", async () => {
  const output = captureOutput();
  const rawArgument = "627410861853514292\nINJECTED https://secret.example.test/private /tmp/private.json";
  const exitCode = await main(["get", rawArgument], {
    env: {},
    ...output.context,
    runGrowthStudioCommand: async (args) => {
      assert.deepEqual(args, ["video", "get", rawArgument]);
      return { video_id: "627410861853514292" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(output.stdout()).video_id, "627410861853514292");
  assert.equal(
    output.stderr(),
    'Warning: legacy command syntax is deprecated; use the "pixverse-api growth-studio" namespace.\n',
  );
  assert.doesNotMatch(output.stderr(), /INJECTED|secret\.example|private\.json/);
});

test("unknown providers fail cleanly and imported functions never exit the process", async () => {
  const output = captureOutput();
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const exitCode = await main(["unknown", "command"], { env: {}, ...output.context });
    assert.equal(exitCode, 1);
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = originalExitCode;
  }
  assert.match(output.stderr(), /Unknown provider or command/);
});

test("platform routing does not load Growth Studio configuration", async () => {
  const output = captureOutput();
  let growthStudioCalls = 0;
  const exitCode = await main(["platform", "account", "balance"], {
    env: {},
    ...output.context,
    runGrowthStudioCommand: async () => { growthStudioCalls += 1; },
  });

  assert.equal(exitCode, 1);
  assert.equal(growthStudioCalls, 0);
  assert.match(output.stderr(), /PIXVERSE_PLATFORM_API_KEY/);
});

test("auth commands store dedicated Platform and Growth Studio API keys", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-auth-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const platform = captureOutput();
  const growth = captureOutput();
  const env = { HOME: home };

  assert.equal(await main(["auth", "login", "platform", "--stdin"], {
    env,
    stdin: "platform-fixture-key\n",
    ...platform.context,
  }), 0);
  assert.equal(await main(["auth", "login", "growth-studio", "--stdin"], {
    env,
    stdin: "mh_live_fixture_key\n",
    ...growth.context,
  }), 0);

  const status = captureOutput();
  assert.equal(await main(["auth", "status"], { env, ...status.context }), 0);
  const statusJson = JSON.parse(status.stdout());
  assert.equal(statusJson.platform.configured, true);
  assert.equal(statusJson.platform.source, "user-file");
  assert.equal(statusJson.growthStudio.configured, true);
  assert.equal(statusJson.growthStudio.source, "user-file");
  assert.doesNotMatch(status.stdout(), /platform-fixture-key|mh_live_fixture_key/);

  const credentialsPath = path.join(home, ".pixverse-api-kit/credentials.env");
  const stats = await fs.stat(credentialsPath);
  assert.equal(stats.mode & 0o077, 0);
  const saved = await fs.readFile(credentialsPath, "utf8");
  assert.match(saved, new RegExp(`PIXVERSE_PLATFORM_${"API_KEY"}=`));
  assert.match(saved, new RegExp(`PIXVERSE_GROWTH_${"API_KEY"}=`));
});

test("auth logout removes only the selected dedicated API key", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-auth-logout-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { HOME: home };

  assert.equal(await main(["auth", "login", "platform", "--stdin"], {
    env,
    stdin: "platform-fixture-key\n",
    ...captureOutput().context,
  }), 0);
  assert.equal(await main(["auth", "login", "growth-studio", "--stdin"], {
    env,
    stdin: "mh_live_fixture_key\n",
    ...captureOutput().context,
  }), 0);
  assert.equal(await main(["auth", "logout", "platform"], { env, ...captureOutput().context }), 0);

  const status = captureOutput();
  assert.equal(await main(["auth", "status"], { env, ...status.context }), 0);
  const statusJson = JSON.parse(status.stdout());
  assert.equal(statusJson.platform.configured, false);
  assert.equal(statusJson.growthStudio.configured, true);
});

test("auth status reads legacy Application Support credentials as a fallback", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-legacy-auth-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const legacyRoot = path.join(home, "Library/Application Support/PixVerse/api-plugin");
  await fs.mkdir(legacyRoot, { recursive: true });
  await fs.writeFile(path.join(legacyRoot, "credentials.env"), [
    "PIXVERSE_PLATFORM_API_KEY=legacy-platform-fixture",
    "PIXVERSE_GROWTH_API_KEY=mh_live_legacy_fixture",
    "",
  ].join("\n"), { mode: 0o600 });

  const status = captureOutput();
  assert.equal(await main(["auth", "status"], {
    env: { HOME: home },
    ...status.context,
  }), 0);

  const statusJson = JSON.parse(status.stdout());
  assert.equal(statusJson.filePath, path.join(home, ".pixverse-api-kit/credentials.env"));
  assert.equal(statusJson.platform.configured, true);
  assert.equal(statusJson.platform.source, "user-file");
  assert.equal(statusJson.growthStudio.configured, true);
  assert.equal(statusJson.growthStudio.source, "user-file");
  assert.doesNotMatch(status.stdout(), /legacy-platform-fixture|mh_live_legacy_fixture/);
});

test("CLI module import is process-isolated and has no output", async () => {
  const result = await importCli({ env: { PIXVERSE_GROWTH_API_KEY: "" } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("executable CLI help and unknown commands return stable exit codes", async () => {
  const help = await runCli(["--help"], { env: { PIXVERSE_GROWTH_API_KEY: "" } });
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /pixverse-api growth-studio/);
  assert.equal(help.stderr, "");

  const unknown = await runCli(["unknown"], { env: { PIXVERSE_GROWTH_API_KEY: "" } });
  assert.equal(unknown.exitCode, 1);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /Unknown provider or command/);
});

test("non-Growth executable routes do not read Growth Studio dotenv state", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-routing-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-routing-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, ".env"));

  const help = await runCli(["--help"], { cwd, env: { HOME: home } });
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /pixverse-api growth-studio/);
  assert.equal(help.stderr, "");

  const unknown = await runCli(["unknown"], { cwd, env: { HOME: home } });
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr, /Unknown provider or command/);
  assert.doesNotMatch(unknown.stderr, /EISDIR|\.env/);

  const platform = await runCli(["platform", "account", "balance"], { cwd, env: { HOME: home } });
  assert.equal(platform.exitCode, 1);
  assert.match(platform.stderr, /PIXVERSE_PLATFORM_API_KEY/);
  assert.doesNotMatch(platform.stderr, /EISDIR/);
});

test("Growth Studio executable still loads provider configuration from cwd dotenv", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-growth-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/openapi/v1/folders");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ folders: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-growth-dotenv-"));
  const { port } = server.address();
  await fs.writeFile(path.join(cwd, ".env"), [
    `PIXVERSE_GROWTH_API_KEY=${"mh_" + "live_fixture"}`,
    `PIXVERSE_GROWTH_BASE_URL=http://127.0.0.1:${port}`,
    "",
  ].join("\n"));

  try {
    const result = await runCli(["growth-studio", "folders", "list"], {
      cwd,
      env: {
        HOME: home,
        PIXVERSE_GROWTH_API_KEY: "",
        PIXVERSE_GROWTH_BASE_URL: "",
      },
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { folders: [] });
    assert.equal(result.stderr, "");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Platform executable lazily loads only its provider configuration from cwd dotenv", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-platform-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/openapi/v2/account/balance");
    assert.equal(request.headers["api-key"], "platform-fixture-credential");
    response.setHeader("content-type", "application/json");
    response.end('{"ErrCode":0,"ErrMsg":"success","Resp":{"credit_monthly":12}}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-platform-dotenv-"));
  const { port } = server.address();
  await fs.writeFile(path.join(cwd, ".env"), [
    "PIXVERSE_PLATFORM_API_KEY=platform-fixture-credential",
    `PIXVERSE_PLATFORM_BASE_URL=http://127.0.0.1:${port}`,
    "PIXVERSE_GROWTH_API_KEY=must-not-be-required-or-used",
    "",
  ].join("\n"));

  try {
    const result = await runCli(["platform", "account", "balance"], {
      cwd,
      env: {
        HOME: home,
        PIXVERSE_PLATFORM_API_KEY: "",
        PIXVERSE_PLATFORM_BASE_URL: "",
        PIXVERSE_GROWTH_API_KEY: "",
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).data.credit_monthly, 12);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("executable routes load dedicated API credentials from the user auth store", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-api-user-store-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const supportRoot = path.join(home, ".pixverse-api-kit");
  await fs.mkdir(supportRoot, { recursive: true });

  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/openapi/v2/account/balance");
    assert.equal(request.headers["api-key"], "platform-fixture-user-store-key");
    response.setHeader("content-type", "application/json");
    response.end('{"ErrCode":0,"ErrMsg":"success","Resp":{"credit_monthly":18}}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await fs.writeFile(path.join(supportRoot, "credentials.env"), [
    "PIXVERSE_PLATFORM_API_KEY=platform-fixture-user-store-key",
    `PIXVERSE_PLATFORM_BASE_URL=http://127.0.0.1:${port}`,
    "PIXVERSE_GROWTH_API_KEY=mh_live_fixture_must_not_be_used",
    "",
  ].join("\n"), { mode: 0o600 });

  try {
    const result = await runCli(["platform", "account", "balance"], {
      env: {
        HOME: home,
        PIXVERSE_PLATFORM_API_KEY: "",
        PIXVERSE_PLATFORM_BASE_URL: "",
        PIXVERSE_GROWTH_API_KEY: "",
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).data.credit_monthly, 18);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("legacy executable preserves JSON stdout and emits one deprecation line", async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/openapi/v1/folders");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ folders: [{ folder_id: "630251570268735431" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const result = await runCli(["folders"], {
      env: {
        PIXVERSE_GROWTH_API_KEY: "mh_" + "live_fixture",
        PIXVERSE_GROWTH_BASE_URL: `http://127.0.0.1:${port}`,
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      folders: [{ folder_id: "630251570268735431" }],
    });
    assert.equal(
      result.stderr,
      'Warning: legacy command syntax is deprecated; use the "pixverse-api growth-studio" namespace.\n',
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function captureOutput() {
  const stdoutChunks = [];
  const stderrChunks = [];
  return {
    context: {
      stdout: { write: (value) => { stdoutChunks.push(String(value)); } },
      stderr: { write: (value) => { stderrChunks.push(String(value)); } },
    },
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
  };
}
