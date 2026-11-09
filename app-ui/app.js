// PayFlow customer app. No framework, no inline script, no innerHTML: every value from the server is placed with textContent.
const root = document.getElementById("root");
const state = { me: null, csrf: null, template: null };

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

/** replaceChildren that accepts nested arrays and skips empty values, like `h`. */
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter(Boolean));
const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const k of kids) el.append(k);
  return el;
}
/** BRAND-001 mark: a square frame open at the right (the Gate) with the Flow line passing through. */
function brandMark() {
  return svg(
    "svg",
    { viewBox: "0 0 32 32", "aria-hidden": "true", focusable: "false" },
    svg("path", {
      d: "M28 11V4H4v24h24v-7",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 3,
      "stroke-linejoin": "miter",
    }),
    svg("path", {
      d: "M11 16h21",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 3,
    }),
  );
}
/** State is read by SHAPE and WORD, never colour alone (BRAND-001 section 4). */
const STATES = {
  ACTIVE: ["In force", "bar-open"],
  DRAFT: ["Draft", "hollow"],
  PENDING_OWNER_APPROVAL: ["Waiting for you", "dot"],
  PAUSED: ["Paused", "dot"],
  COMPLETED: ["Finished", "filled"],
  REVOKED: ["Revoked", "strike"],
  CANCELLED: ["Cancelled", "strike"],
  EXPIRED: ["Expired", "hollow"],
  FAILED: ["Didn't go through", "cross"],
  REGISTERED: ["Added", "hollow"],
};
function glyph(kind) {
  const r = svg("rect", { x: 3, y: 3, width: 18, height: 18 });
  const g = svg(
    "svg",
    {
      class: "glyph",
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
      focusable: "false",
    },
    r,
  );
  if (kind === "filled") r.setAttribute("class", "fill");
  if (kind === "dot") {
    r.setAttribute("stroke-dasharray", "3 3");
    g.append(svg("circle", { cx: 12, cy: 12, r: 3, class: "amber" }));
  }
  if (kind === "cross")
    g.append(
      svg("path", {
        d: "M3 3l18 18M21 3L3 21",
        stroke: "#111418",
        "stroke-width": 2.5,
      }),
    );
  if (kind === "strike")
    g.append(
      svg("path", { d: "M2 12h20", stroke: "#111418", "stroke-width": 3 }),
    );
  if (kind === "bar-open")
    g.append(
      svg("path", { d: "M8 12h16", stroke: "#e8aa00", "stroke-width": 3 }),
    );
  return g;
}
function badge(status) {
  const [word, kind] = STATES[status] ?? [
    String(status).replaceAll("_", " ").toLowerCase(),
    "hollow",
  ];
  return h("span", { class: "badge" }, glyph(kind), word);
}

const money = (minor, cur = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(
    minor / 100,
  );
/** "Friday, Nov 6 at 6:00 PM" — plain language, no seconds (BRAND-001 section 7). */
const when = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "a time that was not recorded";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
};
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
    NOT_QUALIFIED:
      "That listing doesn't fit your needs, so it can't be booked.",
    ALREADY_LIVE: "There is already a live booking for that listing.",
    BAD_DEADLINE: "The decision date is not allowed.",
    ILLEGAL_MOVE: "That can't happen from the booking's current state.",
    EXPIRED: "This booking has expired. Nothing was reserved.",
    LEDGER_REFUSED:
      "Holding that budget would go over your limit, so nothing was held.",
    PENALTY_ABOVE_TERMS:
      "That charge is more than the cancellation terms allow.",
    DEPOSIT_NOT_REQUIRED: "This listing has no deposit.",
    NOT_FOUND: "That doesn't exist, or you can't see it.",
    MISSION_NOT_ACTIVE: "The mission isn't active.",
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
    ["#/launch", "Templates"],
    ["#/approvals", "Approvals"],
    ["#/checking", "Needs checking"],
    ["#/agents", "Agents"],
    ["#/notifications", "Notifications"],
    ["#/settings", "Settings"],
    ["#/help", "Help"],
  ];
  root.replaceChildren(
    h(
      "header",
      { class: "bar" },
      h(
        "a",
        { class: "brand", href: "#/", "aria-label": "PayFlow home" },
        brandMark(),
        "PayFlow",
      ),
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
        h(
          "span",
          { class: "who" },
          h("span", { class: "env", text: "Sandbox" }),
          h("span", {
            class: "hint",
            text: `${state.me.user.displayName} · ${state.me.member.role}`,
          }),
        ),
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
      "header",
      { class: "bar" },
      h(
        "a",
        { class: "brand", href: "#/", "aria-label": "PayFlow" },
        brandMark(),
        "PayFlow",
      ),
      h("span", { class: "env", text: "Sandbox" }),
    ),
    h(
      "main",
      { id: "main", tabindex: "-1" },
      h("p", {
        class: "lede",
        text: "Give AI agents permission to spend — not control of your money.",
      }),
      form,
      h("p", {
        class: "hint",
        text: "Sandbox: nothing here moves real money.",
      }),
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

const READINESS_WORDS = {
  NOT_ACTIVATED: "Not yet active",
  SUSPENDED: "No. It is suspended.",
  REVOKED: "No. It was revoked for good.",
  RETIRED: "No. It is retired.",
  CREDENTIAL_EXPIRED: "No. Its passport has expired.",
  CREDENTIAL_NOT_YET_VALID: "Not yet. Its passport starts later.",
};
/** What an agent can do right now, from the server's readiness (derived from the same lifecycle and expiry the gateway enforces). */
function agentReadinessWords(a) {
  const r = a.readiness;
  if (!r) return "Unknown";
  if (!r.canAct) return READINESS_WORDS[r.why] ?? "No";
  return r.rotation === "ROTATE_SOON"
    ? `Yes, but its passport ends ${when(a.expiresAt)}. Renew it soon.`
    : "Yes";
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
                h("th", { text: "Can it act?" }),
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
                  h("td", {}, badge(a.lifecycle)),
                  h(
                    "td",
                    { "data-label": "Can it act?" },
                    agentReadinessWords(a),
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
              badge(m.status),
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

/**
 * Mission templates (M58), including a Founder Launch starter pack. A template only fills in the form; it is NOT the orchestrated Founder Launch mission (M55), which does not exist yet. It never creates, approves,
 * spends or contacts anyone: the owner still reads, edits and approves, and the server checks every field again. Amounts are
 * starting points the owner is expected to change, not estimates of what anything costs.
 */
const TEMPLATES = [
  {
    key: "workspace",
    pack: "Founder Launch",
    title: "Find a place to work",
    blurb:
      "Compare desks and small offices in your city. Agents look and compare; you decide what to book.",
    d: {
      objective: "Find a workspace for my team",
      outcome: "Three workspaces compared, with what each could cost me",
      criteria:
        "Fits my team size\nTotal cost and deposit are stated\nCancellation terms are clear",
      budget: "3000",
      maxOne: "1500",
      approveAbove: "500",
      category: "WORKSPACE",
      providers: ["WORKSPACE_PROVIDER"],
    },
  },
  {
    key: "brand",
    pack: "Founder Launch",
    title: "Get a logo and brand basics",
    blurb: "Compare fixed-price design packages from providers.",
    d: {
      objective: "Commission a logo and brand basics",
      outcome: "A design package chosen and ready to approve",
      criteria:
        "Price and delivery time are stated\nRevisions are included\nRefund terms are clear",
      budget: "1500",
      maxOne: "1000",
      approveAbove: "300",
      category: "DESIGN",
      providers: ["PROFESSIONAL_SERVICES"],
    },
  },
  {
    key: "equipment",
    pack: "Founder Launch",
    title: "Equip the team",
    blurb: "Look for laptops, monitors or other equipment within a budget.",
    d: {
      objective: "Buy equipment for the team",
      outcome: "Equipment ordered within budget",
      criteria: "Under budget\nDelivered within two weeks",
      budget: "4000",
      maxOne: "1500",
      approveAbove: "500",
      category: "EQUIPMENT",
      providers: ["COMMERCE_MARKETPLACE"],
    },
  },
  {
    key: "freelancer",
    pack: "Founder Launch",
    title: "Hire a freelancer for one task",
    blurb: "Describe one piece of work and compare people who could do it.",
    d: {
      objective: "Hire a freelancer for a defined task",
      outcome: "A freelancer chosen, with scope and price agreed",
      criteria:
        "Scope and price are written down\nPayment only after I accept the work",
      budget: "2000",
      maxOne: "1500",
      approveAbove: "400",
      category: "CONTRACTOR",
      providers: ["TALENT_MARKETPLACE"],
    },
  },
  {
    key: "bookkeeping",
    pack: "Everyday",
    title: "Set up bookkeeping",
    blurb: "Compare monthly bookkeeping packages.",
    d: {
      objective: "Find a bookkeeping service",
      outcome: "A monthly bookkeeping package chosen",
      criteria: "Monthly price is stated\nWhat is delivered is stated",
      budget: "1000",
      maxOne: "400",
      approveAbove: "200",
      category: "BOOKKEEPING",
      providers: ["PROFESSIONAL_SERVICES"],
    },
  },
];
function launchPage() {
  const packs = [...new Set(TEMPLATES.map((t) => t.pack))];
  shell(
    "#/launch",
    h("h1", { text: "Start from a template" }),
    h("p", {
      text: "A template only fills in the form for you. Nothing is created, approved or spent until you review it and approve it yourself.",
    }),
    packs.map((pack) =>
      h(
        "section",
        {},
        h("h2", { text: pack }),
        TEMPLATES.filter((t) => t.pack === pack).map((t) =>
          h(
            "article",
            { class: "card" },
            h("h3", { text: t.title }),
            h("p", { text: t.blurb }),
            h("div", { class: "actions" }, [
              h("button", {
                type: "button",
                class: "primary",
                text: "Use this template",
                "aria-label": `Use the template: ${t.title}`,
                onclick: () => {
                  state.template = t.key;
                  location.hash = "#/missions/new";
                },
              }),
            ]),
          ),
        ),
      ),
    ),
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
    providers: new Set(["COMMERCE_MARKETPLACE"]),
    currency: "USD",
    lookOnly: false,
    packNote: "",
  };
  const tpl = TEMPLATES.find((t) => t.key === state.template);
  state.template = null;
  if (tpl) Object.assign(d, tpl.d, { providers: new Set(tpl.d.providers) });
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
        suggestBox(),
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
          "Total budget",
          d.budget,
          "number",
          "The most this mission can ever commit.",
          { min: "1", step: "0.01" },
        ),
        input("maxOne", "Largest single purchase", d.maxOne, "number", "", {
          min: "1",
          step: "0.01",
        }),
        input(
          "approveAbove",
          "Ask me first above",
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
                  Object.keys(CAPS)
                    .filter((k) => !(d.lookOnly && k === "buy"))
                    .map((k) =>
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
          text: `Budget ${money(toMinor(d.budget), d.currency)}; largest purchase ${money(toMinor(d.maxOne), d.currency)}; ask first above ${money(toMinor(d.approveAbove), d.currency)}.`,
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
      d.step === 1 ? currencyBox() : null,
      d.step === 1 ? providersBox() : null,
      d.step === 1 ? packBox() : null,
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
  /** Optional AI suggestion: pre-fills the fields for the person to review. It never creates or approves anything. */
  function suggestBox() {
    const status = h("p", { class: "hint", role: "status" });
    const note = h("p", { id: "ai-note", class: "hint", role: "status" });
    const box = h("textarea", { id: "ai-text", rows: 3, maxlength: "1500" });
    return h(
      "div",
      { class: "aside" },
      h("label", {
        for: "ai-text",
        text: "Or describe it in your own words (optional)",
      }),
      box,
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            type: "button",
            onclick: async () => {
              status.textContent = "Thinking…";
              const r = await api("/v1/app/missions/draft", {
                method: "POST",
                body: { text: box.value },
              });
              if (!r.ok) {
                status.textContent =
                  r.status === 503
                    ? "AI suggestions aren't switched on for this workspace. Fill in the fields yourself."
                    : r.status === 429
                      ? "Too many suggestions. Try again in a minute."
                      : "No suggestion this time. Fill in the fields yourself.";
                return;
              }
              const s = r.data.draft;
              d.objective = s.objective;
              d.outcome = s.intendedOutcome;
              d.criteria = s.successCriteria.join("\n");
              d.budget = String(s.suggestedBudgetMinor / 100);
              d.maxOne = String(s.suggestedMaxPurchaseMinor / 100);
              d.approveAbove = String(
                Math.max(1, Math.round(s.suggestedMaxPurchaseMinor * 0.7)) /
                  100,
              );
              d.category = s.suggestedCategory;
              draw();
              const n = document.getElementById("ai-note");
              if (n)
                n.textContent = `${r.data.notice}${s.questions.length ? " Questions to consider: " + s.questions.join(" ") : ""}`;
            },
          },
          "Suggest",
        ),
      ),
      status,
      note,
    );
  }
  /** What kinds of source agents may look at. Choosing one only lets agents LOOK; nothing is bought or booked without your rules and approval. */
  function providersBox() {
    const opts = [
      ["COMMERCE_MARKETPLACE", "Products (equipment, supplies)"],
      ["WORKSPACE_PROVIDER", "Workspaces (desks, offices, meeting rooms)"],
      ["TALENT_MARKETPLACE", "Freelancers and contractors"],
      [
        "PROFESSIONAL_SERVICES",
        "Professional services (design, writing, bookkeeping)",
      ],
    ];
    return h(
      "fieldset",
      {},
      h("legend", { text: "Where may agents look?" }),
      opts.map(([k, label]) =>
        h(
          "label",
          { class: "check" },
          h("input", {
            type: "checkbox",
            ...(d.providers.has(k) ? { checked: true } : {}),
            onchange: (e) => {
              e.target.checked ? d.providers.add(k) : d.providers.delete(k);
            },
          }),
          label,
        ),
      ),
    );
  }
  /**
   * Safety packs (M67). Applying one only lowers what you asked for (the server does the arithmetic) and lists every change. It cannot raise a
   * limit, and "Look only" turns buying off.
   */
  function packBox() {
    const note = h("div", { role: "status" });
    const sel = h(
      "select",
      { id: "w-pack" },
      h("option", { value: "", text: "No pack" }),
      h("option", { value: "CAUTIOUS", text: "Cautious" }),
      h("option", { value: "STANDARD", text: "Standard" }),
      h("option", { value: "EXPLORATORY_ONLY", text: "Look only" }),
    );
    return h(
      "div",
      { class: "aside" },
      h("label", { for: "w-pack", text: "Safety pack (optional)" }),
      sel,
      h("p", {
        class: "hint",
        text: "A pack lowers any limit above its ceiling. It never raises one.",
      }),
      h("button", {
        type: "button",
        text: "Apply pack",
        onclick: async () => {
          collect();
          if (!sel.value) return note.replaceChildren();
          const r = await api("/v1/app/policy-packs/apply", {
            method: "POST",
            body: {
              pack: sel.value,
              limits: {
                totalBudgetMinor: toMinor(d.budget),
                maxPurchaseMinor: toMinor(d.maxOne),
                approveAboveMinor: toMinor(d.approveAbove),
                durationDays: Number(d.days),
              },
            },
          });
          if (!r.ok)
            return note.replaceChildren(
              notice("bad", reasonText(r.data?.reason)),
            );
          const l = r.data.limits;
          d.maxOne = String(l.maxPurchaseMinor / 100);
          d.approveAbove = String(l.approveAboveMinor / 100);
          d.days = String(l.durationDays);
          d.lookOnly = r.data.lookOnly;
          if (r.data.lookOnly)
            for (const k of Object.keys(d.roles)) d.roles[k].delete("buy");
          d.packNote = r.data.changes.length
            ? "Lowered: " +
              r.data.changes
                .map(
                  (c) =>
                    `${humanKey(c.field)} from ${c.field === "durationDays" ? c.from + " days" : money(c.from, d.currency)} to ${c.field === "durationDays" ? c.to + " days" : money(c.to, d.currency)}`,
                )
                .join("; ")
            : "Your limits were already within this pack.";
          draw();
        },
      }),
      d.packNote
        ? h("p", { class: "notice", role: "status", text: d.packNote })
        : null,
      note,
    );
  }
  function currencyBox() {
    const sel = h(
      "select",
      {
        id: "w-currency",
        onchange: (e) => {
          d.currency = e.target.value;
        },
      },
      ["USD", "GBP", "EUR"].map((c) =>
        h("option", {
          value: c,
          ...(d.currency === c ? { selected: true } : {}),
          text: c,
        }),
      ),
    );
    return h(
      "div",
      {},
      h("label", { for: "w-currency", text: "Currency" }),
      sel,
      h("p", {
        class: "hint",
        text: "Every amount in this mission uses this currency.",
      }),
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
    if (d.step === 1 && d.providers.size === 0)
      bad.push("Choose at least one place agents may look.");
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
      currency: d.currency,
      totalBudgetMinor: toMinor(d.budget),
      maxCommitmentMinor: toMinor(d.maxOne),
      spendingCategories: [d.category],
      approvedProviderTypes: [...d.providers],
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
  const agentNames = new Map(
    ((await api("/v1/app/agents")).data?.agents ?? []).map((a) => [
      a.agentId,
      a.displayName,
    ]),
  );
  const [auth, ledger] = await Promise.all([
    api(`/v1/admin/org/missions/${id}/authorities`),
    api(`/v1/admin/org/missions/${id}/ledger`),
  ]);
  shell(
    "#/missions",
    h("div", { class: "row" }, h("h1", { text: c.objective }), badge(m.status)),
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
        row("Ends", when(c.expiresAt)),
      ),
      h(
        "div",
        { class: "actions" },
        actions,
        (c.approvedProviderTypes ?? []).includes("PROFESSIONAL_SERVICES")
          ? h("a", {
              class: "btn",
              href: `#/missions/${id}/services`,
              text: "Find a service",
            })
          : null,
        (c.approvedProviderTypes ?? []).includes("WORKSPACE_PROVIDER")
          ? h("a", {
              class: "btn",
              href: `#/missions/${id}/workspaces`,
              text: "Find a workspace",
            })
          : null,
      ),
    ),
    recordsNav(id),
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
                  h("td", {
                    text: agentNames.get(a.agentId) ?? "Removed agent",
                  }),
                  h("td", { "data-label": "Category", text: a.category }),
                  h("td", {
                    "data-label": "Up to",
                    text: money(a.allocationMinor, c.currency),
                  }),
                  h("td", {}, badge(a.status)),
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

/**
 * Approvals center: every decision that is waiting for a person, in one place. Each card answers who wants to act, why, how much,
 * whether it is reversible and whether it creates a binding obligation, BEFORE the buttons.
 */
async function approvalsPage() {
  const out = h("div");
  const list = (await api("/v1/admin/org/missions")).data?.missions ?? [];
  const details = await Promise.all(
    list.map((m) => api(`/v1/admin/org/missions/${m.missionId}`)),
  );
  const cards = [];
  const reload = () => approvalsPage();
  list.forEach((m, i) => {
    const mission = details[i].data?.mission;
    if (!mission) return;
    if (m.status === "PENDING_OWNER_APPROVAL") {
      const c = mission.pendingContract ?? mission.latestContract;
      cards.push(
        h(
          "article",
          { class: "card" },
          h(
            "div",
            { class: "row" },
            h("h2", { text: "Put this mission to work?" }),
            badge(m.status),
          ),
          h(
            "dl",
            {},
            row(
              "Who wants to act",
              "The mission's agents, inside the limits below",
            ),
            row("Goal", c.objective),
            row(
              "Most it can ever commit",
              money(c.totalBudgetMinor, c.currency),
            ),
            row(
              "Largest single purchase",
              money(c.maxCommitmentMinor, c.currency),
            ),
            row(
              "You are asked first above",
              c.approvalConditions?.humanApprovalAboveMinor
                ? money(
                    c.approvalConditions.humanApprovalAboveMinor,
                    c.currency,
                  )
                : "every purchase",
            ),
            row(
              "Reversible?",
              "Yes. You can pause or revoke at any time; nothing already paid is undone.",
            ),
            row(
              "Creates a binding obligation?",
              "Not by approving. Each purchase or contract is decided under these limits.",
            ),
          ),
          mission.pendingReasons?.length
            ? h("p", {
                class: "hint",
                text: `Why it needs you: ${mission.pendingReasons.join(", ").toLowerCase().replaceAll("_", " ")}.`,
              })
            : null,
          h(
            "div",
            { class: "actions" },
            decide(
              "Approve",
              `/v1/admin/org/missions/${m.missionId}/approve`,
              {
                version: mission.pendingVersion,
                expectedRowVersion: mission.rowVersion,
              },
              true,
            ),
            decide(
              "Reject",
              `/v1/admin/org/missions/${m.missionId}/reject`,
              {
                version: mission.pendingVersion,
                expectedRowVersion: mission.rowVersion,
              },
              false,
              true,
            ),
            h("a", {
              class: "btn",
              href: `#/missions/${m.missionId}`,
              text: "Open mission",
            }),
          ),
        ),
      );
    }
  });
  const escalations = await Promise.all(
    list
      .filter((m) => m.status === "ACTIVE" || m.status === "PAUSED")
      .map(async (m, i) => {
        const r = await api(
          `/v1/admin/org/missions/${m.missionId}/acceptances`,
        );
        const c = details[list.indexOf(m)].data?.mission?.activeContract;
        return (r.data?.escalations ?? [])
          .filter((e) => e.status === "OPEN")
          .map((e) => ({ e, m, c }));
      }),
  );
  for (const { e, m, c } of escalations.flat()) {
    const snap = e.snapshot ?? {};
    const reason = h("input", {
      id: `why-${e.escalationId}`,
      maxlength: "300",
      "aria-label": "Reason, if you accept below the agent's floor",
    });
    cards.push(
      h(
        "article",
        { class: "card" },
        h(
          "div",
          { class: "row" },
          h("h2", {
            text:
              e.kind === "ACCEPTANCE_REQUEST"
                ? "Accept this quote?"
                : "Walk away from this negotiation?",
          }),
          h("span", { class: "label", text: "Waiting for you" }),
        ),
        h(
          "dl",
          {},
          row(
            "Who wants to act",
            `An agent (${e.requestedBy.replace(/^agent:/u, "")}) asked you to decide`,
          ),
          row("Why", e.reason),
          snap.totalMinor
            ? row(
                "Total",
                money(snap.totalMinor, snap.currency ?? c?.currency ?? "USD"),
              )
            : null,
          snap.hardFailures?.length
            ? row(
                "Cannot be accepted because",
                snap.hardFailures.join(", ").toLowerCase().replaceAll("_", " "),
              )
            : null,
          snap.softFailures?.length
            ? row(
                "Below the agent's floor on",
                snap.softFailures.join(", ").toLowerCase().replaceAll("_", " "),
              )
            : null,
          row(
            "Reversible?",
            e.kind === "ACCEPTANCE_REQUEST"
              ? "Until a purchase order is issued: you can withdraw the acceptance."
              : "Yes.",
          ),
          row(
            "Creates a binding obligation?",
            e.kind === "ACCEPTANCE_REQUEST"
              ? "It commits budget now. Nothing is paid until a purchase order is issued and paid inside the agent's authority."
              : "No.",
          ),
        ),
        snap.softFailures?.length
          ? h(
              "div",
              {},
              h("label", {
                for: reason.id,
                text: "Reason for accepting anyway",
              }),
              reason,
            )
          : null,
        h(
          "div",
          { class: "actions" },
          h(
            "button",
            {
              class: "primary",
              onclick: async () => {
                const r = await api(
                  `/v1/admin/org/escalations/${e.escalationId}/resolve`,
                  {
                    method: "POST",
                    body: {
                      decision: "ACCEPT",
                      ...(reason.value ? { overrideReason: reason.value } : {}),
                      idempotencyKey: idem("resolve"),
                    },
                  },
                );
                if (!r.ok)
                  return out.replaceChildren(
                    notice(
                      "bad",
                      `${reasonText(r.data?.reason)}${r.data?.detail ? " (" + r.data.detail + ")" : ""}`,
                    ),
                  );
                reload();
              },
            },
            "Accept",
          ),
          h(
            "button",
            {
              onclick: async () => {
                const r = await api(
                  `/v1/admin/org/escalations/${e.escalationId}/resolve`,
                  {
                    method: "POST",
                    body: {
                      decision: "DECLINE",
                      idempotencyKey: idem("resolve"),
                    },
                  },
                );
                if (!r.ok)
                  return out.replaceChildren(
                    notice("bad", reasonText(r.data?.reason)),
                  );
                reload();
              },
            },
            "Decline",
          ),
          h("a", {
            class: "btn",
            href: `#/missions/${m.missionId}`,
            text: "Open mission",
          }),
        ),
      ),
    );
  }
  function decide(label, path, body, primary, danger) {
    return h(
      "button",
      {
        class: primary ? "primary" : danger ? "danger" : "",
        onclick: async () => {
          const r = await api(path, { method: "POST", body });
          if (!r.ok)
            return out.replaceChildren(
              notice(
                "bad",
                `${reasonText(r.data?.reason)}${r.data?.detail ? " (" + r.data.detail + ")" : ""}`,
              ),
            );
          reload();
        },
      },
      label,
    );
  }
  shell(
    "#/approvals",
    h("h1", { text: "Approvals" }),
    out,
    cards.length === 0
      ? h(
          "div",
          { class: "card" },
          h("p", { text: "Nothing is waiting for you." }),
          h("p", {
            class: "hint",
            text: "When an agent needs a decision, or a mission needs your approval, it appears here with everything you need to decide.",
          }),
        )
      : cards,
  );
}

const PROBLEM_WORDS = {
  WRONG_CITY: "Different city",
  WRONG_KIND: "Not the kind of space you asked for",
  TOO_SMALL: "Too small",
  WRONG_CURRENCY: "Different currency",
  MISSING_AMENITY: "Missing something you need",
  NOT_AVAILABLE_FOR_STAY: "Not open for your dates",
  AVAILABILITY_UNKNOWN: "Availability not stated",
  ABOVE_EXPOSURE_LIMIT: "More at risk than your limit",
  EXPOSURE_UNKNOWN: "Total cost or deposit not stated",
  TERM_TOO_LONG: "Minimum term too long",
  STAY_SHORTER_THAN_MIN_TERM: "Your stay is shorter than their minimum term",
  TERM_UNKNOWN: "Minimum term not stated",
  CANCELLATION_UNKNOWN: "Cancellation terms not stated",
};
/** Workspace search and comparison (M51/M52). Observations only: nothing is booked, reserved, paid or signed here. */
async function workspacesPage(id) {
  const r = await api(`/v1/admin/org/missions/${id}`);
  if (!r.ok)
    return shell(
      "#/missions",
      h("h1", { text: "Mission not found" }),
      notice("bad", "That mission doesn't exist, or you can't see it."),
    );
  const c = r.data.mission.activeContract ?? r.data.mission.latestContract;
  const out = h("div");
  const results = h("div");
  const prior = await api(`/v1/admin/org/missions/${id}/workspaces`);
  const draw = (v) => {
    put(
      results,
      h("p", { class: "notice", role: "status", text: v.notice }),
      v.sourceKind === "SANDBOX_FIXTURE"
        ? h("p", {
            class: "notice bad",
            text: "These are fictional sandbox listings for testing. No live workspace source is connected.",
          })
        : null,
      v.results.length === 0
        ? h("p", { text: "The source returned nothing for that city." })
        : v.results.map(({ listing: l, assessment: a }) =>
            h(
              "article",
              { class: "card" },
              h(
                "div",
                { class: "row" },
                h("h2", { text: l.name }),
                h(
                  "span",
                  { class: "badge" },
                  glyph(a.qualified ? "bar-open" : "dot"),
                  a.qualified ? "Fits your needs" : "Does not fit yet",
                ),
              ),
              h(
                "dl",
                {},
                row(
                  "Space",
                  `${l.kind.replaceAll("_", " ").toLowerCase()} · up to ${l.capacity} people · ${l.locality.city}`,
                ),
                row(
                  "Rate",
                  `${money(l.rate.minor, l.rate.currency)} per ${l.rate.basis === "HOURLY" ? "hour" : l.rate.basis === "DAILY" ? "day" : "month"}`,
                ),
                row(
                  "Cost for your dates",
                  a.liability.totalCostMinor === null
                    ? "Not stated by the source"
                    : money(a.liability.totalCostMinor, a.liability.currency),
                ),
                row(
                  "Deposit held",
                  a.liability.depositMinor === null
                    ? "Not stated by the source"
                    : money(a.liability.depositMinor, a.liability.currency),
                ),
                row(
                  "Most at risk at once",
                  a.liability.maxExposureMinor === null
                    ? "Cannot be worked out"
                    : money(a.liability.maxExposureMinor, a.liability.currency),
                ),
                row(
                  "If you cancel on your date",
                  a.liability.cancellationExposureMinor === null
                    ? "Not stated by the source"
                    : money(
                        a.liability.cancellationExposureMinor,
                        a.liability.currency,
                      ),
                ),
                row(
                  "Source",
                  `${l.provenance.sourceId} · seen ${when(l.provenance.observedAt)}`,
                ),
              ),
              a.problems.length
                ? h(
                    "ul",
                    {},
                    a.problems.map((p) =>
                      h("li", { text: PROBLEM_WORDS[p] ?? p }),
                    ),
                  )
                : null,
              a.qualified
                ? h(
                    "div",
                    { class: "actions" },
                    h("button", {
                      type: "button",
                      text: "Propose a booking",
                      onclick: async () => {
                        const days = 7;
                        const res = await api(
                          `/v1/admin/org/missions/${id}/bookings`,
                          {
                            method: "POST",
                            body: {
                              searchId: v.searchId,
                              listingId: l.listingId,
                              deadline: new Date(
                                Date.now() + days * 86_400_000,
                              ).toISOString(),
                              idempotencyKey: idem("bk"),
                            },
                          },
                        );
                        if (!res.ok)
                          return out.replaceChildren(
                            notice("bad", reasonText(res.data?.reason)),
                          );
                        out.replaceChildren(
                          notice(
                            "ok",
                            "Proposed. Nothing is approved, reserved or paid yet. Review it under Bookings below.",
                          ),
                        );
                        await drawBookings();
                      },
                    }),
                  )
                : null,
            ),
          ),
    );
  };
  const bookings = h("div");
  const drawBookings = async () => {
    const r = await api(`/v1/admin/org/missions/${id}/bookings`);
    if (!r.ok) return put(bookings, notice("bad", reasonText(r.data?.reason)));
    put(
      bookings,
      h("h2", { text: "Bookings" }),
      r.data.bookings.length === 0
        ? h("p", { class: "hint", text: "No bookings proposed yet." })
        : r.data.bookings.map((b) => bookingCard(b, drawBookings, out)),
    );
  };
  await drawBookings();
  const latest = prior.data?.searches?.[0];
  if (latest) draw(latest);
  const form = h(
    "form",
    {
      class: "card",
      onsubmit: async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        const start = new Date(String(f.get("start")) + "T09:00:00.000Z");
        const end = new Date(String(f.get("end")) + "T17:00:00.000Z");
        const limit = Math.round(Number(f.get("limit")) * 100);
        const res = await api(`/v1/admin/org/missions/${id}/workspaces`, {
          method: "POST",
          body: {
            sourceId: String(f.get("source")),
            need: {
              country: String(f.get("country")).toUpperCase(),
              city: String(f.get("city")),
              kinds: ["DESK", "PRIVATE_OFFICE", "MEETING_ROOM", "EVENT_SPACE"],
              minCapacity: Number(f.get("people")),
              currency: c.currency,
              maxExposureMinor: limit,
              requiredAmenities: [],
            },
            stay: {
              start: start.toISOString(),
              end: end.toISOString(),
              people: Number(f.get("people")),
            },
            cancelAt: new Date(start.getTime() - 7 * 86_400_000).toISOString(),
            idempotencyKey: idem("ws"),
          },
        });
        if (!res.ok)
          return out.replaceChildren(
            notice(
              "bad",
              `${reasonText(res.data?.reason)}${res.data?.detail ? " (" + res.data.detail + ")" : ""}`,
            ),
          );
        out.replaceChildren();
        draw(res.data.search);
      },
    },
    h("h2", { text: "Find a workspace" }),
    field("country", "Country (2 letters)", "text", "off", "", {
      maxlength: "2",
      value: c.currency === "GBP" ? "GB" : "US",
    }),
    field("city", "City", "text"),
    field("people", "People", "number", "off", "", { min: "1", value: "4" }),
    field("start", "First day", "date"),
    field("end", "Last day", "date"),
    field(
      "limit",
      `Most you will have at risk at once (${c.currency})`,
      "number",
      "off",
      "Rent, fees and deposit together.",
      {
        min: "1",
        step: "0.01",
        value: String(Math.min(c.maxCommitmentMinor, 200000) / 100),
      },
    ),
    h(
      "div",
      {},
      h("label", { for: "f-source", text: "Source" }),
      h(
        "select",
        { id: "f-source", name: "source" },
        h("option", {
          value: "sandbox-workspaces",
          text: "Sandbox workspaces (fictional)",
        }),
      ),
    ),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", type: "submit" }, "Search"),
    ),
    h("p", {
      class: "hint",
      text: "A search only looks. It reserves nothing, books nothing and contacts no one.",
    }),
  );
  shell(
    "#/missions",
    h(
      "div",
      { class: "row" },
      h("h1", { text: "Workspaces" }),
      h("a", {
        class: "link",
        href: `#/missions/${id}`,
        text: "Back to mission",
      }),
    ),
    out,
    bookings,
    form,
    results,
  );
}

const SERVICE_PROBLEM_WORDS = {
  WRONG_CATEGORY: "Not the kind of service you asked for",
  WRONG_CURRENCY: "Different currency",
  PRICE_UNKNOWN: "Price not stated",
  ABOVE_PRICE_LIMIT: "More than your limit",
  DELIVERY_UNKNOWN: "Delivery time not stated",
  TOO_SLOW: "Takes longer than you want",
  REVISIONS_UNKNOWN: "Revisions not stated",
  TOO_FEW_REVISIONS: "Fewer revisions than you want",
  REFUND_TERMS_UNKNOWN: "Refund terms not stated",
  REFUND_TOO_SMALL: "Refunds less than you want if you cancel",
};
const SERVICE_CATEGORY_WORDS = {
  DESIGN: "Design",
  SOFTWARE: "Software",
  WRITING: "Writing",
  LEGAL_REVIEW: "Legal review",
  BOOKKEEPING: "Bookkeeping",
  MARKETING: "Marketing",
};
/** Services (M54): fixed-scope packages a source states. A search only looks; nothing is bought, engaged or paid. */
async function servicesPage(id) {
  const r = await api(`/v1/admin/org/missions/${id}`);
  if (!r.ok)
    return shell(
      "#/missions",
      h("h1", { text: "Mission not found" }),
      notice("bad", "That mission doesn't exist, or you can't see it."),
    );
  const c = r.data.mission.activeContract ?? r.data.mission.latestContract;
  const out = h("div");
  const results = h("div");
  const form = h(
    "form",
    {
      class: "card",
      onsubmit: async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        const res = await api(`/v1/admin/org/missions/${id}/services/search`, {
          method: "POST",
          body: {
            sourceId: "sandbox-services",
            need: {
              category: String(f.get("category")),
              currency: c.currency,
              maxPriceMinor: Math.round(Number(f.get("price")) * 100),
              maxDeliveryDays: Number(f.get("days")),
              minRevisions: Number(f.get("revisions")),
              minRefundBeforeStartBps: 0,
            },
          },
        });
        if (!res.ok) {
          put(results);
          return out.replaceChildren(
            notice(
              "bad",
              res.data?.reason === "PROVIDER_TYPE_NOT_APPROVED"
                ? "This mission was not approved to look at professional services."
                : reasonText(res.data?.reason),
            ),
          );
        }
        out.replaceChildren();
        const v = res.data;
        put(
          results,
          h("p", { class: "notice", role: "status", text: v.notice }),
          v.sourceKind === "SANDBOX_FIXTURE"
            ? h("p", {
                class: "notice bad",
                text: "These are fictional sandbox packages for testing. No live marketplace is connected.",
              })
            : null,
          v.results.length === 0
            ? h("p", { text: "The source returned nothing for that category." })
            : v.results.map(({ package: p, assessment: a }) =>
                h(
                  "article",
                  { class: "card" },
                  h(
                    "div",
                    { class: "row" },
                    h("h2", { text: p.title }),
                    h(
                      "span",
                      { class: "badge" },
                      glyph(a.qualified ? "bar-open" : "dot"),
                      a.qualified ? "Fits your needs" : "Does not fit yet",
                    ),
                  ),
                  h(
                    "dl",
                    {},
                    row("Provider", p.providerName),
                    row(
                      "Price",
                      a.priceMinor === null
                        ? "Not stated by the source"
                        : money(a.priceMinor, p.currency),
                    ),
                    row(
                      "Delivery",
                      p.deliveryDays === null
                        ? "Not stated by the source"
                        : `${p.deliveryDays} days`,
                    ),
                    row(
                      "Revisions included",
                      p.revisionsIncluded === null
                        ? "Not stated by the source"
                        : String(p.revisionsIncluded),
                    ),
                    row(
                      "Lost if you cancel before work starts",
                      a.lostIfCancelledBeforeStartMinor === null
                        ? "Cannot be worked out"
                        : money(a.lostIfCancelledBeforeStartMinor, p.currency),
                    ),
                    row("You would get", p.deliverables.join(", ")),
                  ),
                  a.problems.length
                    ? h(
                        "ul",
                        {},
                        a.problems.map((x) =>
                          h("li", { text: SERVICE_PROBLEM_WORDS[x] ?? x }),
                        ),
                      )
                    : null,
                ),
              ),
        );
      },
    },
    h("h2", { text: "Find a service" }),
    h(
      "div",
      {},
      h("label", { for: "f-category", text: "Kind of service" }),
      h(
        "select",
        { id: "f-category", name: "category" },
        Object.entries(SERVICE_CATEGORY_WORDS).map(([v, t]) =>
          h("option", { value: v, text: t }),
        ),
      ),
    ),
    field(
      "price",
      `Most you will pay (${c.currency})`,
      "number",
      "off",
      "For one package.",
      {
        min: "1",
        step: "0.01",
        value: String(Math.min(c.maxCommitmentMinor, 100000) / 100),
      },
    ),
    field("days", "Needed within (days)", "number", "off", "", {
      min: "1",
      value: "14",
    }),
    field("revisions", "Revisions you want", "number", "off", "", {
      min: "0",
      value: "1",
    }),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", type: "submit", text: "Search" }),
    ),
    h("p", {
      class: "hint",
      text: "A search only looks. It buys nothing, engages no one and contacts no one.",
    }),
  );
  shell(
    "#/missions",
    h(
      "div",
      { class: "row" },
      h("h1", { text: "Services" }),
      h("a", {
        class: "link",
        href: `#/missions/${id}`,
        text: "Back to mission",
      }),
    ),
    out,
    form,
    results,
  );
}

const BOOKING_STATE_WORDS = {
  PROPOSED: "Proposed",
  APPROVED: "Approved",
  HANDED_OFF: "Waiting for provider",
  UNKNOWN: "Outcome unclear",
  CONFIRMED: "Confirmed",
  DECLINED: "Not booked",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};
const EVIDENCE_WORDS = {
  PROVIDER_CONFIRMATION_REF: "Provider's own reference",
  DOCUMENT_REF: "A document I have",
  OWNER_ATTESTATION: "My word only",
};
/** One booking: what it says is bounded by evidence (the server's headline), and only the moves its state allows are offered. */
function bookingCard(b, redraw, out) {
  const act = async (op, body = {}) => {
    const res = await api(`/v1/admin/org/bookings/${b.bookingId}/${op}`, {
      method: "POST",
      body,
    });
    if (!res.ok)
      return out.replaceChildren(notice("bad", reasonText(res.data?.reason)));
    out.replaceChildren();
    await redraw();
  };
  const evidenceForm = (op, label) => {
    const f = h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const d = new FormData(f);
          const kind = String(d.get("kind"));
          const ref = String(d.get("ref")).trim();
          await act(op, {
            evidenceKind: kind,
            ...(ref ? { evidenceRef: ref } : {}),
          });
        },
      },
      h("label", { for: `k-${b.bookingId}-${op}`, text: "What shows it" }),
      h(
        "select",
        { id: `k-${b.bookingId}-${op}`, name: "kind" },
        Object.entries(EVIDENCE_WORDS).map(([v, t]) =>
          h("option", { value: v, text: t }),
        ),
      ),
      h("label", {
        for: `r-${b.bookingId}-${op}`,
        text: "Reference or document name",
      }),
      h("input", {
        id: `r-${b.bookingId}-${op}`,
        name: "ref",
        maxlength: "300",
      }),
      h("button", { class: "primary", type: "submit", text: label }),
    );
    return f;
  };
  const btn = (text, fn, cls = "") =>
    h("button", { type: "button", class: cls, text, onclick: fn });
  const live = ["APPROVED", "HANDED_OFF", "UNKNOWN"].includes(b.state);
  const actions = [];
  if (b.state === "PROPOSED")
    actions.push(
      btn("Approve and hold the budget", () => act("approve"), "primary"),
    );
  if (b.state === "APPROVED")
    actions.push(btn("I have asked the provider", () => act("handoff")));
  if (b.state === "HANDED_OFF")
    actions.push(btn("I'm not sure what happened", () => act("unknown")));
  if (["PROPOSED", ...["APPROVED", "HANDED_OFF", "UNKNOWN"]].includes(b.state))
    actions.push(btn("Not booking this", () => act("decline")));
  return h(
    "article",
    { class: "card" },
    h(
      "div",
      { class: "row" },
      h("h3", { text: b.listing.name }),
      h(
        "span",
        { class: "badge" },
        glyph(b.state === "CONFIRMED" ? "bar-open" : "dot"),
        b.state === "CONFIRMED" && b.evidence?.kind === "OWNER_ATTESTATION"
          ? "Confirmed by you"
          : (BOOKING_STATE_WORDS[b.state] ?? b.state),
      ),
    ),
    h("p", { text: b.headline }),
    h(
      "dl",
      {},
      row("Budget held now", money(b.heldMinor, b.frozen.currency)),
      row(
        "Deposit",
        {
          NOT_REQUIRED: "None required",
          NOT_PAID: "Not paid",
          PAID_CONFIRMED: "Paid, provider confirmed",
          PAID_UNCONFIRMED: "You say it was paid. No provider proof.",
          REFUNDED: "Refunded",
        }[b.deposit] ?? b.deposit,
      ),
      row("Needs a decision by", when(b.deadline)),
      b.evidence
        ? row(
            "Shown by",
            `${EVIDENCE_WORDS[b.evidence.kind]}${b.evidence.ref ? " · " + b.evidence.ref : ""}`,
          )
        : null,
    ),
    h("p", { class: "hint", text: b.notice }),
    actions.length ? h("div", { class: "actions" }, actions) : null,
    ["HANDED_OFF", "UNKNOWN"].includes(b.state)
      ? h(
          "details",
          {},
          h("summary", { text: "The provider confirmed it" }),
          evidenceForm("confirm", "Record the confirmation"),
        )
      : null,
    b.state === "CONFIRMED" && b.deposit !== "NOT_REQUIRED"
      ? h(
          "details",
          {},
          h("summary", { text: "Record the deposit" }),
          evidenceForm("deposit", "Record the deposit"),
        )
      : null,
    b.state === "CONFIRMED"
      ? h(
          "div",
          { class: "actions" },
          btn("Cancel this booking", () => {
            const f = h(
              "form",
              {
                onsubmit: async (e) => {
                  e.preventDefault();
                  const pen = Math.round(
                    Number(new FormData(f).get("penalty") || 0) * 100,
                  );
                  await act("cancel", { penaltyMinor: pen });
                },
              },
              h("label", {
                for: `c-${b.bookingId}`,
                text: `What the provider charges you for cancelling (${b.frozen.currency})`,
              }),
              h("input", {
                id: `c-${b.bookingId}`,
                name: "penalty",
                type: "number",
                min: "0",
                step: "0.01",
                value: "0",
              }),
              h("button", { class: "primary", type: "submit", text: "Cancel" }),
            );
            out.replaceChildren(f);
          }),
        )
      : null,
    live
      ? h("p", {
          class: "hint",
          text: "The budget stays held until this ends.",
        })
      : null,
  );
}

/**
 * Mission records: finance, sourcing quotes, negotiations, orders, disputes, contractors and obligations. One plain reader for server
 * records. It shows what the record says, in words, and never builds a claim of its own: state words come from the server's state.
 */
const SECTIONS = {
  finance: {
    title: "Finance",
    path: (id) => `/v1/admin/org/missions/${id}/ledger`,
    empty: "Nothing has been held or spent for this mission yet.",
    blurb:
      "Every amount PayFlow has set aside, committed or released for this mission. Held amounts count against your limits until they end.",
  },
  quotes: {
    title: "Sourcing and quotes",
    path: (id) => `/v1/admin/org/missions/${id}/quotes`,
    empty:
      "No quotes yet. Quotes are recorded only when a supplier states one. PayFlow never invents a supplier or a price.",
    blurb: "Quotes a supplier has stated, with what each would cost you.",
  },
  negotiations: {
    title: "Negotiations",
    path: (id) => `/v1/admin/org/missions/${id}/negotiations`,
    empty: "No negotiations have started.",
    blurb:
      "Offers and counter-offers. Nothing is accepted on your behalf without your approval.",
  },
  orders: {
    title: "Purchases and orders",
    path: (id) => `/v1/admin/org/missions/${id}/orders`,
    empty: "No orders have been placed.",
    blurb: "Purchases made under this mission and where each one stands.",
  },
  disputes: {
    title: "Disputes",
    path: (id) => `/v1/admin/org/missions/${id}/disputes`,
    empty: "No disputes are open.",
    blurb: "Problems with an order or a payment, and how they were settled.",
  },
  contractors: {
    title: "Contractors",
    path: (id) => `/v1/admin/org/missions/${id}/contracts`,
    empty: "No contractor work has been agreed.",
    blurb:
      "Agreed work, deliverables and payments. A payment is released only after you accept the deliverable.",
  },
  obligations: {
    title: "Obligations",
    path: (id) => `/v1/admin/org/missions/${id}/obligations`,
    empty: "Nothing is owed or awaited.",
    blurb: "Things you are owed or must do, such as refunds and deliveries.",
  },
};
const humanKey = (k) =>
  k
    .replace(/Minor$/u, "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^./u, (c) => c.toUpperCase());
const HIDE_KEY =
  /^(rowVersion|notice|idempotencyKey|organizationId|environment|hash|digest|signature|.*Hash|.*Digest)$/u;
const STATE_KEYS = ["state", "status", "stage", "decision"];
const TITLE_KEYS = [
  "name",
  "title",
  "vendorName",
  "supplier",
  "description",
  "objective",
  "kind",
  "type",
];
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d/u;
const wordsOf = (v) =>
  String(v)
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^./u, (c) => c.toUpperCase());
function scalarRows(obj, cur) {
  const rows = [];
  for (const [k, v] of Object.entries(obj)) {
    if (HIDE_KEY.test(k) || STATE_KEYS.includes(k) || k === "currency")
      continue;
    if (v === null || v === undefined || v === "") continue;
    if (/Id$/u.test(k) && typeof v === "string") continue;
    let shown;
    if (typeof v === "number" && /Minor$/u.test(k))
      shown = money(v, cur ?? obj.currency ?? "USD");
    else if (typeof v === "boolean") shown = v ? "Yes" : "No";
    else if (typeof v === "number") shown = String(v);
    else if (typeof v === "string" && ISO.test(v)) shown = when(v);
    else if (typeof v === "string")
      shown = /^[A-Z0-9_]+$/u.test(v) ? wordsOf(v) : v.slice(0, 300);
    else if (Array.isArray(v))
      shown = `${v.length} item${v.length === 1 ? "" : "s"}`;
    else continue;
    rows.push(row(humanKey(k), shown));
  }
  return rows;
}
function recordCard(rec, cur, extra) {
  const stateKey = STATE_KEYS.find((k) => typeof rec[k] === "string");
  const titleKey = TITLE_KEYS.find((k) => typeof rec[k] === "string" && rec[k]);
  return h(
    "article",
    { class: "card" },
    h(
      "div",
      { class: "row" },
      h("h3", {
        text: titleKey ? wordsOf(rec[titleKey]).slice(0, 120) : "Record",
      }),
      stateKey
        ? h("span", { class: "badge" }, glyph("dot"), wordsOf(rec[stateKey]))
        : null,
    ),
    h("dl", {}, scalarRows(rec, cur)),
    extra ?? null,
  );
}
const GROUND_WORDS = {
  DAMAGED: "It arrived damaged",
  WRONG_ITEM: "Wrong item",
  SHORT_DELIVERY: "Fewer than ordered",
  OVER_DELIVERY: "More than ordered",
  NOT_DELIVERED_LATE: "Not delivered, or very late",
};
/** Decisions a person can make from a record. Every one calls the same route the API exposes; the server decides, this only asks. */
function recordActions(key, rec, redraw, out, cur) {
  const ask = async (path, body) => {
    const r = await api(path, { method: "POST", body });
    if (!r.ok)
      return out.replaceChildren(notice("bad", reasonText(r.data?.reason)));
    out.replaceChildren();
    await redraw();
  };
  if (key === "negotiations") {
    const f = h(
      "form",
      {
        onsubmit: (e) => e.preventDefault(),
      },
      h("label", {
        for: `nr-${rec.negotiationId}`,
        text: "Your reason (optional)",
      }),
      h("input", {
        id: `nr-${rec.negotiationId}`,
        name: "reason",
        maxlength: "300",
      }),
    );
    const reason = () => String(new FormData(f).get("reason") ?? "");
    const base = `/v1/admin/org/negotiations/${rec.negotiationId}`;
    const btns = [];
    if (rec.pending)
      btns.push(
        h("button", {
          type: "button",
          class: "primary",
          text: `Approve version ${rec.pending.version}`,
          onclick: () =>
            ask(`${base}/versions/${rec.pending.version}/approve`, {
              reason: reason(),
            }),
        }),
        h("button", {
          type: "button",
          text: `Reject version ${rec.pending.version}`,
          onclick: () =>
            ask(`${base}/versions/${rec.pending.version}/reject`, {
              reason: reason(),
            }),
        }),
      );
    if (!rec.revoked && rec.inForce)
      btns.push(
        h("button", {
          type: "button",
          text: "Withdraw the rules in force",
          onclick: () => ask(`${base}/revoke`, { reason: reason() }),
        }),
      );
    return btns.length
      ? h("div", {}, f, h("div", { class: "actions" }, btns))
      : null;
  }
  if (key === "contractors") {
    const blocks = [];
    for (const ms of rec.milestones ?? []) {
      const subs = (ms.deliverables ?? []).filter(
        (d) => d.status === "SUBMITTED",
      );
      blocks.push(
        h(
          "section",
          {},
          h("h4", {
            text: `Milestone ${ms.index}: ${wordsOf(ms.state)}`,
          }),
          h("dl", {}, scalarRows(ms, cur)),
          (ms.deliverables ?? []).length === 0
            ? h("p", { class: "hint", text: "Nothing has been submitted yet." })
            : h(
                "ul",
                {},
                ms.deliverables.map((d) =>
                  h("li", {
                    text: `${wordsOf(d.status)}${d.decisionNote ? ": " + d.decisionNote : ""}`,
                  }),
                ),
              ),
          subs.map((d) => {
            const f = h(
              "form",
              {
                onsubmit: async (e) => {
                  e.preventDefault();
                  const x = new FormData(f);
                  const ref = String(x.get("ref")).trim();
                  await ask(
                    `/v1/admin/org/deliverables/${d.deliverableId}/decide`,
                    {
                      decision: String(x.get("decision")),
                      evidenceKind: String(x.get("kind")),
                      ...(ref ? { evidenceRef: ref } : {}),
                      note: String(x.get("note")),
                    },
                  );
                },
              },
              h("label", {
                for: `dd-${d.deliverableId}`,
                text: "Your decision on the submitted work",
              }),
              h(
                "select",
                { id: `dd-${d.deliverableId}`, name: "decision" },
                h("option", { value: "ACCEPT", text: "Accept it" }),
                h("option", { value: "REJECT", text: "Reject it" }),
              ),
              h("label", {
                for: `dk-${d.deliverableId}`,
                text: "What shows it",
              }),
              h(
                "select",
                { id: `dk-${d.deliverableId}`, name: "kind" },
                h("option", {
                  value: "OWNER_ATTESTATION",
                  text: "My word only",
                }),
                h("option", {
                  value: "DOCUMENT_REF",
                  text: "A document I have",
                }),
              ),
              h("label", {
                for: `dr-${d.deliverableId}`,
                text: "Document name or link (if any)",
              }),
              h("input", {
                id: `dr-${d.deliverableId}`,
                name: "ref",
                maxlength: "500",
              }),
              h("label", {
                for: `dn-${d.deliverableId}`,
                text: "A short note",
              }),
              h("input", {
                id: `dn-${d.deliverableId}`,
                name: "note",
                maxlength: "300",
              }),
              h("button", {
                class: "primary",
                type: "submit",
                text: "Record my decision",
              }),
              h("p", {
                class: "hint",
                text: "Accepting only records that the work is acceptable. It pays nothing by itself.",
              }),
            );
            return f;
          }),
        ),
      );
    }
    return blocks.length ? h("div", {}, blocks) : null;
  }
  if (key === "orders") {
    const f = h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const d = new FormData(f);
          await ask(`/v1/admin/org/orders/${rec.orderId}/disputes`, {
            ground: String(d.get("ground")),
            claimedMinor: Math.round(Number(d.get("amount")) * 100),
            reason: String(d.get("reason")),
            idempotencyKey: idem("dp"),
          });
        },
      },
      h("label", { for: `dg-${rec.orderId}`, text: "What went wrong" }),
      h(
        "select",
        { id: `dg-${rec.orderId}`, name: "ground" },
        Object.entries(GROUND_WORDS).map(([v, t]) =>
          h("option", { value: v, text: t }),
        ),
      ),
      h("label", {
        for: `da-${rec.orderId}`,
        text: `Amount you say you are owed (${cur})`,
      }),
      h("input", {
        id: `da-${rec.orderId}`,
        name: "amount",
        type: "number",
        min: "0.01",
        step: "0.01",
        required: true,
      }),
      h("label", { for: `drs-${rec.orderId}`, text: "Tell us what happened" }),
      h("input", {
        id: `drs-${rec.orderId}`,
        name: "reason",
        maxlength: "500",
        required: true,
      }),
      h("button", { type: "submit", text: "Open a dispute" }),
      h("p", {
        class: "hint",
        text: "A dispute is a claim. Only you resolve it, and a refund is recorded only with proof.",
      }),
    );
    return h(
      "details",
      {},
      h("summary", { text: "Something wrong with this order?" }),
      f,
    );
  }
  return null;
}
async function recordsPage(id, key) {
  const sec = SECTIONS[key];
  const mission = await api(`/v1/admin/org/missions/${id}`);
  if (!mission.ok)
    return shell(
      "#/missions",
      h("h1", { text: "Mission not found" }),
      notice("bad", "That mission doesn't exist, or you can't see it."),
    );
  const r = await api(sec.path(id));
  const c =
    mission.data.mission.activeContract ?? mission.data.mission.latestContract;
  const cur = c?.currency ?? "USD";
  const out = h("div");
  const redraw = () => recordsPage(id, key);
  const body = [];
  if (!r.ok)
    body.push(
      notice(
        "bad",
        r.status === 403
          ? reasonText("PERMISSION_DENIED")
          : reasonText(r.data?.reason),
      ),
    );
  else {
    const d = r.data;
    if (d.summary && typeof d.summary === "object")
      body.push(
        h(
          "section",
          { class: "card" },
          h("h2", { text: "Where the money stands" }),
          h("dl", {}, scalarRows(d.summary, cur)),
        ),
      );
    const listKey = Object.keys(d).find(
      (k) => Array.isArray(d[k]) && k !== "warnings",
    );
    const items = listKey ? d[listKey] : [];
    body.push(
      items.length === 0
        ? h("p", { class: "hint", text: sec.empty })
        : items.map((rec) =>
            recordCard(rec, cur, recordActions(key, rec, redraw, out, cur)),
          ),
    );
  }
  shell(
    "#/missions",
    h(
      "div",
      { class: "row" },
      h("h1", { text: sec.title }),
      h("a", {
        class: "link",
        href: `#/missions/${id}`,
        text: "Back to mission",
      }),
    ),
    h("p", { text: sec.blurb }),
    out,
    key === "finance"
      ? h(
          "div",
          { class: "actions" },
          h("button", {
            type: "button",
            text: "Download for your bookkeeper (CSV)",
            onclick: async () => {
              const x = await api(`/v1/admin/org/missions/${id}/ledger/export`);
              if (!x.ok)
                return out.replaceChildren(
                  notice("bad", reasonText(x.data?.reason)),
                );
              const a = h("a", {
                href: URL.createObjectURL(
                  new Blob([x.data.csv], { type: "text/csv" }),
                ),
                download: x.data.filename,
              });
              document.body.append(a);
              a.click();
              a.remove();
              out.replaceChildren(notice("ok", x.data.notice));
            },
          }),
        )
      : null,
    ...body.flat(),
  );
}
function recordsNav(id) {
  return h(
    "section",
    { class: "card", "aria-labelledby": "rec" },
    h("h2", { id: "rec", text: "Records" }),
    h(
      "ul",
      { class: "plain" },
      Object.entries(SECTIONS).map(([k, v]) =>
        h(
          "li",
          {},
          h("a", {
            class: "link",
            href: `#/missions/${id}/${k}`,
            text: v.title,
          }),
        ),
      ),
      h(
        "li",
        {},
        h("a", {
          class: "link",
          href: `#/missions/${id}/proof`,
          text: "Proof: the history of every change",
        }),
      ),
    ),
  );
}
/** Proof: the append-only record of every change to this mission's budget. It is read from the ledger's history, not summarised. */
async function proofPage(id) {
  const items = await api(`/v1/admin/org/missions/${id}/ledger`);
  const list = items.data?.items ?? [];
  const blocks = [];
  for (const it of list.slice(0, 20)) {
    const hist = await api(`/v1/admin/org/ledger/items/${it.itemId}/history`);
    blocks.push(
      h(
        "section",
        { class: "card" },
        h("h2", { text: wordsOf(it.kind ?? "Item") }),
        h("dl", {}, scalarRows(it, it.currency)),
        h(
          "ol",
          {},
          (hist.data?.entries ?? []).map((e) =>
            h(
              "li",
              {},
              `${when(e.at)} · ${e.from ? wordsOf(e.from) + " to " : ""}${wordsOf(e.to)} · ${money(e.amountMinor, it.currency ?? "USD")} · by ${wordsOf(e.actorKind)} · ${e.evidenceKind && e.evidenceKind !== "NONE" ? "evidence: " + wordsOf(e.evidenceKind) : "no evidence attached"}`,
            ),
          ),
        ),
      ),
    );
  }
  shell(
    "#/missions",
    h(
      "div",
      { class: "row" },
      h("h1", { text: "Proof" }),
      h("a", {
        class: "link",
        href: `#/missions/${id}`,
        text: "Back to mission",
      }),
    ),
    h("p", {
      text: "Each change to this mission's budget is written once and never edited. This is that record, not a summary of it.",
    }),
    ...(blocks.length
      ? blocks
      : [h("p", { class: "hint", text: "Nothing has been recorded yet." })]),
  );
}
/**
 * Needs checking (M71): everything whose outcome PayFlow could not see, in one place. PayFlow never retries these and never guesses; each one
 * is settled by a person with what they know. Nothing here is hidden when it is unpleasant.
 */
async function checkingPage() {
  const ms = (await api("/v1/admin/org/missions")).data?.missions ?? [];
  const unclearBookings = [];
  for (const m of ms.slice(0, 25)) {
    const r = await api(`/v1/admin/org/missions/${m.missionId}/bookings`);
    for (const b of r.data?.bookings ?? [])
      if (b.state === "UNKNOWN") unclearBookings.push({ m, b });
  }
  const jobsR = await api("/v1/admin/org/automation/jobs");
  const unclearJobs = (jobsR.data?.jobs ?? []).filter(
    (j) => j.state === "UNKNOWN",
  );
  const out = h("div");
  const settleJob = (j) => {
    const f = h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const d = new FormData(f);
          const r = await api(
            `/v1/admin/org/automation/jobs/${j.jobId}/settle`,
            {
              method: "POST",
              body: {
                outcome: String(d.get("outcome")),
                note: String(d.get("note")),
              },
            },
          );
          if (!r.ok)
            return out.replaceChildren(
              notice("bad", reasonText(r.data?.reason)),
            );
          await checkingPage();
        },
      },
      h("label", { for: `jo-${j.jobId}`, text: "What actually happened" }),
      h(
        "select",
        { id: `jo-${j.jobId}`, name: "outcome" },
        h("option", { value: "SUCCEEDED", text: "It was done" }),
        h("option", { value: "FAILED", text: "It was not done" }),
      ),
      h("label", { for: `jn-${j.jobId}`, text: "How do you know?" }),
      h("input", {
        id: `jn-${j.jobId}`,
        name: "note",
        maxlength: "300",
        required: true,
      }),
      h("button", { class: "primary", type: "submit", text: "Settle" }),
    );
    return f;
  };
  shell(
    "#/checking",
    h("h1", { text: "Needs checking" }),
    h("p", {
      text: "These are things where PayFlow cannot tell what happened. It will not try again or guess. The money involved stays set aside until you settle them.",
    }),
    out,
    unclearBookings.length === 0 && unclearJobs.length === 0
      ? h("p", { text: "Nothing needs checking." })
      : null,
    unclearBookings.map(({ m, b }) =>
      h(
        "article",
        { class: "card" },
        h("h3", { text: b.listing.name }),
        h("p", { text: b.headline }),
        h(
          "dl",
          {},
          row("Money set aside", money(b.heldMinor, b.frozen.currency)),
        ),
        h("a", {
          class: "link",
          href: `#/missions/${m.missionId}/workspaces`,
          text: "Open the booking",
        }),
      ),
    ),
    unclearJobs.map((j) =>
      h(
        "article",
        { class: "card" },
        h("h3", { text: wordsOf(j.kind) }),
        h("p", { text: j.note ?? "The outcome is not known." }),
        settleJob(j),
      ),
    ),
  );
}
async function notificationsPage() {
  const r = await api("/v1/admin/org/missions");
  const ms = r.data?.missions ?? [];
  const waiting = ms.filter((m) =>
    ["PENDING_APPROVAL", "DRAFT"].includes(m.status),
  );
  shell(
    "#/notifications",
    h("h1", { text: "Notifications" }),
    h("p", {
      class: "notice",
      role: "status",
      text: "PayFlow shows what needs you here. It does not send email or phone alerts yet, so check back, or open Approvals.",
    }),
    ...(waiting.length === 0
      ? [h("p", { text: "Nothing needs you right now." })]
      : waiting.map((m) =>
          h(
            "article",
            { class: "card" },
            h("h3", { text: m.objective ?? "Mission" }),
            h("p", { text: `${wordsOf(m.status)}.` }),
            h("a", {
              class: "link",
              href: `#/missions/${m.missionId}`,
              text: "Open",
            }),
          ),
        )),
    h("a", { class: "link", href: "#/approvals", text: "Go to Approvals" }),
  );
}
async function settingsPage() {
  shell(
    "#/settings",
    h("h1", { text: "Settings" }),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "Your account" }),
      h(
        "dl",
        {},
        row("Name", state.me.user.displayName),
        row("Role", wordsOf(state.me.member.role)),
        row("Environment", "Sandbox. No real money moves."),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "Your agents" }),
      h("a", { class: "link", href: "#/agents", text: "Manage agents" }),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "Sign out" }),
      h("button", {
        type: "button",
        text: "Sign out of this browser",
        onclick: async () => {
          await api("/v1/app/logout", { method: "POST", body: {} });
          state.me = null;
          state.csrf = null;
          location.hash = "#/login";
          await render();
        },
      }),
    ),
  );
}
function helpPage() {
  const T = (term, text) =>
    h("div", { class: "row" }, h("dt", { text: term }), h("dd", { text }));
  shell(
    "#/help",
    h("h1", { text: "Help" }),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "What PayFlow will never do" }),
      h(
        "ul",
        {},
        h("li", {
          text: "Spend more than you approved, or spend without your approval.",
        }),
        h("li", {
          text: "Say something is booked, paid or confirmed without evidence.",
        }),
        h("li", { text: "Invent a supplier, a price, a booking or a review." }),
        h("li", {
          text: "Try again after an unclear result. A person decides.",
        }),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "Words you will see" }),
      h(
        "dl",
        {},
        T(
          "Held",
          "Money set aside for a purchase. It counts against your limit until it ends.",
        ),
        T("Committed", "A provider has confirmed. The money is owed."),
        T(
          "Outcome unclear",
          "We cannot tell what happened. The money stays held until you settle it with evidence.",
        ),
        T(
          "Confirmed by you",
          "You told us it is confirmed. PayFlow has no proof of its own.",
        ),
        T(
          "Sandbox",
          "A safe test setting. Nothing real is bought, booked or paid.",
        ),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "Need to talk to someone?" }),
      h("p", {
        text: "There is no live support channel connected to this sandbox yet.",
      }),
    ),
  );
}

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
    if (hash === "#/approvals") return await approvalsPage();
    if (hash === "#/missions") return await missionList();
    if (hash === "#/missions/new") return await wizard();
    if (hash === "#/launch") return launchPage();
    if (hash === "#/checking") return await checkingPage();
    if (hash === "#/notifications") return await notificationsPage();
    if (hash === "#/settings") return await settingsPage();
    if (hash === "#/help") return helpPage();
    const sec = /^#\/missions\/(msn_[a-f0-9]{24})\/([a-z]+)$/.exec(hash);
    if (sec && sec[2] === "proof") return await proofPage(sec[1]);
    if (sec && sec[2] === "services") return await servicesPage(sec[1]);
    if (sec && SECTIONS[sec[2]]) return await recordsPage(sec[1], sec[2]);
    const w = /^#\/missions\/(msn_[a-f0-9]{24})\/workspaces$/.exec(hash);
    if (w) return await workspacesPage(w[1]);
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
