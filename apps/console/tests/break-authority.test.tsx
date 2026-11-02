import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import BreakAuthorityPage from "../app/research/break-authority/page";
import { breakAuthority, categoryLabel } from "../lib/break-authority";

const html = renderToStaticMarkup(<BreakAuthorityPage />);
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the console copy is byte-identical to the CI-verified evidence file", () => {
  assert.equal(
    readFileSync(
      new URL("../lib/break-authority-summary.json", import.meta.url),
      "utf8",
    ),
    readFileSync(
      new URL(
        "../../../docs/evidence/break-authority-summary.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});

test("the page shows the generated numbers, not typed ones", () => {
  const i = breakAuthority.integrated;
  assert.match(
    text,
    new RegExp(`${i.scenarios.toLocaleString("en-US")} adversarial scenarios`),
  );
  assert.match(text, new RegExp(`${i.uncontained} uncontained`));
  assert.match(text, new RegExp(`${i.attackFamilies} attack families`));
  assert.match(
    text,
    new RegExp(
      `${i.distinctContainmentOutcomes} distinct containment outcomes`,
    ),
  );
  for (const c of i.categories)
    assert.ok(text.includes(categoryLabel(c.category)), c.category);
});

test("the page states its scope and limits plainly", () => {
  assert.match(text, /fake rail/);
  assert.match(text, /No real money moved/);
  assert.match(text, /No live model was run/);
  assert.match(text, /not 1,000 independent ideas/);
  assert.match(text, /not a penetration test or a certification/);
  assert.match(text, /No independent party has reproduced it/);
});

test("the page makes no unearned claim", () => {
  for (const word of [
    /unbreakable/i,
    /\bcertified\b/i,
    /guarantee/i,
    /audited by/i,
    /zero risk/i,
    /100% secure/i,
  ])
    assert.doesNotMatch(text, word);
});

test("the structure is accessible: caption, column and row headers, labelled sections", () => {
  assert.match(html, /<caption>/);
  assert.match(html, /scope="col"/);
  assert.match(html, /scope="row"/);
  assert.equal((html.match(/aria-labelledby="/g) ?? []).length >= 6, true);
});

test("every committed report digest is a real SHA-256", () => {
  for (const [name, digest] of Object.entries(breakAuthority.sourceFileSha256))
    assert.match(digest, /^[a-f0-9]{64}$/, name);
  assert.ok(Object.keys(breakAuthority.sourceFileSha256).length >= 6);
});

test("scope flags in the data cannot be flipped to an overclaim without failing here", () => {
  assert.equal(breakAuthority.scope.providerEffectsExercised, false);
  assert.equal(breakAuthority.scope.realModelRun, false);
  assert.equal(breakAuthority.scope.independentReproduction, false);
  assert.equal(breakAuthority.scope.certificationClaim, false);
});
