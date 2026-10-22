import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { createDemoReview } from "./intent-review-demo.js";

/** Loopback-only, non-production fixture host. No auth, DB, live model or payment. */
export function createReviewDemoHost(outputDirectory: string) {
  const { sample, service } = createDemoReview();
  return createServer((req, res) => {
    void handle(req, res).catch(() =>
      json(res, 500, { error: "REVIEW_UNAVAILABLE" }),
    );
  });
  function json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(value));
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(req.headers.host ?? ""))
      return json(res, 403, { error: "HOST_REJECTED" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      if (
        req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}`
      )
        return json(res, 403, { error: "ORIGIN_REJECTED" });
      if (url.pathname === "/api/intent-review/sample" && req.method === "GET")
        return json(res, 200, { mode: "NON_PRODUCTION_REVIEW", sample });
      if (url.pathname !== "/api/intent-review" || req.method !== "POST")
        return json(res, 405, { error: "METHOD_NOT_ALLOWED" });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "JSON_REQUIRED" });
      let body = "";
      for await (const chunk of req) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 8192)
          return json(res, 413, { error: "SOURCE_TOO_LARGE" });
      }
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        return json(res, 400, { error: "INVALID_REQUEST" });
      }
      const review = await service.review(input);
      return review
        ? json(res, 200, review)
        : json(res, 400, { error: "INVALID_REQUEST" });
    }
    if (req.method !== "GET")
      return json(res, 405, { error: "METHOD_NOT_ALLOWED" });
    const base = resolve(outputDirectory),
      file = resolve(
        base,
        `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
      );
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
      ".ico": "image/x-icon",
      ".svg": "image/svg+xml",
    };
    if (!file.startsWith(base + "/") || !mime[extname(file)])
      return json(res, 404, { error: "NOT_FOUND" });
    try {
      const content = await readFile(file);
      res.writeHead(200, {
        "Content-Type": mime[extname(file)]!,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        "Cache-Control": "no-store",
      });
      res.end(content);
    } catch {
      json(res, 404, { error: "NOT_FOUND" });
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createReviewDemoHost(resolve("apps/console/out"));
  server.listen(8080, "127.0.0.1", () =>
    console.log(
      "NON-PRODUCTION fixture review: http://127.0.0.1:8080; no activation or payment",
    ),
  );
}
