/** Presentation helpers only. Nothing here decides, widens or verifies financial authority. */

const DAY = 86_400_000;

/** "$84", "$84.50", "€12". Whole amounts drop the cents; JPY has no minor unit. */
export function formatMoney(minor: number | null, currency: string): string {
  if (minor === null) return "Not established";
  const value = minor / (currency === "JPY" ? 1 : 100);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function parts(date: Date, timeZone?: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const n = (t: string) => Number(f.find((p) => p.type === t)?.value);
  return { y: n("year"), m: n("month"), d: n("day") };
}
const dayNumber = (date: Date, tz?: string) => {
  const p = parts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d) / DAY;
};
const clock = (date: Date, tz?: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

/** "Today at 3:42 PM", "Friday at 6:00 PM", "Oct 30 at 6:00 PM". Local time of the viewer. */
export function humanWhen(iso: string, now: Date, timeZone?: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "Unknown time";
  const diff = dayNumber(at, timeZone) - dayNumber(now, timeZone);
  const time = clock(at, timeZone);
  if (diff === 0) return `Today at ${time}`;
  if (diff === 1) return `Tomorrow at ${time}`;
  if (diff === -1) return `Yesterday at ${time}`;
  if (diff > 1 && diff < 7)
    return `${new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(at)} at ${time}`;
  if (diff < -1 && diff > -7)
    return `${new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(at)} at ${time}`;
  const sameYear = parts(at, timeZone).y === parts(now, timeZone).y;
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(at)} at ${time}`;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** "2 days remaining", "5 hours remaining", "Expired". */
export function humanRemaining(iso: string, now: Date): string {
  const ms = Date.parse(iso) - now.getTime();
  if (!Number.isFinite(ms)) return "Unknown expiry";
  if (ms <= 0) return "Expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "Less than a minute remaining";
  if (minutes < 60) return `${plural(minutes, "minute")} remaining`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${plural(hours, "hour")} remaining`;
  return `${plural(Math.floor(hours / 24), "day")} remaining`;
}

/** "Updated just now", "Updated 2 minutes ago". */
export function updatedAgo(iso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "Updated recently";
  if (s < 45) return "Updated just now";
  const m = Math.round(s / 60);
  if (m < 60) return `Updated ${plural(m, "minute")} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `Updated ${plural(h, "hour")} ago`;
  return `Updated ${plural(Math.round(h / 24), "day")} ago`;
}

/** Proof layer only. */
export function exactUtc(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "unknown";
}

/** Time of day greeting for Home. */
export function greeting(now: Date, timeZone?: string): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );
  return hour < 5
    ? "Good evening"
    : hour < 12
      ? "Good morning"
      : hour < 18
        ? "Good afternoon"
        : "Good evening";
}
