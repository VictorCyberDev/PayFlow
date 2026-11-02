import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { DurableConsoleSessions } from "../src/console-session-durable.js";
import { parseHostedConfig } from "../src/console-hosted.js";

const bootstrap = "m6-crypto-root-".repeat(4);
const accessCode = "m6-demo-access-2026-10-28";
const origin = "https://payflow-m6-acceptance.vercel.app";

const fakeSql = () => {
  let attempts = 0;
  return ((strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("update console_demo_login_window"))
      return Promise.resolve([{ attempts: ++attempts }]);
    if (query.includes("delete from console_demo_sessions"))
      return Promise.resolve([]);
    if (query.includes("insert into console_demo_sessions"))
      return Promise.resolve([{ session_hash: "inserted" }]);
    throw new Error("UNEXPECTED_TEST_QUERY");
  }) as unknown as Sql;
};

const request = {
  origin,
  host: "payflow-m6-acceptance.vercel.app",
};

describe("hosted demo access-code separation", () => {
  it("uses the dedicated access code for login while keeping the bootstrap root private", async () => {
    const sessions = new DurableConsoleSessions(
      fakeSql(),
      {
        principalId: "m6-demo-owner",
        origin,
        bootstrapKey: bootstrap,
        accessCode,
      },
      () => new Date("2026-10-28T10:00:00.000Z"),
    );

    await expect(
      sessions.login(request, { bootstrapCode: bootstrap }),
    ).rejects.toThrow("SESSION_REQUIRED");

    const login = await sessions.login(request, { bootstrapCode: accessCode });
    expect(login.view.authenticated).toBe(true);
    expect(login.view.mode).toBe("NON_PRODUCTION_DEMO");
  });

  it("preserves historical M5 login behavior when no dedicated access code is configured", async () => {
    const sessions = new DurableConsoleSessions(
      fakeSql(),
      {
        principalId: "m5-demo-owner",
        origin,
        bootstrapKey: bootstrap,
      },
      () => new Date("2026-10-28T10:00:00.000Z"),
    );

    const login = await sessions.login(request, { bootstrapCode: bootstrap });
    expect(login.view.authenticated).toBe(true);
  });

  it("parses the access code independently from the cryptographic bootstrap root", () => {
    const config = parseHostedConfig({
      PAYFLOW_M5_DEMO: "true",
      DATABASE_URL: "postgres://example.invalid/payflow",
      PAYFLOW_M5_PRINCIPAL_ID: "m6-demo-owner",
      PAYFLOW_M5_AGENT_ID: "m6-shopping-agent",
      PAYFLOW_M5_BOOTSTRAP_KEY: bootstrap,
      PAYFLOW_DEMO_ACCESS_CODE: accessCode,
      PAYFLOW_M5_ORIGIN: origin,
    });

    expect(config.PAYFLOW_M5_BOOTSTRAP_KEY).toBe(bootstrap);
    expect(config.PAYFLOW_DEMO_ACCESS_CODE).toBe(accessCode);
  });
});
