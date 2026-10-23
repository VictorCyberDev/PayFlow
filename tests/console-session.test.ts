import { describe, it, expect } from "vitest";
import {
  ConsoleSessions,
  type ConsoleRequest,
} from "../src/console-session.js";
import {
  HumanConfirmationBoundary,
  type HumanActionBinding,
} from "../src/intent-activation.js";
const origin = "http://127.0.0.1:8080",
  bootstrap = "test-only-".repeat(8);
function setup(https = false) {
  let now = new Date("2026-10-23T10:00:00.000Z");
  const o = https ? "https://payflow.example" : origin;
  const s = new ConsoleSessions(
    { principalId: "owner", origin: o, bootstrapKey: bootstrap },
    () => now,
  );
  const meta: ConsoleRequest = { host: new URL(o).host, origin: o };
  const login = s.login(meta, { bootstrapCode: bootstrap });
  const req = {
    ...meta,
    cookie: login.cookie.split(";")[0],
    csrf: login.view.csrfToken,
  };
  return {
    s,
    req,
    login,
    clock: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
const binding: HumanActionBinding = {
  action: "CREATE_INTENT_REVIEW",
  agentId: "agent",
};
describe("M5C cryptographic local-demo session and exact host action", () => {
  it("uses HttpOnly/SameSite and server-owned identity with no token in JSON", async () => {
    const f = setup();
    expect(f.login.cookie).toContain("HttpOnly; SameSite=Strict");
    const handle = f.s.read(f.req);
    expect(await f.s.requirePrincipal(handle)).toBe("owner");
    expect(JSON.stringify(f.login.view)).not.toContain(
      f.req.cookie!.split("=")[1],
    );
    expect(JSON.stringify(handle)).not.toContain("owner");
  });
  it("uses Secure and __Host cookie for HTTPS audiences", () => {
    const f = setup(true);
    expect(f.login.cookie).toMatch(/^__Host-payflow_session=/);
    expect(f.login.cookie).toContain("; Secure");
  });
  it.each([
    { bootstrapCode: bootstrap, principalId: "other" },
    { bootstrapCode: "wrong" },
    { principalId: "owner" },
  ])("bootstrap cannot select a principal or bypass credential: %j", (raw) => {
    const s = new ConsoleSessions({
      principalId: "owner",
      origin,
      bootstrapKey: bootstrap,
    });
    expect(() => s.login({ host: "127.0.0.1:8080", origin }, raw)).toThrow();
  });
  it.each([
    "payflow_session=unsigned",
    "payflow_session=" + "a".repeat(43),
    "",
    "payflow_session=x; payflow_session=y",
  ])("rejects unrecognized/tampered/duplicate cookie", (cookie) => {
    const f = setup();
    expect(() => f.s.read({ ...f.req, cookie })).toThrow();
  });
  it("rejects a modified valid random token", () => {
    const f = setup();
    expect(() =>
      f.s.read({ ...f.req, cookie: f.req.cookie!.slice(0, -1) + "x" }),
    ).toThrow();
  });
  it("session expiry rejects both cookie and previously sealed context", () => {
    const f = setup(),
      h = f.s.read(f.req);
    f.advance(900000);
    expect(() => f.s.read(f.req)).toThrow();
    expect(() => f.s.requirePrincipal(h)).toThrow();
  });
  it.each([
    { origin: "https://attacker.invalid" },
    { origin: undefined },
    { host: "other.example" },
    { csrf: "wrong" },
    { csrf: undefined },
  ])("rejects origin/audience/CSRF mutation %j", (patch) => {
    const f = setup();
    expect(() => f.s.mutation({ ...f.req, ...patch })).toThrow();
  });
  it("requires a one-time sealed action, exact binding and live session", async () => {
    const f = setup(),
      b = new HumanConfirmationBoundary(f.s, f.clock),
      proof = f.s.seal(f.req, binding);
    const h = await b.authenticate(proof, binding);
    expect(b.require(h, binding).identity.principalId).toBe("owner");
    await expect(b.authenticate(proof, binding)).rejects.toThrow();
    await expect(
      b.authenticate({ principalId: "owner", binding }, binding),
    ).rejects.toThrow();
  });
  it("rejects cloned proof, swapped agent/binding and payment actions", () => {
    const f = setup();
    const proof = f.s.seal(f.req, binding);
    expect(() => f.s.verify({ ...proof }, binding)).toThrow();
    expect(() => f.s.verify(proof, { ...binding, agentId: "wrong" })).toThrow();
    expect(() =>
      f.s.seal(f.req, { action: "RESUME_PAYMENT", agentId: "agent" }),
    ).toThrow();
  });
  it("sealed action expires and logout blocks pending action and reads", () => {
    const f = setup(),
      proof = f.s.seal(f.req, binding);
    f.advance(60000);
    expect(() => f.s.verify(proof, binding)).toThrow();
    const next = f.s.seal(f.req, binding);
    expect(f.s.logout(f.req)).toContain("Max-Age=0");
    expect(() => f.s.verify(next, binding)).toThrow();
    expect(() => f.s.read(f.req)).toThrow();
  });
  it("bounds bootstrap guessing and refuses unsafe origins/config", () => {
    const s = new ConsoleSessions({
      principalId: "owner",
      origin,
      bootstrapKey: bootstrap,
    });
    for (let i = 0; i < 5; i++)
      expect(() =>
        s.login({ host: "127.0.0.1:8080", origin }, { bootstrapCode: "bad" }),
      ).toThrow();
    expect(() =>
      s.login({ host: "127.0.0.1:8080", origin }, { bootstrapCode: bootstrap }),
    ).toThrow();
    expect(
      () =>
        new ConsoleSessions({
          principalId: "owner",
          origin: "http://public.example",
          bootstrapKey: bootstrap,
        }),
    ).toThrow();
    expect(
      () =>
        new ConsoleSessions({
          principalId: "owner",
          origin,
          bootstrapKey: "short",
        }),
    ).toThrow();
  });
  it("bounds authenticated mutation traffic without exposing session credentials", () => {
    const f = setup();
    for (let i = 0; i < 30; i++) f.s.mutation(f.req, true);
    expect(() => f.s.mutation(f.req, true)).toThrow();
    f.advance(60000);
    expect(() => f.s.mutation(f.req, true)).not.toThrow();
  });
});
