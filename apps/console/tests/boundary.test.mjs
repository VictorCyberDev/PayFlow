import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const page =
  readFileSync(new URL("app/page.tsx", root), "utf8") +
  readFileSync(new URL("app/ask-payflow.tsx", root), "utf8");
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}
test("browser graph contains no execution, persistence, credentials or unrestricted dispatch", () => {
  for (const f of [
    ...files(fileURLToPath(new URL("app/", root))),
    ...files(fileURLToPath(new URL("fixtures/", root))),
  ]) {
    const source = readFileSync(f, "utf8");
    assert.doesNotMatch(
      source,
      /DATABASE_URL|PAYFLOW_STATUS_DATABASE_URL|PaymentResumeService|PayPalExecutionRail|process\.env|server action|use server|from ["'][^"']*\/src\//,
    );
  }
});
test("fixtures are explicitly separate from authoritative types", () => {
  const fixture = readFileSync(new URL("fixtures/authority.ts", root), "utf8");
  assert.match(fixture, /NON_AUTHORITATIVE_FIXTURE/);
  assert.doesNotMatch(fixture, /import|AuthorityProjection\s*[=<>:]/);
  assert.match(page, /Preview only/);
  assert.match(page, /Not yet authorized/);
  assert.match(page, /Non-production review demo/);
  assert.match(page, /recorded model fixtures/);
});
test("all primary sections have working destinations and disclosure is semantic", () => {
  for (const id of ["home", "ask", "authority", "activity", "agents"])
    assert.match(page, new RegExp(`id="${id}"`));
  assert.match(page, /<summary>View verification details/);
  assert.match(page, /Skip to content/);
  assert.doesNotMatch(
    page,
    /href="#"|confirmReviewedIntent|activateReviewedIntent/,
  );
});

test("browser transport is limited to non-authoritative review endpoints", () => {
  const client = readFileSync(new URL("lib/review-client.mjs", root), "utf8");
  assert.match(client, /fetch\("\/api\/intent-review"/);
  assert.match(page, /fetch\("\/api\/intent-review\/sample"/);
  assert.doesNotMatch(
    page + client,
    /localStorage|sessionStorage|document\.cookie|confirmReviewedIntent|activateReviewedIntent|paypal\.com|api\.groq/,
  );
});
