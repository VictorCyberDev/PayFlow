import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../../../src/console-hosted.js";

/** Thin Vercel adapter for the isolated NON-PRODUCTION M5 console. All behavior lives in the
 * existing host and services; every durable decision uses PostgreSQL, never process memory. */
let hosted: ReturnType<typeof createHostedConsole> | undefined;
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    hosted ??= createHostedConsole(parseHostedConfig(process.env));
  } catch {
    // Fixed token only: configuration values are never logged or returned.
    console.error("M5_HOST_CONFIGURATION_INVALID");
    res.writeHead(503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify({ status: "UNAVAILABLE" }));
    return;
  }
  // The static pages need Vercel's trailingSlash redirect, which also reaches /api/*; the host
  // matches exact paths, so the API sees the same path with the slash removed.
  if (req.url)
    req.url = req.url.replace(/^(\/api\/[^?#]*?)\/+(?=[?#]|$)/, "$1");
  await hosted.handler(req, res);
}
