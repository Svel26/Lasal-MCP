// ─── CRC32 for LASAL CLASS 2 ────────────────────────────────────────────────
//
// In Sigmatek LASAL CLASS 2, the 32-bit numerical identifier in the @CT_
// (Class Table) function (e.g. `TO_UDINT(619352855), "ClassSvr"`) is the standard
// IEEE 802.3 CRC-32 of the uppercase identifier string:
//
//   polynomial: 0xEDB88320 (reversed / bit-reflected)
//   initial:    0xFFFFFFFF
//   final XOR:  0xFFFFFFFF
//   input:      ASCII/Latin1 string converted to uppercase

const CRC32_TABLE = new Uint32Array(256);

for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

/**
 * Compute the 32-bit UDINT hash used by LASAL CLASS 2 in `@CT_` tables.
 * Matches the IDE code generator exactly across all class, baseclass,
 * server, and client names.
 */
export function lasalCrc32(name: string): number {
  const upper = name.toUpperCase();
  let crc = 0xffffffff;
  for (let i = 0; i < upper.length; i++) {
    crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ upper.charCodeAt(i)) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
