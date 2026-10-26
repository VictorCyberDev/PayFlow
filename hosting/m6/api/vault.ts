import type { IncomingMessage, ServerResponse } from "node:http";
import postgres from "postgres";
import { z } from "zod";
import {
  DurableConsoleSessions,
  deriveHostKeys,
} from "../../../src/console-session-durable.js";
import { PayPalOAuthClient } from "../../../src/paypal.js";
import {
  ConsolePayPalVaultBootstrap,
  PayPalVaultStore,
} from "../../../src/paypal-vault-bootstrap.js";

const Config = z.object({
  DATABASE_URL: z.string().min(1),
  PAYFLOW_M5_PRINCIPAL_ID: z.string().min(1).max(128),
  PAYFLOW_M5_BOOTSTRAP_KEY: z.string().min(32).max(256),
  PAYFLOW_M5_ORIGIN: z.string().url(),
  PAYPAL_ENVIRONMENT: z.literal("sandbox"),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
});

type App = { bootstrap: ConsolePayPalVaultBootstrap };
let app: App | undefined;
function createApp(): App {
  const c = Config.parse(process.env);
  if (new URL(c.PAYFLOW_M5_ORIGIN).origin !== c.PAYFLOW_M5_ORIGIN)
    throw new Error("INVALID_ORIGIN");
  const sql = postgres(c.DATABASE_URL, {
    max: 2,
    connect_timeout: 5,
    idle_timeout: 20,
    prepare: false,
  });
  const sessions = new DurableConsoleSessions(sql, {
    principalId: c.PAYFLOW_M5_PRINCIPAL_ID,
    origin: c.PAYFLOW_M5_ORIGIN,
    bootstrapKey: c.PAYFLOW_M5_BOOTSTRAP_KEY,
  });
  const store = new PayPalVaultStore(
    sql,
    deriveHostKeys(c.PAYFLOW_M5_BOOTSTRAP_KEY).paymentInstrument,
  );
  return {
    bootstrap: new ConsolePayPalVaultBootstrap(
      sessions,
      new PayPalOAuthClient(c.PAYPAL_CLIENT_ID, c.PAYPAL_CLIENT_SECRET),
      store,
      c.PAYFLOW_M5_ORIGIN,
    ),
  };
}

function json(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk as Uint8Array);
    size += b.length;
    if (size > 4096) throw new Error("BODY_LIMIT");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    app ??= createApp();
    const url = new URL(req.url ?? "/", "http://localhost");
    const action = url.searchParams.get("action");
    const meta = {
      host: req.headers.host,
      cookie: req.headers.cookie,
      origin: req.headers.origin,
      csrf:
        typeof req.headers["x-payflow-csrf"] === "string"
          ? req.headers["x-payflow-csrf"]
          : undefined,
    };
    if (req.method === "GET" && action === "status")
      return json(res, 200, await app.bootstrap.status(meta));
    if (req.method !== "POST" || !["start", "complete"].includes(action ?? ""))
      return json(res, 405, { status: "UNAVAILABLE" });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(res, 415, { status: "UNAVAILABLE" });
    const parsed = await body(req);
    return json(
      res,
      200,
      action === "start"
        ? await app.bootstrap.start(meta, parsed)
        : await app.bootstrap.complete(meta, parsed),
    );
  } catch {
    return json(res, 400, { status: "UNAVAILABLE" });
  }
}
