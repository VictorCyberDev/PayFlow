import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ConsoleSessions, type ConsoleRequest } from "./console-session.js";
import { ConsoleControls } from "./console-controls.js";
import { ConsoleActivity } from "./activity-postgres.js";
import { StaticPublicKeyRing } from "./execution-grant.js";
import { ConsoleActivation } from "./console-activation.js";
import { createReviewDemoHost } from "./intent-review-demo-host.js";
import { IntentReviewService } from "./intent-review.js";
import {
  demoIntentSource,
  demoReviewBounds,
  recordedInterpretation,
} from "./intent-review-demo.js";
import {
  FakeIntentModelProvider,
  type IntentModelProvider,
} from "./intent-model.js";
import { PostgresTrustRepository } from "./persistence.js";

/** New opt-in host; existing M5B host remains unchanged and cannot activate. */
export function activationHttpHandler(
  app: ConsoleActivation,
  options: {
    sample: string;
    review: IntentReviewService;
    outputDirectory: string;
    controls?: ConsoleControls;
    activity?: ConsoleActivity;
  },
) {
  const staticHost = createReviewDemoHost(options.outputDirectory);
  function json(
    res: ServerResponse,
    code: number,
    data: unknown,
    cookie?: string,
  ) {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    });
    res.end(JSON.stringify(data));
  }
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) {
      staticHost.emit("request", req, res);
      return;
    }
    const meta: ConsoleRequest = {
      host: req.headers.host,
      cookie: req.headers.cookie,
      origin: req.headers.origin,
      csrf:
        typeof req.headers["x-payflow-csrf"] === "string"
          ? req.headers["x-payflow-csrf"]
          : undefined,
    };
    try {
      if (req.method === "GET") {
        if (url.pathname === "/api/activation/session")
          return json(res, 200, app.sessions.view(app.sessions.read(meta)));
        if (
          url.pathname === "/api/activation/authorities" &&
          options.controls
        ) {
          if (url.search) return json(res, 400, { status: "UNAVAILABLE" });
          return json(res, 200, await options.controls.list(meta, {}));
        }
        if (url.pathname === "/api/activation/activity" && options.activity) {
          const keys = [...url.searchParams.keys()];
          if (keys.length > 1 || keys.some((k) => k !== "operationId"))
            return json(res, 400, { status: "UNAVAILABLE" });
          return json(
            res,
            200,
            await options.activity.read(
              meta,
              keys.length
                ? { operationId: url.searchParams.get("operationId") }
                : {},
            ),
          );
        }
        if (url.pathname === "/api/activation/authority") {
          const keys = [...url.searchParams.keys()];
          if (keys.length !== 1 || keys[0] !== "mandateId")
            return json(res, 400, { status: "UNAVAILABLE" });
          const view = await app.authority(meta, {
            mandateId: url.searchParams.get("mandateId"),
          });
          return view
            ? json(res, 200, view)
            : json(res, 404, { status: "UNAVAILABLE" });
        }
        if (url.pathname === "/api/intent-review/sample")
          return json(res, 200, {
            mode: "NON_PRODUCTION_REVIEW",
            sample: options.sample,
          });
        return json(res, 405, { status: "UNAVAILABLE" });
      }
      if (req.method !== "POST")
        return json(res, 405, { status: "UNAVAILABLE" });
      app.sessions.checkOrigin(meta);
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { status: "UNAVAILABLE" });
      // Authenticate mutations before reading/interpreting the request, except bootstrap.
      if (
        url.pathname.startsWith("/api/activation/") &&
        url.pathname !== "/api/activation/session"
      )
        app.sessions.mutation(meta, true);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const b = Buffer.from(chunk as Uint8Array);
        size += b.length;
        if (size > 8192) return json(res, 413, { status: "UNAVAILABLE" });
        chunks.push(b);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (url.pathname === "/api/activation/session") {
        const login = app.sessions.login(meta, body);
        return json(res, 200, login.view, login.cookie);
      }
      if (url.pathname === "/api/activation/logout") {
        z.object({}).strict().parse(body);
        return json(
          res,
          200,
          { authenticated: false },
          app.sessions.logout(meta),
        );
      }
      if (url.pathname === "/api/activation/revoke" && options.controls)
        return json(res, 200, await options.controls.revoke(meta, body));
      if (url.pathname === "/api/activation/reviews")
        return json(res, 200, await app.prepare(meta, body));
      if (url.pathname === "/api/activation/confirm") {
        const outcome = await app.confirm(meta, body);
        return json(res, outcome.status === "ACTIVATED" ? 200 : 409, outcome);
      }
      if (url.pathname === "/api/intent-review") {
        const view = await options.review.review(body);
        return view
          ? json(res, 200, view)
          : json(res, 400, { status: "UNAVAILABLE" });
      }
      return json(res, 404, { status: "UNAVAILABLE" });
    } catch {
      return json(res, 400, {
        status: "UNAVAILABLE",
        message:
          "This action could not be verified. Nothing new is shown as active. Sign in again or prepare a fresh review.",
      });
    }
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.env.PAYFLOW_M5C_DEMO !== "true")
    throw new Error("NON_PRODUCTION_DEMO_OPT_IN_REQUIRED");
  const config = z
    .object({
      DATABASE_URL: z.string().min(1),
      PAYFLOW_M5C_PRINCIPAL_ID: z.string().min(1),
      PAYFLOW_M5C_AGENT_ID: z.string().min(1),
      PAYFLOW_M5C_BOOTSTRAP_KEY: z.string().min(32),
    })
    .parse({
      DATABASE_URL: process.env.DATABASE_URL,
      PAYFLOW_M5C_PRINCIPAL_ID: process.env.PAYFLOW_M5C_PRINCIPAL_ID,
      PAYFLOW_M5C_AGENT_ID: process.env.PAYFLOW_M5C_AGENT_ID,
      PAYFLOW_M5C_BOOTSTRAP_KEY: process.env.PAYFLOW_M5C_BOOTSTRAP_KEY,
    });
  const origin = "http://127.0.0.1:8080",
    expiry = new Date(Date.now() + 3600000).toISOString(),
    sample = demoIntentSource(expiry);
  const provider: IntentModelProvider = {
    interpretIntent(source) {
      if (source.text !== sample)
        return Promise.resolve({ status: "MODEL_UNAVAILABLE" });
      return new FakeIntentModelProvider(
        recordedInterpretation(source, expiry),
      ).interpretIntent();
    },
  };
  const repo = PostgresTrustRepository.connect(config.DATABASE_URL);
  const sessions = new ConsoleSessions({
    principalId: config.PAYFLOW_M5C_PRINCIPAL_ID,
    origin,
    bootstrapKey: config.PAYFLOW_M5C_BOOTSTRAP_KEY,
  });
  const app = new ConsoleActivation(repo, sessions, {
    agentId: config.PAYFLOW_M5C_AGENT_ID,
    provider,
    bounds: demoReviewBounds,
  });
  const handler = activationHttpHandler(app, {
    sample,
    controls: new ConsoleControls(repo, sessions),
    activity: new ConsoleActivity(
      repo,
      sessions,
      new StaticPublicKeyRing(new Map()),
    ),
    review: new IntentReviewService(provider, demoReviewBounds),
    outputDirectory: resolve("apps/console/out"),
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 21000;
  server.listen(8080, "127.0.0.1", () =>
    console.log(
      "NON-PRODUCTION fixed-owner activation demo; loopback only; no payment rail",
    ),
  );
}
