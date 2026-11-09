import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resendEmailChannel } from "../src/missions/channel-resend.js";
import { DefinitiveSendError } from "../src/missions/channels.js";

/**
 * R2 — the Resend adapter against a local server that reproduces Resend's documented request shape (POST /emails, Bearer key,
 * Idempotency-Key header, `{id}` reply) and error classes. This proves the adapter's request and its definitive-versus-unknown
 * classification. It does NOT prove anything about Resend itself: no request in this file leaves the machine.
 */
const KEY = "re_TestKey_1234567890";
const msg = {
  to: "supplier@example.com",
  subject: "Quote request",
  body: "Please quote 2 keyboards.",
  idempotencyKey: "msg_0123456789abcdef",
};
let server: Server;
let base = "";
let mode: {
  status: number;
  body?: string;
  hang?: boolean;
  location?: string;
  big?: boolean;
} = { status: 200, body: '{"id":"49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"}' };
let seen: {
  url: string | undefined;
  method: string | undefined;
  headers: Record<string, unknown>;
  body: unknown;
}[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
      });
      if (mode.hang) return; // never answer
      res.writeHead(mode.status, {
        "content-type": "application/json",
        ...(mode.location ? { location: mode.location } : {}),
      });
      res.end(mode.big ? "x".repeat(40_000) : (mode.body ?? ""));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
const channel = () =>
  resendEmailChannel({
    apiKey: KEY,
    from: "PayFlow <notices@example.com>",
    baseUrl: base,
  });
const send = (m = msg, ms = 2_000) =>
  channel().send(m, AbortSignal.timeout(ms));

describe("R2 Resend channel adapter (contract, local server)", () => {
  it("sends one documented request and returns the provider's id as the reference", async () => {
    seen = [];
    mode = {
      status: 200,
      body: '{"id":"49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"}',
    };
    expect(await send()).toEqual({
      ref: "resend:49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: "/emails",
      method: "POST",
      body: {
        from: "PayFlow <notices@example.com>",
        to: ["supplier@example.com"],
        subject: "Quote request",
        text: "Please quote 2 keyboards.",
      },
    });
    expect(seen[0]!.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.headers["idempotency-key"]).toBe(msg.idempotencyKey);
  });

  it("a refusal before sending is DEFINITIVE; anything that may have sent is UNKNOWN", async () => {
    for (const status of [400, 401, 403, 404, 422, 429]) {
      seen = [];
      mode = { status, body: '{"name":"validation_error","message":"nope"}' };
      const e = await send().catch((x: unknown) => x);
      expect(e, String(status)).toBeInstanceOf(DefinitiveSendError);
    }
    for (const status of [409, 500, 502, 503, 504, 301, 302, 204]) {
      mode = {
        status,
        body: "",
        ...(status === 301 || status === 302
          ? { location: "https://elsewhere.example/emails" }
          : {}),
      };
      seen = [];
      const e = await send().catch((x: unknown) => x);
      expect(e, String(status)).toBeInstanceOf(Error);
      expect(e, String(status)).not.toBeInstanceOf(DefinitiveSendError);
      expect(seen, "a redirect is never followed").toHaveLength(1);
    }
  });

  it("an unreadable, oversized or id-less 2xx reply is UNKNOWN (the message may have gone), never success and never failed", async () => {
    for (const m of [
      { status: 200, body: "not json" },
      { status: 200, body: "{}" },
      { status: 200, body: '{"id":"x"}' },
      { status: 200, big: true },
    ]) {
      mode = m;
      const e = await send().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(DefinitiveSendError);
    }
  });

  it("a timeout or a dropped connection is UNKNOWN and its message never contains the API key", async () => {
    mode = { status: 200, hang: true };
    const timeout = await send(msg, 150).catch((x: unknown) => x);
    expect(timeout).toBeInstanceOf(Error);
    expect(timeout).not.toBeInstanceOf(DefinitiveSendError);
    const dead = resendEmailChannel({
      apiKey: KEY,
      from: "PayFlow <notices@example.com>",
      baseUrl: "http://127.0.0.1:1",
    });
    const refused = await dead
      .send(msg, AbortSignal.timeout(2_000))
      .catch((x: unknown) => x);
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(DefinitiveSendError);
    expect(JSON.stringify([String(timeout), String(refused)])).not.toContain(
      KEY,
    );
  });

  it("malformed messages are refused DEFINITIVELY before anything leaves (no header injection)", async () => {
    seen = [];
    mode = {
      status: 200,
      body: '{"id":"49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"}',
    };
    for (const bad of [
      { ...msg, to: "a@b.c, d@e.f" },
      { ...msg, to: "no-at-sign" },
      { ...msg, subject: "hi\r\nBcc: x@y.z" },
      { ...msg, subject: "" },
      { ...msg, body: "" },
      { ...msg, idempotencyKey: "short" },
    ])
      expect(await send(bad).catch((x: unknown) => x)).toBeInstanceOf(
        DefinitiveSendError,
      );
    expect(seen).toHaveLength(0);
  });

  it("refuses unsafe configuration at construction", () => {
    expect(() => resendEmailChannel({ apiKey: "nope", from: "a@b.c" })).toThrow(
      "RESEND_API_KEY_INVALID",
    );
    expect(() =>
      resendEmailChannel({ apiKey: KEY, from: "a@b.c\r\nBcc: x" }),
    ).toThrow("RESEND_FROM_INVALID");
    expect(() =>
      resendEmailChannel({
        apiKey: KEY,
        from: "a@b.c",
        baseUrl: "http://api.resend.com",
      }),
    ).toThrow("RESEND_BASE_URL_MUST_BE_HTTPS");
    expect(resendEmailChannel({ apiKey: KEY, from: "a@b.c" })).toMatchObject({
      mode: "LIVE",
      channel: "EMAIL",
    });
  });
});
