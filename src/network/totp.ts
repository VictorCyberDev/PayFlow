import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226): HMAC-SHA1, 30-second steps, 6 digits, the codes of the previous, current and next step
 * are accepted to allow for clock drift. A step is accepted once: the caller keeps the last accepted step and passes it back, so a code that has
 * been used (or sniffed after use) cannot be replayed.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const newSecret = (): Buffer => randomBytes(20);

export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function hotp(
  secret: Buffer,
  counter: number,
  digits = TOTP_DIGITS,
): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(c).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin =
    ((h[off]! & 0x7f) << 24) |
    (h[off + 1]! << 16) |
    (h[off + 2]! << 8) |
    h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (ms: number): number =>
  Math.floor(ms / 1000 / TOTP_STEP_SECONDS);

/** The accepted step for this code, or null. Only a step later than `lastStep` is accepted. */
export function verifyTotp(
  secret: Buffer,
  code: unknown,
  nowMs: number,
  lastStep: number,
): number | null {
  if (typeof code !== "string" || !/^\d{6}$/u.test(code.replace(/\s+/gu, "")))
    return null;
  const given = Buffer.from(code.replace(/\s+/gu, ""));
  const now = stepAt(nowMs);
  let hit: number | null = null;
  // every candidate is compared, so timing does not reveal which step matched
  for (const step of [now - 1, now, now + 1]) {
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, given) && step > lastStep && hit === null)
      hit = step;
  }
  return hit;
}

export function otpauthUri(
  secret: Buffer,
  account: string,
  issuer = "PayFlow",
): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

/** AES-256-GCM with a fresh random nonce. Output "v1.<nonce>.<ciphertext>.<tag>" (base64url). */
export function seal(key: Buffer, plain: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    ct.toString("base64url"),
    c.getAuthTag().toString("base64url"),
  ].join(".");
}

/** Null on any failure (wrong key, tampering, wrong owner): the caller must then treat the factor as unusable, never as absent. */
export function open(key: Buffer, sealed: string, aad: string): Buffer | null {
  const [v, iv, ct, tag] = sealed.split(".");
  if (v !== "v1" || !iv || !ct || !tag) return null;
  try {
    const d = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
    );
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
  } catch {
    return null;
  }
}
