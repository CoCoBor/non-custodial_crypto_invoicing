import { createApp } from "./app.js";
import { env } from "./config/env.js";
import {
  connectToMongoDb,
  disconnectFromMongoDB,
} from "./infrastructure/database/mongodb.js";

const app = createApp();

async function startServer(): Promise<void> {
  try {
    const db = await connectToMongoDb();   

    
    console.log("MongoDB connected");

    const server = app.listen(env.port, () => {
      console.log(
        `API listening at http://localhost:${env.port} in ${env.nodeEnvironment} mode`,
      );
    });
    let isShuttingDown = false;

    async function shutDown(signal: NodeJS.Signals): Promise<void> {
      if (isShuttingDown) {
        return;
      }

      isShuttingDown = true;
      console.log(`${signal} received; stopping the HTTP server`);
      server.close(async (error) => {
        if (error) {
          console.error("The HTTP server did not stop cleanly", error);
          process.exitCode = 1;
        } else {
          console.log("HTTP server stopped");
        }

        try {
          await disconnectFromMongoDB();
          console.log("MongoDB disconnected");
        } catch (error) {
          console.error("MongoDB did not disconnect cleanly", error);
          process.exitCode = 1;
        }
      });

    }
      process.once("SIGINT", shutDown);
      process.once("SIGTERM", shutDown);
  } catch (error) {
    console.error("Application startup failed", error)
    process.exitCode = 1
  }
}

void startServer()