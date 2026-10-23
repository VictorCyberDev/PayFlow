// X6: the information architecture and components must carry M6–M9 without redesign.
// These are PRESENTATION fixtures rendered with the production components; they make no claim
// that M7–M9 exist.
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityRow, FlowTrace, OutcomeHero } from "../app/ui/activity";
import { AgentIdentity } from "../app/ui/frame";
import { ActivityProof } from "../app/ui/proof";
import { activityOutcome } from "../lib/language";
import { NOW, paid, blocked } from "../qa/fixtures";

const html = (n: React.ReactNode) => renderToStaticMarkup(n as never);

test("M6 valid delegated purchase: $84 paid once, Flow resolves through the Gate", () => {
  const out = html(
    <>
      <OutcomeHero x={paid} />
      <FlowTrace x={paid} />
    </>,
  );
  assert.match(out, /\$84 paid once/);
  assert.match(out, /trace__step--done/);
  assert.doesNotMatch(out, /trace__step--stopped|unconfirmed/);
});

test("M6 price drift: $184 against a $100 maximum is $0 moved and the Flow stops at the Gate", () => {
  const out = html(
    <>
      <OutcomeHero x={blocked} />
      <FlowTrace x={blocked} />
    </>,
  );
  assert.match(out, /\$0 moved/);
  assert.match(out, /Requested \$184/);
  assert.match(out, /trace__step--stopped/);
  assert.match(out, /trace__step--none/);
});

test("M7 external agent: identity gains a tag; protocol vocabulary stays in Proof", () => {
  const external = { ...paid, agentName: "Acme Concierge" };
  const row = html(
    <ul>
      <ActivityRow x={external} now={NOW} href="/activity/?id=1" />
    </ul>,
  );
  assert.match(row, /Acme Concierge/);
  assert.doesNotMatch(row, /OAuth|MCP|scope/);
  assert.match(
    html(<AgentIdentity name="Acme Concierge" extra="External agent" />),
    /External agent/,
  );
  const proof = html(
    <ActivityProof
      x={{
        ...external,
        stages: [
          ...paid.stages,
          {
            stage: "AGENT_IDENTITY",
            status: "VERIFIED",
            reasonCode: "OAUTH_SCOPE_PAYFLOW_SPEND",
          },
        ],
      }}
    />,
  );
  assert.match(proof, /OAUTH_SCOPE_PAYFLOW_SPEND/);
});

test("M8 read-only verification: shown as Proof detail, never as a money-moving control", () => {
  const proof = html(
    <ActivityProof
      x={{
        ...paid,
        stages: [
          ...paid.stages,
          {
            stage: "EXTERNAL_VERIFICATION",
            status: "VERIFIED",
            reasonCode: "READ_ONLY_VERIFIER_CONFIRMED",
          },
        ],
      }}
    />,
  );
  assert.match(proof, /READ_ONLY_VERIFIER_CONFIRMED/);
  assert.doesNotMatch(proof, /<button|Revoke|Confirm/);
});

test("M9 Break PayFlow: an attack row leads with '$0 moved' and the barred glyph", () => {
  const attack = {
    ...blocked,
    operationId: "atk",
    item: "Injected $9,999 transfer",
    amountMinor: 999900,
    explanation: "The merchant was outside this authority’s approved scope.",
  };
  assert.equal(activityOutcome(attack).headline, "$0 moved");
  const row = html(
    <ul>
      <ActivityRow x={attack} now={NOW} href="/activity/?id=atk" />
    </ul>,
  );
  assert.match(row, /glyph--blocked/);
  assert.match(row, /\$0 moved/);
});
