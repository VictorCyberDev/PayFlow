import type { Metadata } from "next";
export const metadata: Metadata = { title: "About this demo · PayFlow" };

export default function Page() {
  return (
    <>
      <h1 className="h1">About this demo</h1>
      <p className="lead">
        PayFlow gives AI agents permission to spend — not control of your money.
        This page is the one place that explains what is real here.
      </p>
      <section className="block" aria-labelledby="real">
        <h2 id="real" className="label">
          What is real
        </h2>
        <ul className="plain">
          <li>
            Authorities you create are saved in a real database and checked by
            PayFlow&apos;s server.
          </li>
          <li>
            Revoking an Authority is recorded and enforced; completed payments
            are never reversed.
          </li>
          <li>
            Activity and Proof are read from saved records, not from your
            browser.
          </li>
        </ul>
      </section>
      <section className="block" aria-labelledby="notreal">
        <h2 id="notreal" className="label">
          What is a demo
        </h2>
        <ul className="plain">
          <li>
            It&apos;s a sandbox. No real money moves and no production payment
            account is connected.
          </li>
          <li>
            One fixed demo owner is used, opened with a private access code.
            This isn&apos;t production sign-in.
          </li>
          <li>
            The AI reading of your request uses recorded examples, not a live
            model.
          </li>
          <li>Creating an Authority never makes a purchase.</li>
        </ul>
      </section>
    </>
  );
}
