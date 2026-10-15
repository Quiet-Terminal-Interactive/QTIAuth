import { startGateway } from "./server.ts";
import { createLogger } from "@qtiauth/common";

startGateway()
  .then(({ stop, log }) => {
    let stopping = false;
    const handler = (signal: string) => {
      if (stopping) return;
      stopping = true;
      log.info({ signal }, "shutting down");
      stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      setTimeout(() => process.exit(1), 15_000).unref();
    };
    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
  })
  .catch((err) => {
    createLogger("gateway").fatal({ err }, "gateway failed to start");
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
