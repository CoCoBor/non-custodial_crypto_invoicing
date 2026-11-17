import { isAllowedWebhookDestination } from "./destination.js";
import { runWebhookPass, type WebhookPorts } from "./webhook-pass.js";

export function startWebhookSender() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentRun: Promise<void> = Promise.resolve();

  const ports: WebhookPorts = {
    now: Date.now,
    isAllowedDestination: (url) => isAllowedWebhookDestination(url),
    post: fetch,
  };

  async function sendWebhooks(): Promise<void> {
    try {
      await runWebhookPass(ports);
    } catch (error) {
      console.error("Webhook sender failed:", error);
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          currentRun = sendWebhooks();
        }, 15_000);
      }
    }
  }

  currentRun = sendWebhooks();

  return async function stopWebhookSender(): Promise<void> {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    await currentRun;
  };
}
