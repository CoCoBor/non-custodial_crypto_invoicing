const databaseName = process.env.MONGO_INITDB_DATABASE;
const username = process.env.MONGODB_APP_USERNAME;
const password = process.env.MONGODB_APP_PASSWORD;

if (!databaseName || !username || !password) {
  throw new Error(
    "MongoDB application-user configuration is incomplete",
  );
}

const applicationDatabase = db.getSiblingDB(databaseName);
const existingUser = applicationDatabase.getUser(username);

if (existingUser) {
  print(`Application user "${username}" already exists`);
} else {
  applicationDatabase.createUser({
    user: username,
    pwd: password,
    roles: [
      {
        role: "readWrite",
        db: databaseName,
      },
    ],
    mechanisms: ["SCRAM-SHA-256"],
  });

  print(`Application user "${username}" created`);
}