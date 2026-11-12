import { describe, expect, it } from "vitest";
import {
  assertDisposableDatabase,
  assertScratchName,
} from "../scripts/lib/disposable-db.mjs";

const ON = { PAYFLOW_ALLOW_DESTRUCTIVE_TEST_DB: "1" };
const LOCAL = "postgres://payflow:payflow_test@localhost:5432/payflow_test";

describe("destructive test-database guard", () => {
  it("accepts a local test database with the explicit opt-in", () => {
    expect(assertDisposableDatabase(LOCAL, ON)).toEqual({
      host: "localhost",
      database: "payflow_test",
    });
    expect(
      assertDisposableDatabase("postgres://u:p@127.0.0.1/payflow_test", ON)
        .host,
    ).toBe("127.0.0.1");
    expect(
      assertDisposableDatabase("postgres://u:p@[::1]/scratch", ON).host,
    ).toBe("::1");
  });
  it("refuses without the opt-in, even for a local test database", () => {
    expect(() => assertDisposableDatabase(LOCAL, {})).toThrow(/REFUSED/u);
    expect(() =>
      assertDisposableDatabase(LOCAL, {
        PAYFLOW_ALLOW_DESTRUCTIVE_TEST_DB: "true",
      }),
    ).toThrow(/REFUSED/u);
  });
  it("refuses remote and production-looking targets", () => {
    for (const u of [
      "postgres://u:p@ep-cool-123.us-east-2.aws.neon.tech/payflow_test",
      "postgres://u:p@db.internal:5432/payflow_test",
      "postgres://u:p@10.0.0.5/payflow_test",
      "postgres://u:p@localhost.evil.example/payflow_test",
      "postgres://u:p@localhost/neondb",
      "postgres://u:p@localhost/payflow",
      "postgres://u:p@localhost/payflow_test?host=ep-x.neon.tech",
      "postgres://u:p@localhost/payflow_test?hostaddr=203.0.113.9",
      "https://localhost/payflow_test",
      "not a url",
    ])
      expect(() => assertDisposableDatabase(u, ON), u).toThrow(/REFUSED/u);
  });
  it("only creates or drops this repository's own scratch names", () => {
    for (const ok of ["b1b2_acceptance", "journey_acceptance", "fp_abc123"])
      expect(assertScratchName(ok)).toBe(ok);
    for (const bad of [
      "payflow_test",
      "payflow",
      "neondb",
      "postgres",
      "fp_",
      "x; drop",
    ])
      expect(() => assertScratchName(bad)).toThrow(/REFUSED/u);
  });
});
