import { resolve } from "node:path";
import { startHubHost } from "./server";

const host = process.env.HUB_HOST ?? "127.0.0.1";
const portText = process.env.HUB_PORT ?? "8787";
const port = Number(portText);
const databasePath = resolve(
  process.env.HUB_DATABASE_PATH ?? ".hub-data/hub.sqlite",
);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("HUB_PORT must be an integer from 1 to 65535.");
}

const service = await startHubHost({ host, port, databasePath });
console.log(`Happy Hallways Hub Host prototype listening at ${service.url}`);
console.log(`SQLite state file: ${databasePath}`);
console.log(
  "Development only: loopback access, no staff authentication, no LAN binding.",
);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await service.close();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
