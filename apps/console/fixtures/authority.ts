/** Presentation-only examples. Deliberately NOT AuthorityProjection or domain terms. */
export const demoAuthority = Object.freeze({
  source: "NON_AUTHORITATIVE_FIXTURE" as const,
  agentName: "Shopping Agent",
  purpose: "Keyboard purchase",
  maximum: "$100.00",
  remaining: "$16.00",
  used: "$84.00",
  expiry: "Friday · 6:00 PM (example)",
});
