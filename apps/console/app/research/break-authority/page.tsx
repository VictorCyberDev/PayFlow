import type { Metadata } from "next";
import Link from "next/link";
import { GateExample } from "../../ui/company";
import {
  breakAuthority as b,
  categoryLabel,
} from "../../../lib/break-authority";

export const metadata: Metadata = {
  title: "Break Authority — PayFlow",
  description:
    "1,000 adversarial scenarios against PayFlow's production authority modules, with exactly what was and was not tested.",
  alternates: { canonical: "/research/break-authority/" },
};

const nf = new Intl.NumberFormat("en-US");

export default function BreakAuthorityPage() {
  const i = b.integrated;
  return (
    <article className="company-document break-authority">
      <p className="eyebrow">PAYFLOW / RESEARCH</p>
      <h1>Break Authority</h1>

      <section aria-labelledby="outcome">
        <h2 id="outcome" className="visually-hidden">
          Outcome
        </h2>
        <p className="ba-outcome">
          <strong>{nf.format(i.scenarios)}</strong> adversarial scenarios.{" "}
          <strong>{i.uncontained}</strong> uncontained.
        </p>
        <p className="ba-scope">
          Scope: production authority modules, deterministic <em>fake</em> rail.
          No real money moved. No live model was run.
        </p>
        <p className="intro">
          An agent can be wrong, manipulated or malicious. The question is
          whether being wrong gives it economic permission. Each scenario tries
          to make an agent spend outside its Authority and checks that the Gate
          stopped it.
        </p>
        <GateExample />
      </section>

      <section aria-labelledby="honest">
        <h2 id="honest">How to read the number</h2>
        <p>
          The {nf.format(i.scenarios)} scenarios are parameterised variants of{" "}
          <strong>{i.attackFamilies} attack families</strong>. They produce{" "}
          <strong>
            {i.distinctContainmentOutcomes} distinct containment outcomes
          </strong>
          . That is breadth across parameters, not {nf.format(i.scenarios)}{" "}
          independent ideas. {i.validControls.passed} of {i.validControls.total}{" "}
          valid controls still completed, so the suite is not just refusing
          everything.
        </p>
      </section>

      <section aria-labelledby="categories">
        <h2 id="categories">By attack family</h2>
        <table className="ba-table">
          <caption>
            Scenarios run, scenarios contained and distinct containment outcomes
            per family.
          </caption>
          <thead>
            <tr>
              <th scope="col">Family</th>
              <th scope="col">Scenarios</th>
              <th scope="col">Contained</th>
              <th scope="col">Distinct outcomes</th>
            </tr>
          </thead>
          <tbody>
            {i.categories.map((c) => (
              <tr key={c.category}>
                <th scope="row">{categoryLabel(c.category)}</th>
                <td>{c.scenarios}</td>
                <td>
                  {c.contained}
                  {c.contained === c.scenarios ? " (all)" : ""}
                </td>
                <td>{c.distinctOutcomes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="others">
        <h2 id="others">Other suites, each with its own limits</h2>
        <ul>
          <li>
            Kernel-only: {nf.format(b.kernelOnly.scenarios)} scenarios over{" "}
            {b.kernelOnly.families} families against the decision function;{" "}
            {b.kernelOnly.unauthorizedAllows} unauthorized allows.
          </li>
          <li>
            Fault injection: {b.faultInjection.passed} of{" "}
            {b.faultInjection.total} scenarios passed.
          </li>
          <li>
            Conformance: {b.conformance.passed} of{" "}
            {b.conformance.passed + b.conformance.failed} cases passed. This is
            PayFlow&apos;s own suite, not a certification.
          </li>
          <li>
            Tool selection: {b.toolSelection.passed} of {b.toolSelection.total}{" "}
            deterministic cases. A deterministic reference selector, not a
            language model.
          </li>
        </ul>
      </section>

      <section aria-labelledby="not">
        <h2 id="not">What this does not show</h2>
        <ul>
          <li>No real payment provider was contacted by this suite.</li>
          <li>
            No real model was run against it. A model test needs its own run on
            the same cases.
          </li>
          <li>
            No independent party has reproduced it, and it is not a penetration
            test or a certification.
          </li>
          <li>
            Live PayPal Sandbox behaviour is evidenced separately, in a single
            commissioning record, not by this suite.
          </li>
        </ul>
      </section>

      <section aria-labelledby="repro">
        <h2 id="repro">Reproduce it</h2>
        <pre>
          <code>{`git clone https://github.com/VictorCyberDev/PayFlow
cd PayFlow && npm ci
npm run evidence:check     # regenerates every report and compares it byte-for-byte`}</code>
        </pre>
        <p>
          The check fails if any committed report differs from what the
          production modules produce today.
        </p>
      </section>

      <section aria-labelledby="binding">
        <h2 id="binding">What this page is bound to</h2>
        <p>
          Each report is identified by its SHA-256. Run the check above at any
          commit: if the digests below match what it regenerates, that commit
          produced exactly these numbers. A mismatch fails the check.
        </p>
        <dl className="ba-digests">
          {Object.entries(b.sourceFileSha256).map(([name, digest]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>
                <code>{digest}</code>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <nav className="doc-links" aria-label="Further reading">
        <Link href="/security/">Security center →</Link>
        <Link href="/research/">All research →</Link>
      </nav>
    </article>
  );
}
