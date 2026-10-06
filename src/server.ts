import { createApp } from "./app";

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}

const app = createApp();

const server = app.listen(port, () => {
  console.log(`trio-haplotype-audit listening on :${port}`);
});

function shutdown(signal: string): void {
  console.log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
