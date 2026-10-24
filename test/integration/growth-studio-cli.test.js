import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../../src/cli.js";
import { runGrowthStudioCommand } from "../../src/growth-studio/cli.js";
import { createRecordingFetch, jsonResponse } from "../helpers/recording-fetch.js";

test("canonical Growth Studio namespace is independent from Platform configuration", async () => {
  const output = captureOutput();
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse('{"folders":[{"folder_id":630251570268735431,"name":"ACME"}],"request_id":"req-folders"}'),
  ]);
  const exitCode = await main(["growth-studio", "folders", "list"], {
    env: {
      PIXVERSE_GROWTH_API_KEY: "mh_live_fixture",
      PIXVERSE_GROWTH_BASE_URL: "http://127.0.0.1:1",
    },
    fetchImpl,
    ...output.context,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output.stdout()), {
    folders: [{ folder_id: "630251570268735431", name: "ACME" }],
    request_id: "req-folders",
  });
  assert.equal(output.stderr(), "");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(new URL(calls[0].url).pathname, "/openapi/v1/folders");
  assert.equal(calls[0].headers.get("Authorization"), "Bearer mh_live_fixture");
  assert.equal(calls[0].headers.has("API-KEY"), false);
});

test("Platform namespace is independent from Growth Studio configuration", async () => {
  const output = captureOutput();
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({ ErrCode: 0, ErrMsg: "success", Resp: { credit_monthly: 10 } }),
  ]);
  const exitCode = await main(["platform", "account", "balance"], {
    env: {
      PIXVERSE_PLATFORM_API_KEY: "platform-fixture-key",
      PIXVERSE_PLATFORM_BASE_URL: "http://127.0.0.1:1",
    },
    fetchImpl,
    ...output.context,
  });

  assert.equal(exitCode, 0, output.stderr());
  assert.equal(JSON.parse(output.stdout()).data.credit_monthly, 10);
  assert.equal(output.stderr(), "Cost: $0 (non-billable call)\n");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get("API-KEY"), "platform-fixture-key");
  assert.equal(calls[0].headers.has("Authorization"), false);
});

test("legacy aliases preserve canonical Growth Studio JSON and add one warning", async () => {
  const canonicalOutput = captureOutput();
  const legacyOutput = captureOutput();
  const response = { video_id: "627410861853514292", status: "succeeded" };
  const canonicalFetch = createRecordingFetch([jsonResponse(response)]);
  const legacyFetch = createRecordingFetch([jsonResponse(response)]);
  const env = {
    PIXVERSE_GROWTH_API_KEY: "mh_live_fixture",
    PIXVERSE_GROWTH_BASE_URL: "http://127.0.0.1:1",
  };

  const canonicalExitCode = await main(["growth-studio", "video", "get", "627410861853514292"], {
    env,
    fetchImpl: canonicalFetch.fetchImpl,
    ...canonicalOutput.context,
  });
  const legacyExitCode = await main(["get", "627410861853514292"], {
    env,
    fetchImpl: legacyFetch.fetchImpl,
    ...legacyOutput.context,
  });

  assert.equal(canonicalExitCode, 0);
  assert.equal(legacyExitCode, 0);
  assert.equal(legacyOutput.stdout(), canonicalOutput.stdout());
  assert.deepEqual(JSON.parse(legacyOutput.stdout()), response);
  assert.equal(canonicalOutput.stderr(), "");
  assert.equal(
    legacyOutput.stderr(),
    'Warning: legacy command syntax is deprecated; use the "pixverse-api growth-studio" namespace.\n',
  );
});

test("PDP dry run resolves its payload from the command context without credentials", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixverse-pdp-cli-integration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "pdp.json"), JSON.stringify({
    product: {
      title: "Linen Summer Shirt",
      images: [{ url: "https://media.pixverse.ai/example/front.webp" }],
    },
    video: { mode: "standard" },
  }));
  const output = captureOutput();

  const exitCode = await main([
    "growth-studio", "pdp", "create", "--payload", "pdp.json", "--dry-run",
  ], {
    cwd: root,
    env: {},
    fetchImpl: async () => {
      throw new Error("dry run must not use the network");
    },
    ...output.context,
  });

  assert.equal(exitCode, 0, output.stderr());
  assert.equal(output.stderr(), "");
  const result = JSON.parse(output.stdout());
  assert.equal(result.capability, "pdp");
  assert.equal(result.billable, false);
  assert.equal(result.path, "/openapi/v1/ecommerce_pdp/video");
  assert.equal("type" in result.body, false);
  assert.deepEqual(await fs.readdir(root), ["pdp.json"]);
});

test("wallet ledger CLI sends validated integer pagination and preserves string values", async () => {
  const output = captureOutput();
  const { calls, fetchImpl } = createRecordingFetch([
    jsonResponse({
      balance: "87.50",
      ledgers: [{ amount: "-12.50", source_id: "627410861853514292" }],
    }),
  ]);
  const exitCode = await main([
    "growth-studio", "wallet", "ledgers", "--offset", "2", "--limit", "50",
  ], {
    env: {
      PIXVERSE_GROWTH_API_KEY: "mh_live_fixture",
      PIXVERSE_GROWTH_BASE_URL: "http://127.0.0.1:1",
    },
    fetchImpl,
    ...output.context,
  });

  assert.equal(exitCode, 0, output.stderr());
  assert.equal(output.stderr(), "");
  assert.equal(JSON.parse(output.stdout()).ledgers[0].amount, "-12.50");
  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.pathname, "/openapi/v1/wallet/ledgers");
  assert.equal(requestUrl.searchParams.get("offset"), "2");
  assert.equal(requestUrl.searchParams.get("limit"), "50");
  assert.equal(calls[0].headers.get("Authorization"), "Bearer mh_live_fixture");
  assert.equal(calls[0].headers.has("API-KEY"), false);
});

test("PDP get and poll reject nonnumeric IDs before client access or sleep", async () => {
  let clientAccesses = 0;
  let sleepCalls = 0;
  const context = {
    env: {},
    sleep: async () => { sleepCalls += 1; },
    get client() {
      clientAccesses += 1;
      throw new Error("client must not be loaded for an invalid PDP ID");
    },
  };

  await assert.rejects(
    runGrowthStudioCommand(["pdp", "get", "not-a-video-id"], context),
    /video_id must be a numeric string/,
  );
  await assert.rejects(
    runGrowthStudioCommand([
      "pdp", "poll", "123-not-numeric", "--initial-delay-seconds", "0",
    ], context),
    /video_id must be a numeric string/,
  );
  assert.equal(clientAccesses, 0);
  assert.equal(sleepCalls, 0);
});

test("PDP and wallet duplicate options reject before configuration", async () => {
  let clientAccesses = 0;
  const context = {
    env: {},
    get client() {
      clientAccesses += 1;
      throw new Error("client must not be loaded for duplicate options");
    },
  };
  const cases = [
    [["pdp", "create", "--payload", "one.json", "--payload", "two.json", "--dry-run"], /Duplicate pdp option: --payload/],
    [["pdp", "create", "--payload", "one.json", "--confirm-billable", "--confirm-billable"], /Duplicate pdp option: --confirm-billable/],
    [["pdp", "poll", "627410861853514292", "--timeout-minutes", "1", "--timeout-minutes", "2"], /Duplicate pdp option: --timeout-minutes/],
    [["pdp", "poll", "627410861853514292", "--initial-delay-seconds", "0", "--initial-delay-seconds", "1"], /Duplicate pdp option: --initial-delay-seconds/],
    [["pdp", "resume", "job", "--fallback-delay-seconds", "0", "--fallback-delay-seconds", "1"], /Duplicate pdp option: --fallback-delay-seconds/],
    [["wallet", "ledgers", "--offset", "1", "--offset", "2"], /Duplicate wallet ledgers option: --offset/],
    [["wallet", "ledgers", "--limit", "20", "--limit", "30"], /Duplicate wallet ledgers option: --limit/],
  ];

  for (const [args, message] of cases) {
    await assert.rejects(runGrowthStudioCommand(args, context), message);
  }
  assert.equal(clientAccesses, 0);
});

function captureOutput() {
  let stdout = "";
  let stderr = "";
  return {
    context: {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
