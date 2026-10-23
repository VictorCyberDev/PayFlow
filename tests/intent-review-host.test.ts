import { it, expect } from "vitest";
import { createReviewDemoHost } from "../src/intent-review-demo-host.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
it("non-production HTTP host compiles review and rejects unsafe transport/authority inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "payflow-review-"));
  await writeFile(join(dir, "index.html"), "<p>Preview only</p>");
  const server = createReviewDemoHost(dir);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const sampleResponse = await fetch(base + "/api/intent-review/sample");
    const sample = (await sampleResponse.json()) as { sample: string };
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + "/api/intent-review", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const review = await post({ source: sample.sample });
    expect(review.status).toBe(200);
    expect(((await review.json()) as { status: string }).status).toBe(
      "VALID_DRAFT",
    );
    expect(
      (await post({ source: sample.sample, principalId: "attacker" })).status,
    ).toBe(400);
    expect(
      (
        await post(
          { source: sample.sample },
          { origin: "https://attacker.invalid" },
        )
      ).status,
    ).toBe(403);
    expect((await fetch(base + "/api/intent-review")).status).toBe(405);
    expect(
      (await fetch(base + "/api/confirm", { method: "POST" })).status,
    ).toBe(405);
    expect((await fetch(base + "/")).status).toBe(200);
    expect((await fetch(base + "/")).status).toBe(200);
    expect((await post({ source: "x".repeat(9000) })).status).toBe(413);
    expect(
      (
        await fetch(base + "/api/intent-review", {
          method: "POST",
          body: "not-json",
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(base + "/api/intent-review", {
          method: "POST",
          body: "text",
        })
      ).status,
    ).toBe(415);
    expect((await fetch(base + "/package.json")).status).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true });
  }
});
