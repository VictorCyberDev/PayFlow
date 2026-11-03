/** Plain module (no "use client") so server and client components can both format money. */
export const usd = (minor: number): string =>
  `$${(minor / 100).toLocaleString("en-US", {
    minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
  })}`;
