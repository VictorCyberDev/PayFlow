import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import EnterprisePage from "../app/enterprise/page";

const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const text = decode(renderToStaticMarkup(<EnterprisePage />))
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ");

test("the enterprise page shows the four lenses, labels its data and states what is not built", () => {
  for (const w of [
    "Finance:",
    "Security:",
    "Developer:",
    "Admin:",
    "illustrative",
    "Not deployed",
    "one administrator secret",
  ])
    assert.ok(text.includes(w), w);
  assert.match(text, /If compromised, up to/);
  assert.doesNotMatch(
    text,
    /\b(certified|trusted by|customers include|guarantee)\b/i,
  );
});

test("the agent table has a caption and column and row headers", () => {
  const html = renderToStaticMarkup(<EnterprisePage />);
  assert.match(html, /<caption>/);
  assert.match(html, /scope="col"/);
  assert.match(html, /scope="row"/);
});
