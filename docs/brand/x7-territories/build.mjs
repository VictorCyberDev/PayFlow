// Generates the X7 comparison boards: three identity systems applied to the SAME screens.
// Usage: node docs/brand/x7-territories/build.mjs  (then render with the screenshot script)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const fonts = join(here, "../../../apps/console/node_modules");
const ff = (family, pkg, file, weight = "100 900") =>
  `@font-face{font-family:"${family}";src:url("file://${fonts}/${pkg}/files/${file}") format("woff2");font-weight:${weight};font-display:block}`;
const fontCss = [
  ff(
    "Bricolage Grotesque",
    "@fontsource-variable/bricolage-grotesque",
    "bricolage-grotesque-latin-wght-normal.woff2",
    "200 800",
  ),
  ff(
    "Instrument Sans",
    "@fontsource-variable/instrument-sans",
    "instrument-sans-latin-wght-normal.woff2",
    "400 700",
  ),
  ff(
    "Plex Mono",
    "@fontsource/ibm-plex-mono",
    "ibm-plex-mono-latin-400-normal.woff2",
    "400",
  ),
  ff(
    "Fraunces",
    "@fontsource-variable/fraunces",
    "fraunces-latin-wght-normal.woff2",
    "100 900",
  ),
  ff(
    "Plex Sans",
    "@fontsource-variable/ibm-plex-sans",
    "ibm-plex-sans-latin-wght-normal.woff2",
    "100 700",
  ),
  ff(
    "Space Grotesk",
    "@fontsource-variable/space-grotesk",
    "space-grotesk-latin-wght-normal.woff2",
    "300 700",
  ),
].join("\n");

const T = {
  t1: {
    name: "T1 · Crop Mark",
    tag: "Frame = crop marks. Gate = a break in the line. Ink, paper, amber.",
  },
  t2: {
    name: "T2 · Ledger",
    tag: "Frame = double-ruled ledger box. Gate = seal. Cream, oxblood, serif amounts.",
  },
  t3: {
    name: "T3 · Blueprint",
    tag: "Frame = dimensioned drawing. Gate = bar. Cool grey, cobalt, grid.",
  },
};

const css = `
${fontCss}
*{box-sizing:border-box}body{margin:0;background:#888}
.board{width:1500px;padding:28px;position:relative}
.board h2{margin:0 0 4px;font:600 22px/1.2 system-ui}.board .tag{margin:0 0 18px;font:14px system-ui;opacity:.8}
.grid{display:grid;grid-template-columns:520px 360px 520px;gap:24px;align-items:start}
.col{display:grid;gap:18px}.cap{font:11px/1.2 system-ui;letter-spacing:.08em;text-transform:uppercase;opacity:.6;margin:0 0 6px}
.screen{padding:22px;position:relative}.phone{width:340px;padding:18px;position:relative}
.row{display:flex;align-items:center;gap:12px}.sp{flex:1}
.amount{font-variant-numeric:tabular-nums lining-nums}
.btn{display:inline-block;padding:11px 16px;font-size:14px;font-weight:600}
.meta{font-size:12px}.lbl{font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.glyph{width:34px;height:34px;flex:none}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px}dt{opacity:.6}dd{margin:0}
.act{padding:12px 0}.act+.act{border-top:1px solid var(--rule)}
.act .t{font-weight:600}.act .s{font-size:12.5px;opacity:.75}
.proof{font:12px/1.55 var(--mono);white-space:pre-wrap}
.bar{height:6px;margin:10px 0 6px;position:relative}.bar i{position:absolute;inset:0 auto 0 0}

/* ---------- T1 CROP MARK ---------- */
.t1{--ink:#12161B;--paper:#F2EFE6;--surf:#FBFAF6;--sig:#F5B301;--rule:rgba(18,22,27,.16);--mono:"Plex Mono",monospace;background:var(--paper);color:var(--ink);font-family:"Instrument Sans",system-ui}
.t1 .board h2,.t1 h2,.t1 h3,.t1 .amount,.t1 .big{font-family:"Bricolage Grotesque",system-ui}
.t1 .big{font-size:56px;line-height:.95;font-weight:700;letter-spacing:-.03em}
.t1 .screen,.t1 .phone{background:var(--surf);border:1px solid var(--rule)}
.t1 .frame{position:relative;padding:22px 22px 18px;margin:12px 0 6px}
.t1 .frame:before,.t1 .frame:after,.t1 .frame i.a,.t1 .frame i.b{content:"";position:absolute;width:14px;height:14px;border:2px solid var(--ink)}
.t1 .frame:before{left:-6px;top:-6px;border-right:0;border-bottom:0}
.t1 .frame:after{right:-6px;bottom:-6px;border-left:0;border-top:0}
.t1 .frame i.a{right:-6px;top:-6px;border-left:0;border-bottom:0}
.t1 .frame i.b{left:-6px;bottom:-6px;border-right:0;border-top:0}
.t1 .frame .gate{position:absolute;right:-6px;top:46%;width:12px;height:30px;background:var(--surf);border-left:2px solid var(--ink);border-right:2px solid var(--ink)}
.t1 .flow{height:0;border-top:2px dashed var(--ink);position:absolute;left:-60px;right:calc(100% - 0px);top:calc(46% + 15px);width:56px}
.t1 .flow.solid{border-top-style:solid;border-color:var(--sig)}
.t1 .btn{background:var(--ink);color:var(--paper)}.t1 .btn.alt{background:var(--sig);color:var(--ink)}
.t1 .bar{background:rgba(18,22,27,.1)}.t1 .bar i{background:var(--ink)}
.t1 .pill{border:1.5px solid var(--ink);padding:2px 8px;font-size:11px;font-weight:700;letter-spacing:.06em}
.t1 .hero{padding:36px 30px;background:var(--ink);color:var(--paper)}.t1 .hero .big{color:var(--paper)}
.t1 .hero .sig{color:var(--sig)}
.t1 .nav{display:flex;gap:18px;font-size:13px;font-weight:600;padding-bottom:14px;border-bottom:1px solid var(--rule);margin-bottom:16px}.t1 .nav b{border-bottom:3px solid var(--sig)}

/* ---------- T2 LEDGER ---------- */
.t2{--ink:#221A18;--paper:#F6F1E7;--surf:#FCF9F2;--sig:#6E1F2F;--rule:rgba(34,26,24,.25);--mono:"Plex Mono",monospace;background:var(--paper);color:var(--ink);font-family:"Plex Sans",system-ui}
.t2 h2,.t2 h3,.t2 .amount,.t2 .big{font-family:"Fraunces",Georgia,serif;font-weight:500}
.t2 .big{font-size:54px;line-height:1;letter-spacing:-.02em}
.t2 .screen,.t2 .phone{background:var(--surf);border:1px solid var(--rule)}
.t2 .frame{border:1px solid var(--ink);outline:1px solid var(--ink);outline-offset:3px;padding:20px;margin:10px 4px 8px;position:relative}
.t2 .frame .gate{position:absolute;right:16px;top:16px;width:34px;height:34px;border-radius:50%;border:1.5px solid var(--sig);display:grid;place-items:center;color:var(--sig);font-size:10px;font-weight:700;transform:rotate(-12deg)}
.t2 .frame i.a,.t2 .frame i.b{display:none}
.t2 .flow{display:none}
.t2 .btn{background:var(--sig);color:#fff;border-radius:2px}.t2 .btn.alt{background:transparent;color:var(--sig);border:1px solid var(--sig)}
.t2 .bar{background:repeating-linear-gradient(90deg,var(--rule) 0 2px,transparent 2px 6px)}.t2 .bar i{background:var(--sig);height:3px;top:1px}
.t2 .pill{border:1px solid var(--sig);color:var(--sig);padding:2px 8px;font-size:11px;font-style:italic}
.t2 .hero{padding:36px 30px;background:var(--surf);border-top:3px double var(--ink);border-bottom:3px double var(--ink)}
.t2 .hero .sig{color:var(--sig)}
.t2 .nav{display:flex;gap:18px;font:italic 15px Fraunces,serif;padding-bottom:10px;border-bottom:3px double var(--ink);margin-bottom:16px}.t2 .nav b{color:var(--sig)}
.t2 .act{border-bottom:1px dotted var(--ink)}.t2 .act+.act{border-top:0}

/* ---------- T3 BLUEPRINT ---------- */
.t3{--ink:#0F1B3D;--paper:#E8EDF3;--surf:#F6F8FB;--sig:#1B3FD6;--rule:rgba(27,63,214,.28);--mono:"Plex Mono",monospace;background:var(--paper);color:var(--ink);font-family:"Space Grotesk",system-ui}
.t3 h2,.t3 h3,.t3 .amount,.t3 .big{font-family:"Space Grotesk",system-ui;font-weight:600}
.t3 .big{font-size:52px;line-height:1;letter-spacing:-.03em}
.t3 .screen,.t3 .phone{background:var(--surf) repeating-linear-gradient(0deg,transparent 0 23px,rgba(27,63,214,.06) 23px 24px),repeating-linear-gradient(90deg,transparent 0 23px,rgba(27,63,214,.06) 23px 24px);border:1px solid var(--rule);border-radius:6px}
.t3 .frame{border:1.5px solid var(--sig);padding:20px;margin:16px 0 22px;position:relative;border-radius:2px}
.t3 .frame .gate{position:absolute;right:-1px;top:30%;width:5px;height:36px;background:var(--surf);border-top:1.5px solid var(--sig);border-bottom:1.5px solid var(--sig)}
.t3 .frame i.a{position:absolute;left:0;right:0;bottom:-14px;border-top:1px solid var(--sig);height:0}
.t3 .frame i.b{position:absolute;left:0;right:0;bottom:-24px;font:10px var(--mono);color:var(--sig);text-align:center;height:auto}
.t3 .flow{display:none}
.t3 .btn{background:var(--sig);color:#fff;border-radius:4px}.t3 .btn.alt{background:transparent;color:var(--sig);border:1.5px solid var(--sig)}
.t3 .bar{background:rgba(27,63,214,.12)}.t3 .bar i{background:var(--sig)}
.t3 .pill{background:var(--sig);color:#fff;padding:2px 8px;font-size:11px;border-radius:3px}
.t3 .hero{padding:36px 30px;background:var(--sig);color:#fff;border-radius:6px}.t3 .hero .big{color:#fff}
.t3 .hero .sig{color:#B8C7FF}
.t3 .nav{display:flex;gap:18px;font-size:13px;font-weight:600;padding-bottom:14px;border-bottom:1px solid var(--rule);margin-bottom:16px}.t3 .nav b{color:var(--sig)}
`;

// State glyphs (three Gate states). Each territory draws them in its own idiom.
const glyph = (t, kind) => {
  const s = { t1: "#12161B", t2: "#6E1F2F", t3: "#1B3FD6" }[t],
    a = "#F5B301";
  if (t === "t1")
    return {
      paid: `<svg class="glyph" viewBox="0 0 34 34"><rect x="3" y="3" width="28" height="28" fill="${s}"/></svg>`,
      blocked: `<svg class="glyph" viewBox="0 0 34 34"><rect x="3" y="3" width="28" height="28" fill="none" stroke="${s}" stroke-width="2.5"/><rect x="3" y="14" width="28" height="6" fill="${s}"/></svg>`,
      unknown: `<svg class="glyph" viewBox="0 0 34 34"><rect x="3" y="3" width="28" height="28" fill="none" stroke="${s}" stroke-width="2.5" stroke-dasharray="5 4"/><circle cx="17" cy="17" r="4" fill="${a}" stroke="${s}" stroke-width="1.5"/></svg>`,
    }[kind];
  if (t === "t2")
    return {
      paid: `<svg class="glyph" viewBox="0 0 34 34"><circle cx="17" cy="17" r="13" fill="${s}"/></svg>`,
      blocked: `<svg class="glyph" viewBox="0 0 34 34"><circle cx="17" cy="17" r="13" fill="none" stroke="${s}" stroke-width="2"/><path d="M8 17h18" stroke="${s}" stroke-width="3"/></svg>`,
      unknown: `<svg class="glyph" viewBox="0 0 34 34"><circle cx="17" cy="17" r="13" fill="none" stroke="${s}" stroke-width="2" stroke-dasharray="3 4"/></svg>`,
    }[kind];
  return {
    paid: `<svg class="glyph" viewBox="0 0 34 34"><path d="M4 17h26" stroke="${s}" stroke-width="3"/><path d="M24 10l7 7-7 7" fill="none" stroke="${s}" stroke-width="3"/></svg>`,
    blocked: `<svg class="glyph" viewBox="0 0 34 34"><path d="M4 17h18" stroke="${s}" stroke-width="3"/><path d="M27 6v22" stroke="${s}" stroke-width="4"/></svg>`,
    unknown: `<svg class="glyph" viewBox="0 0 34 34"><path d="M4 17h8M16 17h4M24 17h6" stroke="${s}" stroke-width="3" stroke-dasharray="1"/><circle cx="17" cy="17" r="2" fill="${s}"/></svg>`,
  }[kind];
};
const frame = (t, big = true) => `
  <div class="frame"><i class="a"></i><i class="b">${t === "t3" ? "◄──── $100.00 MAX ────►" : ""}</i><span class="flow ${t === "t1" ? "solid" : ""}"></span>
    <span class="gate">${t === "t2" ? "OK" : ""}</span>
    <div class="row"><div><div class="lbl">Keyboard purchase · Shopping Agent</div>
      <div class="${big ? "big" : "amount"} amount" style="margin:8px 0 4px">$16<span style="font-size:.5em;opacity:.6"> left of $100</span></div></div></div>
    <div class="bar"><i style="width:84%"></i></div><div class="meta">$84 used · Expires Friday 6:00 PM · 2 days</div>
    <dl style="margin-top:14px"><dt>May buy</dt><dd>1 new mechanical keyboard</dd><dt>Where</dt><dd>Approved merchants only</dd><dt>Asking</dt><dd>Won't ask you again</dd></dl>
    <div style="margin-top:14px" class="row"><span class="btn alt">Revoke</span><span class="sp"></span><span class="meta">Why this? ›</span></div></div>`;
const acts = (t) => `
  <div class="act row">${glyph(t, "paid")}<div class="sp"><div class="t amount">$84 paid once</div><div class="s">Mechanical keyboard · Shopping Agent · 3:42 PM</div></div></div>
  <div class="act row">${glyph(t, "blocked")}<div class="sp"><div class="t amount">$0 moved</div><div class="s">Refurbished keyboard, $184 · Blocked by your limits · 3:36 PM</div></div></div>
  <div class="act row">${glyph(t, "unknown")}<div class="sp"><div class="t amount">Checking what happened</div><div class="s">Keyboard · $84 · Don't retry yet · 3:31 PM</div></div></div>`;
const board = (t) => `
<section class="${t}"><div class="board">
  <h2>${T[t].name}</h2><p class="tag">${T[t].tag}</p>
  <div class="grid">
   <div class="col">
    <div><p class="cap">Marketing hero</p><div class="hero"><div class="lbl sig">Verifiable financial authority for AI agents</div>
      <div class="big" style="margin:14px 0">Permission to spend.<br><span class="sig">Not control of your money.</span></div>
      <div class="row"><span class="btn ${t === "t1" ? "alt" : ""}">Create Authority</span></div></div></div>
    <div><p class="cap">Home</p><div class="screen"><div class="nav"><b>Home</b><span>New</span><span>Authorities</span><span>Activity</span><span class="sp"></span><span class="pill">SANDBOX</span></div>
      <div class="lbl">Good evening</div><div class="amount" style="font-size:30px;margin:6px 0 12px;font-weight:600">Everything is within your rules.</div>${frame(t, false)}
      <div class="lbl" style="margin-top:14px">Recent</div>${acts(t)
        .split('<div class="act row">')
        .slice(1, 3)
        .map((x) => `<div class="act row">${x}`)
        .join("")}</div></div>
   </div>
   <div class="col">
    <div><p class="cap">Mobile Authority</p><div class="phone"><div class="row"><span class="lbl">PayFlow</span><span class="sp"></span><span class="pill">SANDBOX</span></div>${frame(t, true)}</div></div>
    <div><p class="cap">New Authority</p><div class="phone"><div class="lbl">New Authority · 1 of 3</div><div class="amount" style="font-size:22px;margin:8px 0;font-weight:600">What may your Agent do?</div>
      <div style="border:1px solid var(--rule);padding:12px;font-size:13px;min-height:84px">Buy one new mechanical keyboard, from approved merchants only, maximum $100, before Friday at 6 PM. You do not need to ask me again.</div>
      <div style="margin-top:12px" class="btn">Review boundaries</div></div></div>
   </div>
   <div class="col">
    <div><p class="cap">Activity — paid · blocked · unknown</p><div class="screen">${acts(t)}</div></div>
    <div><p class="cap">Proof</p><div class="screen"><div class="row"><div class="amount" style="font-size:22px;font-weight:600">$0 moved</div><span class="sp"></span><span class="pill">PROOF</span></div>
      <div class="meta" style="margin:6px 0 12px">Price exceeded your $100 maximum.</div>
      <div class="proof">decision      DENY  PRICE_EXCEEDS_MAXIMUM
authority     auth_7f3a…c21   Keyboard purchase
agent         agent_shop_01
terms         $184.00 USD · refurbished · 1 item
reservation   none created
grant         none issued
provider      0 financial calls · 0 captures
trace         MANDATE ✓  GATE ✗ (stopped)  PAYMENT —
at            2026-10-23T15:36:07Z</div></div></div>
   </div>
  </div></div></section>`;

const html = `<!doctype html><meta charset="utf-8"><style>${css}</style>${Object.keys(T).map(board).join("\n")}`;
writeFileSync(join(here, "boards.html"), html);
console.log("wrote boards.html");
