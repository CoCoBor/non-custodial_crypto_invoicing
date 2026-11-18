import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { fakeAppEnv } from "../helpers/fake-env.js";

// Old tests call deleteMany on whatever database they connect to. These tests
// prove a test run can never reach a database whose name does not end in
// "_test", so the real database can't be wiped by `npm test`.

const BACKEND_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GUARD = "./tests/setup/test-guard.ts";

const RUN_TIMEOUT_MS = 60_000;

// This file once stalled a full-suite run for ~15 minutes (cause not found).
// npm stays offline, and each command runs in its own process group so a
// timeout kills npm's children too: a surviving grandchild would keep the
// pipes open and the run would hang instead of failing.
const OFFLINE_NPM = {
  NO_UPDATE_NOTIFIER: "1",
  npm_config_update_notifier: "false",
  npm_config_offline: "true",
};

type RunResult = { status: number | null; stdout: string; stderr: string };

function run(command: string, args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: BACKEND_ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...OFFLINE_NPM, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The group is already gone.
      }
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`${command} ${args.join(" ")} did not finish within ${RUN_TIMEOUT_MS} ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, RUN_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function runWithGuard(code: string, env: Record<string, string>) {
  return run(
    process.execPath,
    ["--import", "tsx", "--import", GUARD, "--input-type=module", "-e", code],
    env,
  );
}

describe("the test guard", () => {
  it("stops before any test code runs when the database name does not end in _test", async () => {
    const result = await runWithGuard(`console.log("test body ran")`, {
      MONGODB_DATABASE: "merchant",
    });

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /test body ran/);
    assert.match(result.stderr, /_test/);
  });

  it("lets a run continue when the database name ends in _test", async () => {
    const result = await runWithGuard(`console.log("test body ran")`, {
      MONGODB_DATABASE: "merchant_test",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /test body ran/);
  });

  it("never lets dotenv read the real .env, and marks the run as a test", async () => {
    const result = await runWithGuard(
      `console.log(process.env.DOTENV_CONFIG_PATH, process.env.NODE_ENV)`,
      { MONGODB_DATABASE: "merchant_test" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "/dev/null test");
  });

  it("fills in fake config, so app modules load without the real .env", async () => {
    const result = await runWithGuard(
      `const { env } = await import("./src/config/env.ts");
       console.log(env.nodeEnvironment, env.dataEncryptionKey.length, env.mongodbDatabase);`,
      {},
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "test 32 never_connected_test");
  });

  it("keeps the database the shell asked for", async () => {
    const result = await runWithGuard(
      `const { env } = await import("./src/config/env.ts");
       console.log(env.mongodbUri, env.mongodbDatabase);`,
      {
        MONGODB_URI: "mongodb://127.0.0.1:27018",
        MONGODB_DATABASE: "merchant_test",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "mongodb://127.0.0.1:27018 merchant_test");
  });
});

describe("npm test", () => {
  it("refuses to start against a database whose name does not end in _test", async () => {
    // DOTENV_CONFIG_PATH and the dead URI keep this safe even if the guard
    // were removed: the run could not read .env or reach any database.
    const result = await run("npm", ["test", "--silent"], {
      MONGODB_DATABASE: "merchant",
      DOTENV_CONFIG_PATH: "/dev/null",
      MONGODB_URI: "mongodb://127.0.0.1:1/never-connected",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /_test/);
    assert.doesNotMatch(result.stdout, /tests\//, "no test file may start");
  });
});

describe("connecting to MongoDB in a test run", () => {
  it("is refused when the database name does not end in _test, even without the guard", async () => {
    const code = `
      const { connectToMongoDb } = await import("./src/infrastructure/database/mongodb.ts");
      try {
        await connectToMongoDb();
        console.log("connected");
      } catch (error) {
        console.log("refused: " + error.message);
      }
      process.exit(0);
    `;
    const result = await run(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      fakeAppEnv({ MONGODB_DATABASE: "merchant" }),
    );

    assert.match(result.stdout, /refused: .*_test/);
  });
});
