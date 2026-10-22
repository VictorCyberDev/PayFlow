const nav = ["Home", "Ask PayFlow", "Authority", "Activity", "Agents"];

const recent = [
  {
    title: "Mechanical keyboard",
    detail: "$84.00 · Demo Merchant",
    outcome: "Payment verified",
  },
  {
    title: "Premium keyboard attempt",
    detail: "$184.00 · Above your $100 limit",
    outcome: "Your money didn't move",
  },
];

export default function HomePage() {
  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <a className="brand" href="#" aria-label="PayFlow home">
          <span className="brand-mark">P</span>
          <span>PayFlow</span>
        </a>

        <nav>
          {nav.map((item, index) => (
            <a className={index === 0 ? "nav-item active" : "nav-item"} href="#" key={item}>
              {item}
            </a>
          ))}
        </nav>

        <div className="sidebar-note">
          <span className="status-dot" aria-hidden="true" />
          <div>
            <strong>Protected by PayFlow</strong>
            <span>Authority is enforced server-side.</span>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="mobile-brand">PayFlow</div>
          <button className="avatar" type="button" aria-label="Open account menu">
            V
          </button>
        </header>

        <div className="content">
          <section className="hero" aria-labelledby="welcome-title">
            <p className="eyebrow">Your AI. Your authority.</p>
            <h1 id="welcome-title">What can your agent handle for you?</h1>
            <p className="hero-copy">
              Describe what you want done. PayFlow turns your instructions into clear limits you can review before anything becomes authorized.
            </p>

            <div className="composer" role="group" aria-label="Ask PayFlow">
              <textarea
                aria-label="Describe what your agent should handle"
                defaultValue="Buy me one new mechanical keyboard under $100 this week. Never buy used or refurbished."
                rows={3}
              />
              <div className="composer-footer">
                <span>Nothing is authorized until you review and confirm it.</span>
                <button type="button">Review request</button>
              </div>
            </div>
          </section>

          <section className="section-block" aria-labelledby="authority-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Active authority</p>
                <h2 id="authority-title">Your agent can act inside these limits</h2>
              </div>
              <button className="text-button" type="button">View all</button>
            </div>

            <article className="authority-card">
              <div className="authority-card-topline">
                <div>
                  <span className="state-pill">Active</span>
                  <h3>Keyboard purchase</h3>
                  <p>Shopping Agent</p>
                </div>
                <div className="amount-block">
                  <span>Up to</span>
                  <strong>$100.00</strong>
                </div>
              </div>

              <div className="authority-progress" aria-label="$84 of $100 used">
                <div className="authority-progress-bar"><span /></div>
                <div className="authority-progress-copy">
                  <span>$16.00 remaining</span>
                  <span>$84.00 used</span>
                </div>
              </div>

              <div className="constraint-grid">
                <div><span>Item</span><strong>1 new item</strong></div>
                <div><span>Where</span><strong>Approved merchants only</strong></div>
                <div><span>Approval</span><strong>Can complete without asking again</strong></div>
                <div><span>Expires</span><strong>Friday · 6:00 PM</strong></div>
              </div>

              <div className="authority-actions">
                <p>Backed by your confirmed PayFlow mandate.</p>
                <button type="button">View authority</button>
              </div>
            </article>
          </section>

          <section className="section-block" aria-labelledby="activity-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Recent activity</p>
                <h2 id="activity-title">What your agent tried and what happened</h2>
              </div>
              <button className="text-button" type="button">View activity</button>
            </div>

            <div className="activity-list">
              {recent.map((item, index) => (
                <article className="activity-row" key={item.title}>
                  <div className={index === 0 ? "activity-icon verified" : "activity-icon blocked"} aria-hidden="true">
                    {index === 0 ? "✓" : "—"}
                  </div>
                  <div className="activity-copy">
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </div>
                  <div className="activity-outcome">
                    <strong>{item.outcome}</strong>
                    <button type="button">Why?</button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <p className="fixture-note">
            M5A preview uses deterministic fixtures only. No authority or payment action is performed from this screen.
          </p>
        </div>
      </section>
    </main>
  );
}
