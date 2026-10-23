import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewSurface } from "../app/ask-payflow";
for (const [status, word] of [
  ["EMPTY", "Describe your request"],
  ["INTERPRETING", "Interpreting your request"],
  ["STALE", "Your request changed"],
  ["EXPIRED", "review has expired"],
  ["SAFE_PROVIDER_FAILURE", "Interpretation is unavailable"],
])
  test(`accessible ${status} surface`, () => {
    const html = renderToStaticMarkup(
      <ReviewSurface state={{ status, source: "", review: null }} />,
    );
    assert.match(html, /Not yet authorized/);
    assert.match(html, /aria-live="polite"/);
    assert.ok(html.includes(word));
    assert.doesNotMatch(html, /<button|<form/);
  });
for (const status of ["VALID_DRAFT", "NEEDS_CLARIFICATION", "REJECTED"])
  test(`${status} renders human review without activation`, () => {
    const review = {
      status,
      message:
        status === "REJECTED"
          ? "I can’t turn that into a safe authority yet."
          : "Nothing is authorized yet.",
      question: "Which currency should apply?",
      terms:
        status === "VALID_DRAFT" ? [{ label: "Budget", value: "$100.00" }] : [],
      interpreted: [],
      fingerprint: null,
      reasonCodes: [],
      expiresAt: "2026-10-22T11:00:00.000Z",
    };
    const html = renderToStaticMarkup(
      <ReviewSurface
        state={{ status, source: "<script>unsafe</script>", review }}
      />,
    );
    assert.match(html, /Not yet authorized/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<button|<form|<script>/);
    if (status === "VALID_DRAFT") {
      assert.match(html, /What the AI understood/);
      assert.match(html, /Terms within the demo host/);
      assert.match(html, /\$100.00/);
    }
    if (status === "NEEDS_CLARIFICATION") {
      assert.match(html, /Which currency should apply/);
      assert.doesNotMatch(html, /Maximum total|After future activation/);
    }
    if (status === "REJECTED") assert.match(html, /safe authority yet/);
  });
