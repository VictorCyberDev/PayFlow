import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pendingMigrations } from "../src/ops/migration-plan.js";

describe("public migration plan", () => {
  const files = readdirSync("db/migrations");
  const plan = pendingMigrations(files);
  it("starts after 023, skips 028, is ordered and gap-free otherwise, and covers everything to the newest file", () => {
    const nums = plan.map((f) => Number(f.slice(0, 3)));
    expect(nums[0]).toBe(24);
    expect(nums).not.toContain(28);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    const newest = Math.max(...files.map((f) => Number(f.slice(0, 3))));
    expect(nums.at(-1)).toBe(newest);
    const expected = Array.from(
      { length: newest - 23 },
      (_v, i) => i + 24,
    ).filter((n) => n !== 28);
    expect(nums).toEqual(expected);
  });
  it("applies cleanly, in that order, on a fresh database that has first been brought to 023 (an upgrade, not just a fresh install)", () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) return;
    const base = url.replace(/\/[^/]*$/u, "");
    const db = "migplan_" + Math.random().toString(36).slice(2, 8);
    const sh = (u: string, f: string) =>
      execFileSync("psql", [u, "-q", "-v", "ON_ERROR_STOP=1", "-f", f], {
        stdio: "pipe",
      });
    execFileSync("psql", [url, "-qc", `create database ${db}`], {
      stdio: "pipe",
    });
    try {
      const target = `${base}/${db}`;
      for (const f of files
        .filter((x) => /^\d{3}_/u.test(x))
        .sort()
        .filter((x) => Number(x.slice(0, 3)) <= 23))
        sh(target, `db/migrations/${f}`);
      for (const f of plan) sh(target, `db/migrations/${f}`);
      const n = execFileSync(
        "psql",
        [
          target,
          "-Atc",
          "select count(*) from information_schema.tables where table_schema='public'",
        ],
        { stdio: "pipe" },
      )
        .toString()
        .trim();
      expect(Number(n)).toBeGreaterThan(130);
    } finally {
      execFileSync("psql", [url, "-qc", `drop database if exists ${db}`], {
        stdio: "pipe",
      });
    }
  }, 120_000);
});
