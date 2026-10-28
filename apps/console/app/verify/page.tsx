export default function VerifyPage() {
  return (
    <>
      <p className="label">Verifier / merchant</p>
      <h1 className="h1">Verify Authority. Never move money.</h1>
      <p className="lead">
        A verifier checks who or what is acting, whether Authority is current,
        whether this exact action fits, and whether Proof is authentic. Verify is
        read-only by design.
      </p>
      <section className="verifier-panel" aria-labelledby="verify-contract">
        <h2 id="verify-contract" className="h2">Verification contract</h2>
        <dl className="verifier-state">
          <dt>Agent</dt><dd>Bound identity</dd>
          <dt>Authority</dt><dd>Active / suspended / revoked / expired</dd>
          <dt>Request</dt><dd>Audience + challenge + freshness bound</dd>
          <dt>Action fit</dt><dd>Amount, currency, counterparty and scope</dd>
          <dt>Proof</dt><dd>Portable signature and effect truth</dd>
          <dt>Execution</dt><dd>Not available from Verify</dd>
        </dl>
      </section>
      <section className="block">
        <h2 className="h2">Gate Mark rule</h2>
        <p className="lead">
          The mark signals support for verification. A static image is never
          security proof. A VERIFIED state must come from a fresh, bound verdict.
        </p>
        <p className="outcome-line">Authority verified · read-only</p>
      </section>
    </>
  );
}
