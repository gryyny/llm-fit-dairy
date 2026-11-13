/**
 * CA-2: the grouping key for a barcode, or null when it must never group automatically.
 *
 * Eligible: ASCII digits only, length 8, 12, 13 or 14, valid GS1 mod-10 check digit, and not a
 * Restricted Circulation Number in any representation (GS1 General Specifications 26.0,
 * sections 1.2.3, 2.1.11 and 7.9). The key is the code left-padded with zeros to 14 digits.
 */
export function gtinKey(raw: string): string | null {
  if (!/^(?:\d{8}|\d{12,14})$/.test(raw)) return null;
  const key = raw.padStart(14, "0");
  if (!hasValidCheckDigit(key) || isRestricted(key)) return null;
  return key;
}

function hasValidCheckDigit(key: string): boolean {
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(key[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(key[13]);
}

/** Classifies by the underlying format, so zero-padded aliases are restricted too. */
function isRestricted(key: string): boolean {
  // Six leading zeros: a GTIN-8. RCN-8 prefixes are 0 and 2. A GTIN-14 indicator digit followed
  // by five zeros wraps the same 8-digit body, so the same rule applies to it.
  if (key.startsWith("000000") || key.slice(1, 6) === "00000")
    return key[6] === "0" || key[6] === "2";
  // RCNs are never valid inside a GTIN-14 with a non-zero indicator; refuse to group such codes.
  const gtin13 = key.startsWith("0") ? key.slice(1) : key.slice(1, 13);
  // RCN-13 GS1 prefixes 02, 04 and 20–29; RCN-12 U.P.C. prefixes 2 and 4 have the same 13-digit form.
  if (/^(?:0[24]|2\d)/.test(gtin13)) return true;
  // RCN-12 with U.P.C. Company Prefix 000000 or 001000–007999 (LAC and RZSC).
  if (gtin13.startsWith("0")) {
    const companyPrefix = gtin13.slice(1, 7);
    return companyPrefix === "000000" || (companyPrefix >= "001000" && companyPrefix <= "007999");
  }
  return false;
}
