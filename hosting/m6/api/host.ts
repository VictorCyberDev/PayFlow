import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../../../src/console-hosted.js";

/** Thin Vercel adapter for the isolated NON-PRODUCTION M6 acceptance console. All behavior lives
 * in the accepted host/services; durable financial decisions remain server-side and PostgreSQL-backed. */
let hosted: ReturnType<typeof createHostedConsole> | undefined;
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    hosted ??= createHostedConsole(parseHostedConfig(process.env));
  } catch {
    // Fixed token only: configuration values are never logged or returned.
    console.error("M6_HOST_CONFIGURATION_INVALID");
    res.writeHead(503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify({ status: "UNAVAILABLE" }));
    return;
  }
  // Vercel's trailingSlash redirect also reaches /api/*; the accepted host matches exact paths,
  // so normalize only trailing API slashes before dispatching to the shared host.
  if (req.url)
    req.url = req.url.replace(/^(\/api\/[^?#]*?)\/+(?=[?#]|$)/, "$1");
  await hosted.handler(req, res);
}
