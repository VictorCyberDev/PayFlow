import {
  MCP_TOOL_SCOPES,
  PAYFLOW_MCP_TOOLS,
  type PayFlowMcpToolName,
} from "./mcp.js";

/**
 * ChatGPT (and any MCP Apps host) integration surface for the PayFlow MCP server. Nothing here decides anything:
 * it describes tools, declares per-tool auth, renders a result the Gateway already produced, and publishes
 * discovery metadata. Authorization stays in the Gateway; this module has no policy and no credentials.
 */
export const DECISION_WIDGET_URI = "ui://widget/payflow-decision-v1.html";
export const MCP_APP_MIME = "text/html;profile=mcp-app";

const TITLES: Readonly<Record<PayFlowMcpToolName, string>> = {
  check_financial_authority: "Check financial Authority",
  request_authorized_action: "Request an authorized payment",
  verify_authority: "Verify an Authority presentation",
  verify_financial_proof: "Verify payment Proof",
  reconcile_financial_action: "Reconcile an unknown payment",
};

const STATUS_TEXT: Readonly<Record<PayFlowMcpToolName, [string, string]>> = {
  check_financial_authority: ["Checking Authority…", "Authority checked"],
  request_authorized_action: ["Asking the Authority…", "Authority answered"],
  verify_authority: ["Verifying Authority…", "Authority verified"],
  verify_financial_proof: ["Verifying Proof…", "Proof checked"],
  reconcile_financial_action: ["Reconciling…", "Reconciliation read"],
};

/** Per-tool descriptor metadata. `securitySchemes` is declared per tool, never as a server-wide default. */
export function toolPresentation(name: PayFlowMcpToolName): {
  title: string;
  _meta: Record<string, unknown>;
} {
  const [invoking, invoked] = STATUS_TEXT[name];
  const showsDecision =
    name === "request_authorized_action" || name === "verify_financial_proof";
  return {
    title: TITLES[name],
    _meta: {
      securitySchemes: [{ type: "oauth2", scopes: [MCP_TOOL_SCOPES[name]] }],
      ...(showsDecision
        ? {
            ui: { resourceUri: DECISION_WIDGET_URI },
            "openai/outputTemplate": DECISION_WIDGET_URI,
          }
        : {}),
      "openai/toolInvocation/invoking": invoking,
      "openai/toolInvocation/invoked": invoked,
    },
  };
}

export const ALL_TOOL_SCOPES: readonly string[] = [
  ...new Set(PAYFLOW_MCP_TOOLS.map((tool) => MCP_TOOL_SCOPES[tool.name])),
];

/**
 * RFC 9728 protected-resource metadata. `resource` is the exact value ChatGPT echoes as the OAuth `resource`
 * parameter. `authorization_servers` is empty until an authorization server is commissioned: publishing a made-up
 * issuer would be a lie, so the document says so.
 */
export function protectedResourceMetadata(config: {
  resource: string;
  authorizationServers: readonly string[];
  documentation: string;
}) {
  return {
    resource: config.resource,
    authorization_servers: [...config.authorizationServers],
    scopes_supported: [...ALL_TOOL_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: config.documentation,
  };
}

/** The challenge a protected server returns so ChatGPT can start OAuth. */
export function wwwAuthenticate(resource: string): string {
  return `Bearer resource_metadata="${new URL(resource).origin}/.well-known/oauth-protected-resource"`;
}

/**
 * A self-contained, accessible result card. It renders only what the tool returned (structuredContent) using
 * textContent, never innerHTML, so no tool output can inject markup. It talks to no network. "effectCount: null"
 * is shown as UNKNOWN, never as zero.
 */
export const DECISION_WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PayFlow result</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#14171f;--muted:#4b5262;--ok:#0b6b3a;--bad:#a1241a;--warn:#8a5a00;--line:#c9ced8}
@media (prefers-color-scheme:dark){:root{--bg:#14171f;--fg:#f2f4f8;--muted:#b4bacb;--ok:#59d38c;--bad:#ff8b80;--warn:#f2c14e;--line:#3a4152}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:34rem;border:1px solid var(--line);border-radius:12px;padding:16px}
h1{font-size:1.1rem;margin:0 0 8px}
.badge{display:inline-block;padding:2px 10px;border:2px solid currentColor;border-radius:999px;font-weight:700}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:12px 0 0}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
p{margin:8px 0 0}
</style>
</head>
<body>
<main aria-live="polite">
<h1>PayFlow Authority result</h1>
<p><span id="badge" class="badge warn">Waiting for a result</span></p>
<p id="summary"></p>
<dl id="facts"></dl>
</main>
<script>
(function(){
  var badge=document.getElementById('badge'),summary=document.getElementById('summary'),facts=document.getElementById('facts');
  function row(k,v){if(v===undefined||v===null||v==='')return;var dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=k;dd.textContent=String(v);facts.appendChild(dt);facts.appendChild(dd);}
  function show(label,cls,text){badge.textContent=label;badge.className='badge '+cls;summary.textContent=text;}
  function render(d){
    if(!d||typeof d!=='object')return;
    facts.textContent='';
    var proof=d.portableProof&&typeof d.portableProof==='object'?d.portableProof:null;
    if(d.valid===true){show('Proof valid','ok','This signed Proof is authentic.');}
    else if(d.valid===false){show('Proof not valid','bad','This Proof did not verify ('+String(d.reason||'unknown reason')+'). Do not rely on it.');}
    else if(d.effectCount===null){show('Outcome UNKNOWN','warn','PayFlow cannot yet confirm whether money moved. Do not retry; check the Proof.');}
    else if(d.status==='COMPLETED'&&d.effectCount===1){show('Paid once','ok','The payment was made exactly once.');}
    else if(d.decision==='DENY'||d.status==='DENIED'){show('Not allowed','bad',String(d.humanSummary||'The Authority did not allow this. $0 moved.'));}
    else if(d.status==='NEEDS_APPROVAL'){show('Needs approval','warn',String(d.humanSummary||'A person must approve this first. $0 moved.'));}
    else {show('Result','warn',String(d.humanSummary||''));}
    row('Decision',d.decision);row('Status',d.status);
    row('Money moved',d.effectCount===null?'UNKNOWN':d.effectCount===0?'$0':d.effectCount===1?'Exactly once':undefined);
    row('Reason',d.reason);row('Next step',d.nextAction);row('Rail',d.rail);
    if(proof){row('Proof outcome',proof.outcome);row('Proof issuer',proof.issuer);}
    row('Outcome',d.outcome);
  }
  function fromHost(o){if(o&&typeof o==='object')render(o.structuredContent||o);}
  if(window.openai&&window.openai.toolOutput)fromHost(window.openai.toolOutput);
  window.addEventListener('message',function(e){var m=e.data;if(m&&m.jsonrpc==='2.0'&&m.method==='ui/notifications/tool-result'&&m.params)fromHost(m.params);},{passive:true});
  window.addEventListener('openai:set_globals',function(e){var g=e.detail&&e.detail.globals;if(g&&g.toolOutput)fromHost(g.toolOutput);});
})();
</script>
</body>
</html>
`;
