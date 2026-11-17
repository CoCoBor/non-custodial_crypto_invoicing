import { fakeAppEnv } from "../helpers/fake-env.js";

// Loaded with --import before any test code (see the "test" script).
// Tests delete data in the database they connect to, so a test run must never
// read the real .env or point at a database whose name does not end in _test.
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.NODE_ENV = "test";

const databaseName = process.env.MONGODB_DATABASE;

if (databaseName !== undefined && !databaseName.endsWith("_test")) {
  process.stderr.write(
    `Refusing to run tests: MONGODB_DATABASE is "${databaseName}". ` +
      `A test database name must end in "_test".\n`,
  );
  process.exit(1);
}

// Fake keys and addresses for anything the shell did not set, so app modules
// load without the real .env. The shell still chooses the test database.
for (const [name, value] of Object.entries(fakeAppEnv())) {
  process.env[name] ??= value;
}
