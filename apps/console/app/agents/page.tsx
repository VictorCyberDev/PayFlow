import Link from "next/link";

export default function AgentsPage() {
  return (
    <>
      <p className="label">Personal / small team</p>
      <h1 className="h1">Agents</h1>
      <p className="lead">
        An Agent may receive bounded financial capability. It never receives a
        standing right to spend outside an Authority or unrestricted provider
        credentials.
      </p>
      <div className="surface-grid">
        <article className="surface-card">
          <h2 className="h3">Identity binding</h2>
          <p>
            External identity maps to one scoped Agent and principal context.
          </p>
        </article>
        <article className="surface-card">
          <h2 className="h3">Lifecycle</h2>
          <p>
            Register, activate, sponsor, rotate, suspend, revoke and retire.
          </p>
        </article>
        <article className="surface-card">
          <h2 className="h3">Delegation</h2>
          <p>
            Parent-to-child delegation may attenuate. It cannot silently widen.
          </p>
        </article>
        <article className="surface-card">
          <h2 className="h3">Execution boundary</h2>
          <p>
            Every exact action still traverses current Authority revalidation.
          </p>
        </article>
      </div>
      <p className="actions">
        <Link className="btn" href="/new/">
          Create Authority
        </Link>
        <Link className="btn btn--quiet" href="/developer/">
          Developer access
        </Link>
      </p>
    </>
  );
}
