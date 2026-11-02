import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

type VercelConfig = {
  headers?: Array<{
    source?: string;
    headers?: Array<{ key?: string; value?: string }>;
  }>;
};

const staticCorsOrigin = async (path: string): Promise<string | undefined> => {
  const config = JSON.parse(await readFile(path, "utf8")) as VercelConfig;
  return config.headers
    ?.flatMap((rule) => rule.headers ?? [])
    .find((header) => header.key === "Access-Control-Allow-Origin")?.value;
};

describe("isolated M5/M6 Vercel acceptance boundaries", () => {
  it("keeps the historical M5 host bound to the M5 acceptance origin", async () => {
    expect(await staticCorsOrigin("hosting/m5/vercel.json")).toBe(
      "https://payflow-m5-acceptance.vercel.app",
    );
  });

  it("binds the M6 host to the separate M6 acceptance origin", async () => {
    expect(await staticCorsOrigin("hosting/m6/vercel.json")).toBe(
      "https://payflow-m6-acceptance.vercel.app",
    );
  });

  it("keeps M6 hosting in a separate package rather than repurposing M5", async () => {
    const m5 = JSON.parse(
      await readFile("hosting/m5/package.json", "utf8"),
    ) as { name: string };
    const m6 = JSON.parse(
      await readFile("hosting/m6/package.json", "utf8"),
    ) as { name: string };
    expect(m5.name).toBe("@payflow/m5-host");
    expect(m6.name).toBe("@payflow/m6-host");
  });
});
