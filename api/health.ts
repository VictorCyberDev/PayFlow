import type { IncomingMessage, ServerResponse } from "node:http";

/** Deployment liveness only: deliberately independent of domain state and providers. */
export default function health(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.statusCode = 405;
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  response.statusCode = 200;
  response.end(JSON.stringify({ status: "ok", service: "payflow" }));
}
