#!/usr/bin/env node
// Runs the COMPILED hosted application (dist/) on a loopback port, for acceptance runs. Reads the same environment the Vercel function reads.
//   npm run build && PORT=4817 DATABASE_URL=... node scripts/serve-hosted.mjs
import { createServer } from "node:http";
const { createHostedConsole, parseHostedConfig } =
  await import("../dist/src/console-hosted.js");
const hosted = createHostedConsole(parseHostedConfig(process.env));
const port = Number(process.env.PORT ?? 4817);
createServer((req, res) => void hosted.handler(req, res)).listen(
  port,
  "127.0.0.1",
  () => console.log(JSON.stringify({ event: "LISTENING", port })),
);
