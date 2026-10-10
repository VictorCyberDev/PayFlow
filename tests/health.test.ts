import { readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import health from "../api/health.js";

function invoke(method: string) {
  const request = new IncomingMessage(new Socket());
  request.method = method;
  const response = new ServerResponse(request);
  const end = vi.spyOn(response, "end").mockReturnValue(response);
  health(request, response);
  const body: unknown = end.mock.calls[0]?.[0];
  return { response, body };
}

describe("deployment health shell", () => {
  it("returns only the fixed public liveness response without runtime configuration", () => {
    const { response, body } = invoke("GET");
    expect(response.statusCode).toBe(200);
    expect(body).toBe('{"status":"ok","service":"payflow"}');
    expect(response.getHeader("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.getHeader("Cache-Control")).toBe("no-store");
  });
  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])(
    "rejects %s without mutation",
    (method) => {
      const { response, body } = invoke(method);
      expect(response.statusCode).toBe(405);
      expect(response.getHeader("Allow")).toBe("GET");
      expect(body).toBe('{"error":"method_not_allowed"}');
    },
  );
  it("has no runtime imports or environment/provider/network dependencies", () => {
    const source = readFileSync(
      new URL("../api/health.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/^import .*$/gm)).toEqual([
      'import type { IncomingMessage, ServerResponse } from "node:http";',
    ]);
    expect(source).not.toMatch(
      /process\.|fetch\(|require\(|import\(|console\./,
    );
  });
  it("publishes only the empty static directory, never compiled domain modules", () => {
    const config: unknown = JSON.parse(
      readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
    );
    expect(config).toEqual({
      $schema: "https://openapi.vercel.sh/vercel.json",
      framework: null,
      buildCommand: "npm run typecheck && npm run build",
      outputDirectory: "public",
    });
  });
});
