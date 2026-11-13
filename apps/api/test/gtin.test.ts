import { describe, expect, it } from "vitest";
import { gtinKey } from "../src/catalogue/gtin.js";

/** Appends the GS1 check digit to a code body. */
function withCheck(body: string): string {
  const padded = body.padStart(13, "0");
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(padded[i]) * (i % 2 === 0 ? 3 : 1);
  return body + String((10 - (sum % 10)) % 10);
}

describe("GTIN grouping key (CA-2, T5)", () => {
  it("groups leading-zero equivalents of a valid GTIN-12/13/14", () => {
    const upc = withCheck("03600029145"); // 12 digits
    const key = gtinKey(upc);
    expect(key).toBe(upc.padStart(14, "0"));
    expect(gtinKey(`0${upc}`)).toBe(key);
    expect(gtinKey(`00${upc}`)).toBe(key);
  });

  it("accepts valid GTIN-8, GTIN-13 and GTIN-14 with an indicator digit", () => {
    expect(gtinKey(withCheck("9638507"))).toBe(`000000${withCheck("9638507")}`);
    expect(gtinKey(withCheck("400638133393"))).toBe(`0${withCheck("400638133393")}`);
    expect(gtinKey(withCheck("1400638133393"))).toBe(withCheck("1400638133393"));
  });

  it("rejects bad check digits, wrong lengths and non-digit codes", () => {
    const good = withCheck("400638133393");
    const bad = good.slice(0, -1) + String((Number(good.at(-1)) + 1) % 10);
    for (const code of [
      bad,
      "1234567",
      "12345678901",
      "123456789012345",
      `${good} `,
      "40063813339a",
    ]) {
      expect(gtinKey(code)).toBeNull();
    }
    expect(gtinKey("0-41190-06938-5")).toBeNull();
    expect(gtinKey("４００６３８１３３３９３１")).toBeNull();
  });

  it("never groups RCN-8 prefixes 0 and 2, including padded aliases", () => {
    for (const body of ["0123456", "2123456"]) {
      const rcn8 = withCheck(body);
      for (const alias of [
        rcn8,
        rcn8.padStart(12, "0"),
        rcn8.padStart(13, "0"),
        rcn8.padStart(14, "0"),
      ]) {
        expect(gtinKey(alias)).toBeNull();
      }
    }
    expect(gtinKey(withCheck("5123456"))).not.toBeNull();
    // GTIN-14 with an indicator digit wrapping an RCN-8 body.
    expect(gtinKey(withCheck("1000002123456"))).toBeNull();
    expect(gtinKey(withCheck("1000000123456"))).toBeNull();
    expect(gtinKey(withCheck("1000005123456"))).not.toBeNull();
  });

  it("never groups RCN-13 prefixes 02, 04 and 20–29, nor RCN-12 U.P.C. prefixes 2 and 4", () => {
    const bodies = ["021234567890", "041234567890"];
    for (let p = 20; p <= 29; p++) bodies.push(`${p}1234567890`);
    for (const body of bodies) {
      const rcn13 = withCheck(body);
      expect(gtinKey(rcn13)).toBeNull();
      expect(gtinKey(`0${rcn13}`)).toBeNull();
    }
    for (const body of ["21234567890", "41234567890"]) {
      const rcn12 = withCheck(body);
      expect(gtinKey(rcn12)).toBeNull();
      expect(gtinKey(`0${rcn12}`)).toBeNull();
      expect(gtinKey(`00${rcn12}`)).toBeNull();
    }
    expect(gtinKey(withCheck("301234567890"))).not.toBeNull();
  });

  it("never groups RCN-12 with U.P.C. Company Prefixes 000000 and 001000–007999", () => {
    for (const body of ["00000012345", "00100012345", "00799912345", "00412345678"]) {
      const rcn12 = withCheck(body);
      expect(gtinKey(rcn12)).toBeNull();
      expect(gtinKey(`0${rcn12}`)).toBeNull();
      expect(gtinKey(`00${rcn12}`)).toBeNull();
    }
    expect(gtinKey(withCheck("00800012345"))).not.toBeNull();
    expect(gtinKey(withCheck("00099912345"))).not.toBeNull();
  });
});
