import { Db, MongoClient, ServerApiVersion } from "mongodb";
import { env } from "../../config/env.js";

const mongoClient = new MongoClient(env.mongodbUri, {
  appName: "non-custodial-crypto-invoicing-api",

  maxPoolSize: 10,
  minPoolSize: 0,
  maxIdleTimeMS: 60_000,

  serverSelectionTimeoutMS: 5_000,
  waitQueueTimeoutMS: 5_000,

  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let database: Db | undefined;

export async function connectToMongoDb(): Promise<Db> {
  if (database) {
    return database;
  }

  try {
    await mongoClient.connect();

    const connectDatabase = mongoClient.db(env.mongodbDatabase);

    await connectDatabase.command({ ping: 1 });

    database = connectDatabase;

    return database;
  } catch (error) {
    await mongoClient.close();
    throw error;
  }
}

export function getDatabase(): Db {
  if (!database) {
    throw new Error(
      "MongoDB has not been connected. Call connectToMongoDB() first.",
    );
  }

  return database;
}

export async function isMongoDBReady(): Promise<boolean> {
  if (!database) {
    return false;
  }

  try {
    await database.command({ ping: 1 }, { timeoutMS: 1_000 });

    return true
  } catch (error) {
    return false
  }
}

export async function disconnectFromMongoDB():Promise<void>{
    database = undefined
    await mongoClient.close()
}