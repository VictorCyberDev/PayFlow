import { BRAND } from "../../lib/brand";
/** The Frame with its Gate open and the Flow line passing through (BRAND-001 §1). */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M28 11V4H4v24h24v-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="miter"
      />
      <path d="M11 16h21" stroke="currentColor" strokeWidth="3" />
    </svg>
  );
}
export function Wordmark() {
  return (
    <span className="wordmark">
      <BrandMark />
      <span>{BRAND.name}</span>
    </span>
  );
}
