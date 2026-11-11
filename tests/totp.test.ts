import { describe, expect, it } from "vitest";
import {
  base32,
  hotp,
  newSecret,
  open,
  otpauthUri,
  seal,
  verifyTotp,
} from "../src/network/totp.js";

const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("TOTP primitives", () => {
  it("matches the RFC 4226 test vectors (counters 0-9)", () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    expected.forEach((e, i) => expect(hotp(RFC_SECRET, i)).toBe(e));
  });
  it("matches the RFC 6238 SHA-1 vectors (8 digits, T=59 -> counter 1, T=1111111109 -> 37037036)", () => {
    expect(hotp(RFC_SECRET, 1, 8)).toBe("94287082");
    expect(hotp(RFC_SECRET, 37037036, 8)).toBe("07081804");
    expect(hotp(RFC_SECRET, 37037037, 8)).toBe("14050471");
  });
  it("encodes base32 as RFC 4648 does", () => {
    expect(base32(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });
  it("accepts the previous, current and next step, refuses others, and never accepts a step twice", () => {
    const t = 1_700_000_000_000;
    const now = Math.floor(t / 30000);
    const code = (s: number) => hotp(RFC_SECRET, s);
    expect(verifyTotp(RFC_SECRET, code(now), t, 0)).toBe(now);
    expect(verifyTotp(RFC_SECRET, code(now - 1), t, 0)).toBe(now - 1);
    expect(verifyTotp(RFC_SECRET, code(now + 1), t, 0)).toBe(now + 1);
    expect(verifyTotp(RFC_SECRET, code(now - 2), t, 0)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code(now + 2), t, 0)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code(now), t, now)).toBeNull(); // replay of the accepted step
    expect(verifyTotp(RFC_SECRET, code(now - 1), t, now)).toBeNull(); // and nothing older than it
    expect(verifyTotp(RFC_SECRET, "12345", t, 0)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", t, 0)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 123456, t, 0)).toBeNull();
    expect(
      verifyTotp(
        RFC_SECRET,
        ` ${code(now).slice(0, 3)} ${code(now).slice(3)} `,
        t,
        0,
      ),
    ).toBe(now); // spaces as typed from an app
  });
  it("seals secrets: round trip, fresh nonce each time, and any change fails closed", () => {
    const key = Buffer.alloc(32, 7);
    const s = newSecret();
    const a = seal(key, s, "pfu_a");
    expect(seal(key, s, "pfu_a")).not.toBe(a);
    expect(open(key, a, "pfu_a")?.equals(s)).toBe(true);
    expect(open(key, a, "pfu_b")).toBeNull(); // bound to its owner
    expect(open(Buffer.alloc(32, 8), a, "pfu_a")).toBeNull();
    const parts = a.split(".");
    parts[2] = Buffer.from("tampered").toString("base64url");
    expect(open(key, parts.join("."), "pfu_a")).toBeNull();
    expect(open(key, "garbage", "pfu_a")).toBeNull();
  });
  it("builds the otpauth link authenticator apps read", () => {
    const u = otpauthUri(RFC_SECRET, "a@example.com");
    expect(u).toContain(
      "otpauth://totp/PayFlow%3Aa%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    );
    expect(u).toContain("period=30");
    expect(u).toContain("digits=6");
  });
});
