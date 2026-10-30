/** Only expose after the named authorization server is actually commissioned. */
export function oauthProtectedResource(config: {
  resource: string;
  issuer: string;
}) {
  for (const value of [config.resource, config.issuer])
    if (new URL(value).protocol !== "https:")
      throw new Error("OAUTH_HTTPS_REQUIRED");
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [
      "authority:read",
      "action:request",
      "verify:read",
      "proof:read",
      "reconcile:request",
    ],
    bearer_methods_supported: ["header"],
  };
}
