import test from "node:test";
import assert from "node:assert/strict";
import {
  exactUtc,
  formatMoney,
  greeting,
  humanRemaining,
  humanWhen,
  updatedAgo,
} from "../lib/present";

const TZ = "America/New_York";
// Friday 2026-10-23 6:00 PM in New York.
const NOW = new Date("2026-10-23T22:00:00.000Z");

test("money drops whole cents, keeps real ones and never invents precision", () => {
  assert.equal(formatMoney(8400, "USD"), "$84");
  assert.equal(formatMoney(8450, "USD"), "$84.50");
  assert.equal(formatMoney(0, "USD"), "$0");
  assert.equal(formatMoney(1234, "JPY"), "¥1,234");
  assert.equal(formatMoney(null, "USD"), "Not established");
});

test("human time: today, tomorrow, weekday, date", () => {
  assert.equal(
    humanWhen("2026-10-23T19:42:00.000Z", NOW, TZ),
    "Today at 3:42 PM",
  );
  assert.equal(
    humanWhen("2026-10-24T22:00:00.000Z", NOW, TZ),
    "Tomorrow at 6:00 PM",
  );
  assert.equal(
    humanWhen("2026-10-22T20:00:00.000Z", NOW, TZ),
    "Yesterday at 4:00 PM",
  );
  assert.equal(
    humanWhen("2026-10-27T22:00:00.000Z", NOW, TZ),
    "Tuesday at 6:00 PM",
  );
  assert.equal(
    humanWhen("2026-10-30T22:00:00.000Z", NOW, TZ),
    "Oct 30 at 6:00 PM",
  );
  assert.equal(
    humanWhen("2027-01-05T22:00:00.000Z", NOW, TZ),
    "Jan 5, 2027 at 5:00 PM",
  );
  assert.equal(humanWhen("not a date", NOW, TZ), "Unknown time");
});

test("human time never leaks machine formats", () => {
  for (const iso of ["2026-10-23T19:42:00.000Z", "2026-10-30T22:00:00.000Z"])
    assert.doesNotMatch(humanWhen(iso, NOW, TZ), /GMT|UTC|T\d\d:|Z$/);
});

test("remaining and updated phrasing", () => {
  assert.equal(
    humanRemaining("2026-10-25T22:00:00.000Z", NOW),
    "2 days remaining",
  );
  assert.equal(
    humanRemaining("2026-10-24T01:00:00.000Z", NOW),
    "3 hours remaining",
  );
  assert.equal(
    humanRemaining("2026-10-23T22:45:00.000Z", NOW),
    "45 minutes remaining",
  );
  assert.equal(
    humanRemaining("2026-10-23T22:00:20.000Z", NOW),
    "Less than a minute remaining",
  );
  assert.equal(humanRemaining("2026-10-23T21:59:00.000Z", NOW), "Expired");
  assert.equal(updatedAgo("2026-10-23T21:59:50.000Z", NOW), "Updated just now");
  assert.equal(
    updatedAgo("2026-10-23T21:58:00.000Z", NOW),
    "Updated 2 minutes ago",
  );
});

test("exact UTC is reserved for Proof and is unambiguous", () => {
  assert.equal(exactUtc("2026-10-23T22:00:00Z"), "2026-10-23T22:00:00.000Z");
  assert.equal(exactUtc("junk"), "unknown");
});

test("greeting follows the viewer's local hour", () => {
  assert.equal(greeting(new Date("2026-10-23T13:00:00Z"), TZ), "Good morning");
  assert.equal(
    greeting(new Date("2026-10-23T17:00:00Z"), TZ),
    "Good afternoon",
  );
  assert.equal(greeting(new Date("2026-10-23T23:30:00Z"), TZ), "Good evening");
});
