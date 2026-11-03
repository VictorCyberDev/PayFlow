import type { Sql } from "postgres";

/**
 * Test helper: mints a real OWNER member through the platform-operator bootstrap, the same path a
 * deployment uses. The platform operator token holds no organization role, so every test that
 * issues credentials or reads organization views does so as a member, not as the operator.
 */
export function ownerFactory(
  origin: () => string,
  sql: () => Sql,
  operatorToken: string,
  organizationId = "payflow-sandbox",
) {
  let cached: string | null = null;
  return {
    reset(): void {
      cached = null;
    },
    async token(): Promise<string> {
      if (cached) return cached;
      await sql()`insert into organizations (id, display_name) values (${organizationId}, 'Test') on conflict (id) do nothing`;
      const res = await fetch(origin() + "/v1/admin/members", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${operatorToken}`,
        },
        body: JSON.stringify({
          organizationId,
          environment: "SANDBOX",
          displayName: "Test owner",
          role: "OWNER",
        }),
      });
      const body = (await res.json()) as { token?: string };
      if (res.status !== 201 || !body.token)
        throw new Error(`owner bootstrap failed: ${res.status}`);
      return (cached = body.token);
    },
  };
}
