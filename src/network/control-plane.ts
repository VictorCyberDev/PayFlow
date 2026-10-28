import { z } from "zod";

export const OrganizationRoleSchema = z.enum([
  "ORG_OWNER",
  "FINANCE_OWNER",
  "SECURITY_OWNER",
  "AUTHORITY_ADMIN",
  "AGENT_ADMIN",
  "AUDITOR",
  "VIEWER",
]);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const ControlPlaneEnvironmentSchema = z.enum(["SANDBOX", "PRODUCTION"]);
export type ControlPlaneEnvironment = z.infer<
  typeof ControlPlaneEnvironmentSchema
>;

const permissionMap: Readonly<Record<OrganizationRole, readonly string[]>> = {
  ORG_OWNER: ["org:*"],
  FINANCE_OWNER: [
    "authority:approve",
    "authority:revoke",
    "billing:read",
    "audit:read",
  ],
  SECURITY_OWNER: [
    "agent:suspend",
    "agent:revoke",
    "audit:read",
    "security:manage",
  ],
  AUTHORITY_ADMIN: ["authority:create", "authority:read", "template:manage"],
  AGENT_ADMIN: ["agent:register", "agent:read", "agent:rotate"],
  AUDITOR: ["audit:read", "proof:read"],
  VIEWER: ["authority:read", "agent:read", "activity:read"],
};

export function roleAllows(
  role: OrganizationRole,
  permission: string,
): boolean {
  const allowed = permissionMap[role];
  return allowed.includes("org:*") || allowed.includes(permission);
}

export function assertSameTenant(
  authenticatedOrganizationId: string,
  resourceOrganizationId: string,
): void {
  if (
    authenticatedOrganizationId.length === 0 ||
    resourceOrganizationId.length === 0 ||
    authenticatedOrganizationId !== resourceOrganizationId
  ) {
    throw new Error("CROSS_TENANT_ACCESS_DENIED");
  }
}

export function assertEnvironmentBoundary(
  authenticatedEnvironment: ControlPlaneEnvironment,
  resourceEnvironment: ControlPlaneEnvironment,
): void {
  if (authenticatedEnvironment !== resourceEnvironment) {
    throw new Error("CROSS_ENVIRONMENT_ACCESS_DENIED");
  }
}
