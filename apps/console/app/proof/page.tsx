import Link from "next/link";

export default function ProofPage() {
  return (
    <>
      <p className="label">Financial truth</p>
      <h1 className="h1">Proof</h1>
      <p className="lead">
        Proof is the durable answer to what was authorized, which Agent acted,
        what crossed the Gate, what the provider did, and how ambiguity was
        reconciled.
      </p>
      <div className="verifier-panel" aria-label="Proof state examples">
        <p className="label">Outcome line</p>
        <p className="outcome-line">$84 paid once</p>
        <dl className="verifier-state">
          <dt>Authority</dt>
          <dd>Bound to exact action</dd>
          <dt>Execution grant</dt>
          <dd>One-time</dd>
          <dt>Effect count</dt>
          <dd>1</dd>
          <dt>Verification</dt>
          <dd>Portable / tamper-evident</dd>
        </dl>
      </div>
      <section className="block">
        <h2 className="h2">UNKNOWN stays unresolved</h2>
        <p className="lead">
          A timeout is not success and not failure. PayFlow routes the existing
          attempt to reconciliation instead of creating a replacement financial
          effect.
        </p>
        <p className="outcome-line">
          Checking what happened — don&apos;t retry yet
        </p>
      </section>
      <p className="actions">
        <Link className="btn btn--quiet" href="/activity/">
          Activity
        </Link>
        <Link className="btn btn--quiet" href="/verify/">
          Verify
        </Link>
      </p>
    </>
  );
}
