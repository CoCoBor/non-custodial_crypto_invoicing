import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { fakeAppEnv } from "../helpers/fake-env.js";

// Old tests call deleteMany on whatever database they connect to. These tests
// prove a test run can never reach a database whose name does not end in
// "_test", so the real database can't be wiped by `npm test`.

const BACKEND_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GUARD = "./tests/setup/test-guard.ts";

function run(command: string, args: string[], env: Record<string, string>) {
  return spawnSync(command, args, {
    cwd: BACKEND_ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    encoding: "utf8",
    timeout: 60_000,
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
  it("stops before any test code runs when the database name does not end in _test", () => {
    const result = runWithGuard(`console.log("test body ran")`, {
      MONGODB_DATABASE: "merchant",
    });

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /test body ran/);
    assert.match(result.stderr, /_test/);
  });

  it("lets a run continue when the database name ends in _test", () => {
    const result = runWithGuard(`console.log("test body ran")`, {
      MONGODB_DATABASE: "merchant_test",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /test body ran/);
  });

  it("never lets dotenv read the real .env, and marks the run as a test", () => {
    const result = runWithGuard(
      `console.log(process.env.DOTENV_CONFIG_PATH, process.env.NODE_ENV)`,
      { MONGODB_DATABASE: "merchant_test" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "/dev/null test");
  });

  it("fills in fake config, so app modules load without the real .env", () => {
    const result = runWithGuard(
      `const { env } = await import("./src/config/env.ts");
       console.log(env.nodeEnvironment, env.dataEncryptionKey.length, env.mongodbDatabase);`,
      {},
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "test 32 never_connected_test");
  });

  it("keeps the database the shell asked for", () => {
    const result = runWithGuard(
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
  it("refuses to start against a database whose name does not end in _test", () => {
    // DOTENV_CONFIG_PATH and the dead URI keep this safe even if the guard
    // were removed: the run could not read .env or reach any database.
    const result = run("npm", ["test", "--silent"], {
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
  it("is refused when the database name does not end in _test, even without the guard", () => {
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
    const result = run(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      fakeAppEnv({ MONGODB_DATABASE: "merchant" }),
    );

    assert.match(result.stdout, /refused: .*_test/);
  });
});
