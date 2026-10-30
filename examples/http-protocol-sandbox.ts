import { createProtocolHttpServer } from "../src/protocols/local-http-server.js";
import { createLocalTokenAuthenticator } from "../src/protocols/http-auth.js";
import {
  createMcpHttpHandler,
  localProtocolRateLimit,
} from "../src/protocols/mcp-http.js";
import { createA2AHttpHandler } from "../src/protocols/a2a-http.js";
import { createSandboxMcpServices } from "../src/protocols/mcp-sandbox.js";
import { accessFor } from "../src/network/live-fault-injector.js";
import { kernelFixture } from "../src/network/benchmark.js";
const token = process.env.PAYFLOW_MCP_ACCESS_TOKEN ?? "";
if (token.length < 32)
  throw new Error(
    "Set a private local PAYFLOW_MCP_ACCESS_TOKEN of at least 32 characters",
  );
const port = Number(process.env.PORT ?? 4321);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid local port");
const origin = `http://localhost:${port}`;
const resource = `${origin}/mcp`;
const { agent } = kernelFixture();
const access = {
  ...accessFor(agent),
  audience: resource,
  scopes: [
    "authority:read" as const,
    "action:request" as const,
    "verify:read" as const,
    "proof:read" as const,
    "reconcile:request" as const,
  ],
};
const authenticate = createLocalTokenAuthenticator([{ token, access }]);
const services = createSandboxMcpServices(() => new Date().toISOString());
const rateLimit = localProtocolRateLimit();
const nonces = new Set<string>();
const mcp = createMcpHttpHandler({
  resource,
  authenticate,
  servicesFor: () => services,
  allowedOrigins: [origin],
  rateLimit,
});
const a2a = createA2AHttpHandler({
  baseUrl: origin,
  audience: resource,
  authenticate,
  servicesFor: () => services,
  rateLimit,
  parentFor: () => Promise.resolve(null),
  replayStore: {
    claimNonce: (scope, key) => {
      const id = `${scope}:${key}`;
      if (nonces.has(id)) return Promise.resolve(false);
      nonces.add(id);
      return Promise.resolve(true);
    },
  },
});
const server = createProtocolHttpServer((request) =>
  new URL(request.url).pathname === "/mcp" ? mcp(request) : a2a(request),
);
server.listen(port, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      environment: "LOCAL_SIMULATION",
      mcp: `${origin}/mcp`,
      agentCard: `${origin}/.well-known/agent-card.json`,
      providerContacted: false,
    }),
  ),
);
