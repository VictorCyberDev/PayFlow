import { mock } from "node:test";

// Test-process preload only. Production entry points never import this helper.
// Keep fixture expiry meaningful without making the test depend on the wall clock.
const now = Date.parse(
  process.env.PAYFLOW_TEST_CLOCK_NOW ?? "2026-10-28T03:00:00.000Z",
);
if (!Number.isFinite(now)) throw new Error("INVALID_TEST_CLOCK");
mock.timers.enable({ apis: ["Date"], now });
