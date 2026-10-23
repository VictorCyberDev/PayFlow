import { describe, it, expect } from "vitest";
import {
  AuthorityViewService,
  AuthorityProjectionSchema,
} from "../src/authority-projection.js";
const snapshot = () => ({
  version: "payflow.authority-view.v1",
  mandateId: "mandate-a",
  principalId: "owner-a",
  agent: { id: "agent-a", displayName: "Shopping Agent", status: "ACTIVE" },
  purpose: "Keyboard purchase",
  currency: "USD",
  singleMaximumMinor: 10000,
  cumulativeLimitMinor: 10000,
  committedMinor: 8400,
  reservedMinor: 0,
  remainingMinor: 1600,
  quantityLimit: 1,
  quantityRemaining: 0,
  merchantScopeSummary: "Approved merchants only",
  allowedConditions: ["NEW"],
  allowedCapabilities: ["CAPTURE_PAYMENT"],
  autonomousThresholdMinor: 10000,
  humanApprovalThresholdMinor: 10000,
  createdAt: "2026-10-22T09:00:00.000Z",
  expiresAt: "2026-10-23T09:00:00.000Z",
  observedAt: "2026-10-22T10:00:00.000Z",
  state: "ACTIVE",
  freshDispatchBlocked: null,
});
function service(raw: unknown, principal = "owner-a") {
  return new AuthorityViewService(
    {
      requirePrincipal: async (context) => {
        await Promise.resolve();
        if (context !== "trusted-session") throw new Error("unauthenticated");
        return principal;
      },
    },
    { readOwned: () => Promise.resolve(raw) },
  );
}
const query = { mandateId: "mandate-a" };
describe("M5A owner-bound read contract (test-only host and store)", () => {
  it("returns a bounded display view and detached values", async () => {
    const raw = snapshot();
    const view = await service(raw).read("trusted-session", query);
    expect(view?.remainingMinor).toBe(1600);
    raw.agent.displayName = "changed";
    expect(view?.agent.displayName).toBe("Shopping Agent");
  });
  it.each([
    null,
    {},
    { ...snapshot(), remainingMinor: -1 },
    { ...snapshot(), currency: "bad" },
    { ...snapshot(), purpose: "x".repeat(501) },
    { ...snapshot(), reservedMinor: 1000 },
  ])("fails closed on malformed/inconsistent store material", async (raw) => {
    expect(await service(raw).read("trusted-session", query)).toBeNull();
  });
  it.each([
    "remainingMinor",
    "state",
    "principalId",
    "agent",
    "freshDispatchBlocked",
  ])("rejects client-supplied %s", async (field) => {
    expect(
      await service(snapshot()).read("trusted-session", {
        ...query,
        [field]: field === "state" ? "ACTIVE" : 999999,
      }),
    ).toBeNull();
  });
  it.each(["REVOKED", "EXPIRED", "UNAVAILABLE"])(
    "client ACTIVE cannot replace durable %s",
    async (state) => {
      const raw = { ...snapshot(), state, freshDispatchBlocked: true };
      const s = service(raw);
      expect((await s.read("trusted-session", query))?.state).toBe(state);
      expect(
        await s.read("trusted-session", { ...query, state: "ACTIVE" }),
      ).toBeNull();
    },
  );
  it.each(["owner-b", ""])(
    "does not project another owner: %s",
    async (owner) => {
      expect(
        await service(snapshot(), owner).read("trusted-session", query),
      ).toBeNull();
    },
  );
  it("rejects swapped mandate binding", async () => {
    expect(
      await service({ ...snapshot(), mandateId: "other" }).read(
        "trusted-session",
        query,
      ),
    ).toBeNull();
  });
  it("rejects unauthenticated browser contexts", async () => {
    expect(
      await service(snapshot()).read({ principalId: "owner-a" }, query),
    ).toBeNull();
  });
  it.each([
    "DATABASE_URL",
    "PAYFLOW_STATUS_DATABASE_URL",
    "privateKey",
    "signedToken",
    "resumeSecret",
    "assertion",
    "paypalOAuthToken",
    "providerResponse",
  ])("excludes unexpected secret field %s", async (key) => {
    const raw = { ...snapshot(), [key]: "secret" };
    expect(AuthorityProjectionSchema.safeParse(raw).success).toBe(false);
    expect(await service(raw).read("trusted-session", query)).toBeNull();
  });
  it("rejects nested secret fields", async () => {
    expect(
      await service({
        ...snapshot(),
        agent: { ...snapshot().agent, resumeSecret: "secret" },
      }).read("trusted-session", query),
    ).toBeNull();
  });
  it("rejects stale active and unavailable unblocked state", () => {
    expect(
      AuthorityProjectionSchema.safeParse({
        ...snapshot(),
        observedAt: "2026-10-24T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      AuthorityProjectionSchema.safeParse({
        ...snapshot(),
        state: "REVOKED",
        freshDispatchBlocked: false,
      }).success,
    ).toBe(false);
  });
  it("passes verified host owner and requested ID only to read port", async () => {
    let args: unknown;
    const s = new AuthorityViewService(
      { requirePrincipal: () => Promise.resolve("owner-a") },
      {
        readOwned: async (...values) => {
          await Promise.resolve();
          args = values;
          return snapshot();
        },
      },
    );
    await s.read({}, query);
    expect(args).toEqual(["owner-a", "mandate-a"]);
  });
  it("store failure stays unavailable", async () => {
    const s = new AuthorityViewService(
      { requirePrincipal: () => Promise.resolve("owner-a") },
      {
        readOwned: async () => {
          await Promise.resolve();
          throw new Error("private database error");
        },
      },
    );
    expect(await s.read({}, query)).toBeNull();
  });
});
