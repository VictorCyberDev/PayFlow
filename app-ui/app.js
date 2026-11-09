// PayFlow customer app. No framework, no inline script, no innerHTML: every value from the server is placed with textContent.
const root = document.getElementById("root");
const state = { me: null, csrf: null };

/** Element builder. Strings become text nodes (never HTML). */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat())
    if (kid !== null && kid !== undefined && kid !== false)
      el.append(
        kid instanceof Node ? kid : document.createTextNode(String(kid)),
      );
  return el;
}

async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && state.csrf) headers["x-pf-csrf"] = state.csrf;
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, ok: res.ok, data };
}

const money = (minor, cur = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(
    minor / 100,
  );
const idem = (p) => `${p}-${crypto.randomUUID()}`;
const reasonText = (r) =>
  ({
    INVALID_CREDENTIALS:
      "That email and password don't match. Check them and try again.",
    EMAIL_UNAVAILABLE: "That email can't be used. Try signing in instead.",
    WEAK_PASSWORD:
      "Use at least 12 characters, not containing your email name.",
    MALFORMED: "Some details are missing or not valid.",
    RATE_LIMITED: "Too many attempts. Wait a minute and try again.",
    PERMISSION_DENIED:
      "Your role does not allow this. Ask an organization owner.",
    CSRF_CHECK_FAILED: "This page is out of date. Reload and try again.",
    INVALID_CONTRACT: "The mission details were not accepted.",
  })[r] ?? "Something went wrong. Nothing was changed.";

function notice(kind, text) {
  return h(
    "p",
    { class: `notice ${kind}`, role: kind === "bad" ? "alert" : "status" },
    text,
  );
}

// ------------------------------------------------------------------------------------------------ shell
function shell(active, ...content) {
  const nav = [
    ["#/", "Home"],
    ["#/missions", "Missions"],
    ["#/agents", "Agents"],
  ];
  root.replaceChildren(
    h(
      "header",
      { class: "bar" },
      h("strong", { text: "PayFlow" }),
      h(
        "nav",
        { "aria-label": "Main" },
        nav.map(([href, label]) =>
          h(
            "a",
            { href, ...(active === href ? { "aria-current": "page" } : {}) },
            label,
          ),
        ),
      ),
      h(
        "div",
        { class: "row" },
        h("span", {
          class: "hint",
          text: `${state.me.user.displayName} · ${state.me.member.role} · Sandbox`,
        }),
        h("button", { onclick: signOut }, "Sign out"),
      ),
    ),
    h("main", { id: "main", tabindex: "-1" }, ...content),
  );
  document.getElementById("main").focus({ preventScroll: true });
}

async function signOut() {
  await api("/v1/app/logout", { method: "POST", body: {} });
  state.me = null;
  state.csrf = null;
  location.hash = "#/";
  render();
}

// ------------------------------------------------------------------------------------------------ signed out
function authScreen(mode = "login") {
  const msg = h("div");
  const form = h(
    "form",
    {
      class: "card",
      onsubmit: async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        const email = String(f.get("email"));
        const password = String(f.get("password"));
        msg.replaceChildren();
        if (mode === "signup") {
          const r = await api("/v1/app/signup", {
            method: "POST",
            body: {
              email,
              password,
              displayName: String(f.get("displayName")),
              organizationName: String(f.get("organizationName")),
            },
          });
          if (!r.ok)
            return msg.replaceChildren(
              notice("bad", reasonText(r.data?.reason)),
            );
        }
        const l = await api("/v1/app/login", {
          method: "POST",
          body: { email, password },
        });
        if (!l.ok)
          return msg.replaceChildren(notice("bad", reasonText(l.data?.reason)));
        state.me = l.data;
        state.csrf = l.data.csrfToken;
        location.hash = "#/";
        render();
      },
    },
    h("h1", { text: mode === "signup" ? "Create your account" : "Sign in" }),
    mode === "signup" && field("displayName", "Your name", "text", "name"),
    mode === "signup" &&
      field("organizationName", "Organization name", "text", "organization"),
    field("email", "Email", "email", "email"),
    field(
      "password",
      "Password",
      "password",
      mode === "signup" ? "new-password" : "current-password",
      mode === "signup" ? "At least 12 characters." : "",
    ),
    msg,
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        { class: "primary", type: "submit" },
        mode === "signup" ? "Create account" : "Sign in",
      ),
    ),
    h(
      "p",
      { class: "hint" },
      mode === "signup" ? "Already have an account? " : "New here? ",
      h(
        "a",
        { href: mode === "signup" ? "#/login" : "#/signup", class: "link" },
        mode === "signup" ? "Sign in" : "Create an account",
      ),
    ),
  );
  root.replaceChildren(
    h(
      "main",
      { id: "main", tabindex: "-1" },
      notice("ok", "Sandbox: nothing here moves real money."),
      form,
    ),
  );
}

function field(
  name,
  label,
  type = "text",
  autocomplete = "off",
  hint = "",
  attrs = {},
) {
  const id = `f-${name}`;
  return h(
    "div",
    {},
    h("label", { for: id, text: label }),
    h("input", {
      id,
      name,
      type,
      autocomplete,
      required: true,
      ...attrs,
      ...(hint ? { "aria-describedby": id + "-h" } : {}),
    }),
    hint && h("p", { class: "hint", id: id + "-h", text: hint }),
  );
}

// ------------------------------------------------------------------------------------------------ pages
async function home() {
  const [agents, missions] = await Promise.all([
    api("/v1/app/agents"),
    api("/v1/admin/org/missions"),
  ]);
  const haveAgent = (agents.data?.agents ?? []).length > 0;
  const list = missions.data?.missions ?? [];
  const haveMission = list.length > 0;
  const haveActive = list.some((m) => m.status === "ACTIVE");
  const step = (done, label, href) =>
    h(
      "li",
      {},
      h("span", { "aria-hidden": "true", text: done ? "✓ " : "○ " }),
      h("a", { href, class: "link", text: label }),
      done ? h("span", { class: "hint", text: " — done" }) : null,
    );
  shell(
    "#/",
    h("h1", { text: `Welcome, ${state.me.user.displayName}` }),
    h(
      "section",
      { class: "card", "aria-labelledby": "get-started" },
      h("h2", { id: "get-started", text: "Get started" }),
      h(
        "ol",
        {},
        step(haveAgent, "Add an agent that will work for you", "#/agents"),
        step(haveMission, "Describe your first mission", "#/missions/new"),
        step(haveActive, "Approve it to put it to work", "#/missions"),
      ),
      h("p", {
        class: "hint",
        text: "A mission is a goal with a budget, rules and the agents allowed to help. Nothing is spent until you approve it, and your rules decide what an agent can ever do.",
      }),
    ),
  );
}

async function agentsPage() {
  const r = await api("/v1/app/agents");
  const out = h("div");
  const form = h(
    "form",
    {
      class: "card",
      onsubmit: async (e) => {
        e.preventDefault();
        const name = new FormData(form).get("displayName");
        const c = await api("/v1/app/agents", {
          method: "POST",
          body: { displayName: String(name) },
        });
        if (!c.ok)
          return out.replaceChildren(notice("bad", reasonText(c.data?.reason)));
        out.replaceChildren(
          notice("ok", `Agent “${c.data.displayName}” added.`),
        );
        agentsPage();
      },
    },
    h("h2", { text: "Add an agent" }),
    field(
      "displayName",
      "Agent name",
      "text",
      "off",
      "For example “Procurement assistant”.",
    ),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", type: "submit" }, "Add agent"),
    ),
  );
  const agents = r.data?.agents ?? [];
  shell(
    "#/agents",
    h("h1", { text: "Agents" }),
    r.status === 403 && notice("bad", reasonText("PERMISSION_DENIED")),
    out,
    h(
      "section",
      { class: "card", "aria-labelledby": "ag" },
      h("h2", { id: "ag", text: "Your agents" }),
      agents.length === 0
        ? h("p", {
            text: "No agents yet. Add one to let missions assign work.",
          })
        : h(
            "table",
            {},
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", { text: "Agent" }),
                h("th", { text: "Status" }),
                h("th", { text: "Credential" }),
              ),
            ),
            h(
              "tbody",
              {},
              agents.map((a) =>
                h(
                  "tr",
                  {},
                  h("td", { text: a.displayName }),
                  h(
                    "td",
                    {},
                    h("span", {
                      class: `badge ${a.lifecycle}`,
                      text: a.lifecycle,
                    }),
                  ),
                  h(
                    "td",
                    {},
                    h(
                      "button",
                      {
                        "aria-label": `Create credential for ${a.displayName}`,
                        onclick: async () => {
                          const c = await api(
                            `/v1/app/agents/${a.agentId}/credentials`,
                            { method: "POST", body: {} },
                          );
                          out.replaceChildren(
                            c.ok
                              ? h(
                                  "div",
                                  { class: "card" },
                                  h("h2", { text: "Copy this credential now" }),
                                  h("p", {
                                    class: "secret",
                                    text: c.data.token,
                                  }),
                                  h("p", {
                                    class: "hint",
                                    text: "It is shown only once. PayFlow keeps only a digest.",
                                  }),
                                )
                              : notice("bad", reasonText(c.data?.reason)),
                          );
                        },
                      },
                      "Create credential",
                    ),
                  ),
                ),
              ),
            ),
          ),
    ),
    form,
  );
}

const CAPS = {
  research: ["SEARCH", "READ", "COMPARE", "DRAFT"],
  negotiate: ["NEGOTIATE", "COMPARE"],
  buy: ["PURCHASE", "REQUEST_APPROVAL", "RESERVE"],
};

async function missionList() {
  const r = await api("/v1/admin/org/missions");
  const missions = r.data?.missions ?? [];
  const details = await Promise.all(
    missions.map((m) => api(`/v1/admin/org/missions/${m.missionId}`)),
  );
  shell(
    "#/missions",
    h(
      "div",
      { class: "row" },
      h("h1", { text: "Missions" }),
      h("a", {
        class: "btn primary",
        href: "#/missions/new",
        text: "New mission",
      }),
    ),
    missions.length === 0
      ? h(
          "div",
          { class: "card" },
          h("p", { text: "No missions yet." }),
          h("a", {
            href: "#/missions/new",
            class: "link",
            text: "Describe your first mission",
          }),
        )
      : missions.map((m, i) => {
          const c =
            details[i].data?.mission?.activeContract ??
            details[i].data?.mission?.latestContract;
          return h(
            "article",
            { class: "card" },
            h(
              "div",
              { class: "row" },
              h("a", {
                class: "link",
                href: `#/missions/${m.missionId}`,
                text: c?.objective ?? m.missionId,
              }),
              h("span", {
                class: `badge ${m.status}`,
                text: m.status.replaceAll("_", " "),
              }),
            ),
            c &&
              h("p", {
                class: "hint",
                text: `Budget ${money(c.totalBudgetMinor, c.currency)} · up to ${money(c.maxCommitmentMinor, c.currency)} per purchase`,
              }),
          );
        }),
  );
}

async function wizard() {
  const agentsR = await api("/v1/app/agents");
  const agents = agentsR.data?.agents ?? [];
  const d = {
    step: 0,
    objective: "",
    outcome: "",
    criteria: "",
    budget: "1000",
    maxOne: "300",
    approveAbove: "200",
    category: "EQUIPMENT",
    merchant: "payflow.demo.merchant",
    days: "14",
    roles: {},
  };
  const steps = ["Goal", "Money", "Agents", "Review"];
  const err = h("div");
  const body = h("div");
  const toMinor = (s) => Math.round(Number(s) * 100);
  function draw() {
    err.replaceChildren();
    const nav = h(
      "ol",
      { class: "steps", "aria-label": "Steps" },
      steps.map((s, i) =>
        h(
          "li",
          i === d.step ? { "aria-current": "step" } : {},
          `${i + 1}. ${s}`,
        ),
      ),
    );
    let panel;
    if (d.step === 0)
      panel = h(
        "div",
        {},
        input(
          "objective",
          "What should be done?",
          d.objective,
          "text",
          "For example “Buy two quiet keyboards for the studio”.",
        ),
        input("outcome", "What does done look like?", d.outcome),
        input(
          "criteria",
          "How will you judge it? (one per line)",
          d.criteria,
          "textarea",
        ),
      );
    else if (d.step === 1)
      panel = h(
        "div",
        {},
        input(
          "budget",
          "Total budget (USD)",
          d.budget,
          "number",
          "The most this mission can ever commit.",
          { min: "1", step: "0.01" },
        ),
        input(
          "maxOne",
          "Largest single purchase (USD)",
          d.maxOne,
          "number",
          "",
          { min: "1", step: "0.01" },
        ),
        input(
          "approveAbove",
          "Ask me first above (USD)",
          d.approveAbove,
          "number",
          "Anything larger waits for your decision.",
          { min: "1", step: "0.01" },
        ),
        input("category", "Spending category", d.category),
        input(
          "merchant",
          "Only buy from (merchant id)",
          d.merchant,
          "text",
          "Purchases outside this are refused.",
        ),
        input("days", "Ends after (days)", d.days, "number", "", {
          min: "1",
          max: "90",
        }),
      );
    else if (d.step === 2)
      panel =
        agents.length === 0
          ? h(
              "div",
              {},
              notice("bad", "You need at least one agent first."),
              h("a", { class: "link", href: "#/agents", text: "Add an agent" }),
            )
          : h(
              "div",
              {},
              h("p", {
                class: "hint",
                text: "Choose what each agent may do. Buying is the only role that can lead to a payment, and only inside your budget and rules.",
              }),
              agents.map((a) =>
                h(
                  "fieldset",
                  { class: "card" },
                  h("legend", { text: a.displayName }),
                  Object.keys(CAPS).map((k) =>
                    h(
                      "label",
                      { class: "check" },
                      h("input", {
                        type: "checkbox",
                        ...(d.roles[a.agentId]?.has(k)
                          ? { checked: true }
                          : {}),
                        onchange: (e) => {
                          const s = (d.roles[a.agentId] ??= new Set());
                          e.target.checked ? s.add(k) : s.delete(k);
                        },
                      }),
                      {
                        research: "Research and compare",
                        negotiate: "Negotiate",
                        buy: "Buy (within limits)",
                      }[k],
                    ),
                  ),
                ),
              ),
            );
    else
      panel = h(
        "div",
        { class: "card" },
        h("h2", { text: "Review" }),
        h("p", { text: d.objective }),
        h("p", {
          text: `Budget ${money(toMinor(d.budget))}; largest purchase ${money(toMinor(d.maxOne))}; ask first above ${money(toMinor(d.approveAbove))}.`,
        }),
        h("p", {
          text: `Only ${d.merchant} · category ${d.category} · ends in ${d.days} days.`,
        }),
        h("p", {
          class: "hint",
          text: "Creating this saves a draft. Nothing is spent or in force until you approve it.",
        }),
      );
    body.replaceChildren(
      nav,
      panel,
      h(
        "div",
        { class: "actions" },
        d.step > 0 &&
          h(
            "button",
            {
              onclick: () => {
                collect();
                d.step--;
                draw();
              },
            },
            "Back",
          ),
        d.step < 3
          ? h("button", { class: "primary", onclick: next }, "Next")
          : h(
              "button",
              { class: "primary", onclick: create },
              "Create mission",
            ),
      ),
    );
  }
  function input(name, label, value, type = "text", hint = "", attrs = {}) {
    const id = `w-${name}`;
    const el =
      type === "textarea"
        ? h("textarea", { id, name, rows: 4 })
        : h("input", { id, name, type, ...attrs });
    el.value = value;
    return h(
      "div",
      {},
      h("label", { for: id, text: label }),
      el,
      hint && h("p", { class: "hint", text: hint }),
    );
  }
  function collect() {
    for (const el of body.querySelectorAll("input[name],textarea[name]"))
      if (el.name in d) d[el.name] = el.value;
  }
  function next() {
    collect();
    const bad = [];
    if (
      d.step === 0 &&
      (!d.objective.trim() || !d.outcome.trim() || !d.criteria.trim())
    )
      bad.push(
        "Fill in the goal, the outcome and at least one success criterion.",
      );
    if (d.step === 1) {
      const [b, m, a] = [
        toMinor(d.budget),
        toMinor(d.maxOne),
        toMinor(d.approveAbove),
      ];
      if (!(b > 0 && m > 0 && a > 0)) bad.push("Amounts must be above zero.");
      if (m > b)
        bad.push("The largest single purchase cannot exceed the total budget.");
      if (a > m)
        bad.push(
          "“Ask me first above” cannot exceed the largest single purchase.",
        );
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(d.merchant) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(d.category)
      )
        bad.push(
          "Merchant and category may use letters, numbers and . _ : - only.",
        );
    }
    if (d.step === 2 && !Object.values(d.roles).some((s) => s.size > 0))
      bad.push("Give at least one agent a role.");
    if (bad.length)
      return err.replaceChildren(...bad.map((t) => notice("bad", t)));
    d.step++;
    draw();
  }
  async function create() {
    const days = Math.min(90, Math.max(1, Number(d.days) || 14));
    const contract = {
      objective: d.objective.trim(),
      intendedOutcome: d.outcome.trim(),
      successCriteria: d.criteria
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      currency: "USD",
      totalBudgetMinor: toMinor(d.budget),
      maxCommitmentMinor: toMinor(d.maxOne),
      spendingCategories: [d.category],
      approvedProviderTypes: ["COMMERCE_MARKETPLACE"],
      merchantRestrictions: { mode: "ONLY", ids: [d.merchant] },
      agents: Object.entries(d.roles)
        .filter(([, s]) => s.size)
        .map(([agentId, s]) => ({
          agentId,
          capabilities: [...s].flatMap((k) => CAPS[k]),
        })),
      approvalConditions: { humanApprovalAboveMinor: toMinor(d.approveAbove) },
      expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    };
    const r = await api("/v1/admin/org/missions", {
      method: "POST",
      body: { contract, idempotencyKey: idem("mission") },
    });
    if (!r.ok)
      return err.replaceChildren(
        notice(
          "bad",
          `${reasonText(r.data?.reason)}${r.data?.detail ? " (" + r.data.detail + ")" : ""}`,
        ),
      );
    location.hash = `#/missions/${r.data.mission.missionId}`;
  }
  shell(
    "#/missions",
    h("h1", { text: "New mission" }),
    err,
    h("div", { class: "card" }, body),
  );
  draw();
}

async function missionPage(id) {
  const r = await api(`/v1/admin/org/missions/${id}`);
  if (!r.ok)
    return shell(
      "#/missions",
      h("h1", { text: "Mission not found" }),
      notice("bad", "That mission doesn't exist, or you can't see it."),
    );
  const m = r.data.mission;
  const c = m.pendingContract ?? m.activeContract ?? m.latestContract;
  const out = h("div");
  const act = (
    label,
    op,
    { primary = false, danger = false, body = {} } = {},
  ) =>
    h(
      "button",
      {
        class: primary ? "primary" : danger ? "danger" : "",
        onclick: async () => {
          if (
            danger &&
            !confirm(
              `${label}? This stops the mission's spending power immediately.`,
            )
          )
            return;
          const res = await api(`/v1/admin/org/missions/${id}/${op}`, {
            method: "POST",
            body: {
              ...body,
              ...(m.rowVersion ? { expectedRowVersion: m.rowVersion } : {}),
            },
          });
          if (!res.ok)
            return out.replaceChildren(
              notice(
                "bad",
                `${reasonText(res.data?.reason)}${res.data?.detail ? " (" + res.data.detail + ")" : ""}`,
              ),
            );
          missionPage(id);
        },
      },
      label,
    );
  const actions = [];
  if (m.status === "DRAFT")
    actions.push(act("Submit for approval", "submit", { primary: true }));
  if (m.status === "PENDING_OWNER_APPROVAL")
    actions.push(
      act("Approve", "approve", {
        primary: true,
        body: { version: m.pendingVersion },
      }),
      act("Reject", "reject", {
        danger: true,
        body: { version: m.pendingVersion },
      }),
    );
  if (m.status === "ACTIVE")
    actions.push(
      act("Pause", "pause"),
      act("Complete", "complete"),
      act("Revoke", "revoke", {
        danger: true,
        body: { reason: "Stopped by owner" },
      }),
    );
  if (m.status === "PAUSED")
    actions.push(
      act("Resume", "resume", { primary: true }),
      act("Cancel", "cancel", { danger: true }),
    );
  const [auth, ledger] = await Promise.all([
    api(`/v1/admin/org/missions/${id}/authorities`),
    api(`/v1/admin/org/missions/${id}/ledger`),
  ]);
  shell(
    "#/missions",
    h(
      "div",
      { class: "row" },
      h("h1", { text: c.objective }),
      h("span", {
        class: `badge ${m.status}`,
        text: m.status.replaceAll("_", " "),
      }),
    ),
    out,
    h(
      "section",
      { class: "card", "aria-labelledby": "mc" },
      h("h2", { id: "mc", text: "Mission rules" }),
      h(
        "dl",
        {},
        row("Outcome", c.intendedOutcome),
        row("Total budget", money(c.totalBudgetMinor, c.currency)),
        row("Largest purchase", money(c.maxCommitmentMinor, c.currency)),
        row(
          "Ask you first above",
          c.approvalConditions?.humanApprovalAboveMinor
            ? money(c.approvalConditions.humanApprovalAboveMinor, c.currency)
            : "—",
        ),
        row("Buys only from", c.merchantRestrictions?.ids?.join(", ") ?? "—"),
        row("Ends", new Date(c.expiresAt).toLocaleString()),
      ),
      h("div", { class: "actions" }, actions),
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "ma" },
      h("h2", { id: "ma", text: "Spending authority" }),
      (auth.data?.authorities ?? []).length === 0
        ? h("p", {
            text:
              m.status === "ACTIVE"
                ? "No agent holds spending authority."
                : "Spending authority is created only when you approve the mission, and ends when it is paused, revoked or finished.",
          })
        : h(
            "table",
            {},
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                ["Agent", "Category", "Up to", "Status"].map((t) =>
                  h("th", { text: t }),
                ),
              ),
            ),
            h(
              "tbody",
              {},
              auth.data.authorities.map((a) =>
                h(
                  "tr",
                  {},
                  h("td", { text: a.agentId }),
                  h("td", { text: a.category }),
                  h("td", { text: money(a.allocationMinor, c.currency) }),
                  h(
                    "td",
                    {},
                    h("span", { class: `badge ${a.status}`, text: a.status }),
                  ),
                ),
              ),
            ),
          ),
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "ml" },
      h("h2", { id: "ml", text: "Budget" }),
      ledger.ok
        ? h("p", {
            text: `Committed or at risk: ${money(ledger.data.summary?.exposureMinor ?? 0, c.currency)} of ${money(c.totalBudgetMinor, c.currency)}.`,
          })
        : h("p", {
            class: "hint",
            text: "The budget ledger is not available to your role.",
          }),
    ),
  );
}
const row = (k, v) =>
  h("div", { class: "row" }, h("dt", { text: k }), h("dd", { text: v }));

// ------------------------------------------------------------------------------------------------ router
async function render() {
  const hash = location.hash || "#/";
  if (!state.me) {
    const me = await api("/v1/app/me");
    if (me.ok) {
      state.me = me.data;
      state.csrf = me.data.csrfToken;
    }
  }
  if (!state.me) return authScreen(hash === "#/signup" ? "signup" : "login");
  if (hash === "#/signup" || hash === "#/login")
    return void (location.hash = "#/");
  try {
    if (hash === "#/agents") return await agentsPage();
    if (hash === "#/missions") return await missionList();
    if (hash === "#/missions/new") return await wizard();
    const m = /^#\/missions\/(msn_[a-f0-9]{24})$/.exec(hash);
    if (m) return await missionPage(m[1]);
    return await home();
  } catch {
    shell(
      "#/",
      notice(
        "bad",
        "Something went wrong loading this page. Nothing was changed.",
      ),
    );
  }
}
addEventListener("hashchange", render);
render();
