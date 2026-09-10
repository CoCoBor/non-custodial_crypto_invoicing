import { type Db,ServerApiVersion } from "mongodb";
import { env } from "../../config/env.js";
import mongoose from "mongoose";

let database: Db | undefined;

export async function connectToMongoDb(): Promise<Db> {
  if (database) {
    return database;
  }

  try {
    await mongoose.connect(env.mongodbUri, {
      dbName: env.mongodbDatabase,
      appName: "non-custodial-crypto-invoicing-api",

      maxPoolSize: 10,
      minPoolSize: 0,
      maxIdleTimeMS: 60_000,
      serverSelectionTimeoutMS: 5_000,
      waitQueueTimeoutMS: 5_000,
      promoteBuffers: true,

      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },

      autoIndex: false,
      autoCreate: false,
    });

    const connectedDatabase = mongoose.connection.db;

    if (!connectedDatabase) {
      throw new Error("MongoDB connection is unavailable");
    }

    await connectedDatabase.command({ ping: 1 });

    database = connectedDatabase;
    return database;
  } catch (error) {
    await mongoose.disconnect();
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

    return true;
  } catch (error) {
    return false;
  }
}

export async function disconnectFromMongoDB(): Promise<void> {
  database = undefined;
  await mongoose.disconnect();
}
