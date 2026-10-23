export type GlyphKind =
  "paid" | "blocked" | "unresolved" | "failed" | "revoked" | "expired";

/** Gate glyphs (BRAND-001 §4). The shape carries the state; the word beside it confirms it. */
export function GateGlyph({
  kind,
  size = 34,
}: {
  kind: GlyphKind;
  size?: number;
}) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 2.5 };
  return (
    <svg
      className={`glyph glyph--${kind}`}
      viewBox="0 0 34 34"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {kind === "paid" && (
        <rect x="3" y="3" width="28" height="28" fill="currentColor" />
      )}
      {kind === "blocked" && (
        <>
          <rect x="3" y="3" width="28" height="28" {...common} />
          <rect x="3" y="14" width="28" height="6" fill="currentColor" />
        </>
      )}
      {kind === "unresolved" && (
        <>
          <rect
            x="3"
            y="3"
            width="28"
            height="28"
            {...common}
            strokeDasharray="5 4"
          />
          <circle
            cx="17"
            cy="17"
            r="4"
            fill="var(--signal)"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </>
      )}
      {kind === "failed" && (
        <>
          <rect x="3" y="3" width="28" height="28" {...common} />
          <path
            d="M3 3l28 28M31 3L3 31"
            stroke="currentColor"
            strokeWidth="2"
          />
        </>
      )}
      {kind === "revoked" && (
        <>
          <rect x="3" y="3" width="28" height="28" {...common} />
          <path d="M-1 24L35 10" stroke="currentColor" strokeWidth="3" />
        </>
      )}
      {kind === "expired" && (
        <>
          <rect x="3" y="3" width="28" height="28" {...common} />
          <path
            d="M9 31L31 9M3 25L25 3M17 31L31 17M3 17L17 3"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </>
      )}
    </svg>
  );
}
