import { describe, it, expect } from "vitest";
import { lasalCrc32 } from "../src/utils/crc.js";

describe("lasalCrc32", () => {
  it("matches known LASAL CLASS 2 @CT_ hashes across real projects", () => {
    // Classes
    expect(lasalCrc32("ClassSvr")).toBe(619352855);
    expect(lasalCrc32("PbLib")).toBe(264570932);
    expect(lasalCrc32("SdiasBase")).toBe(3175101883);
    expect(lasalCrc32("AI043")).toBe(1698489890);

    // Channels
    expect(lasalCrc32("FirmwareVersion")).toBe(389440282);
    expect(lasalCrc32("FWErrorBits")).toBe(3888132073);
    expect(lasalCrc32("AI1")).toBe(4269591187);
    expect(lasalCrc32("AI2")).toBe(1735760681);
    expect(lasalCrc32("AI3")).toBe(275950527);
    expect(lasalCrc32("AI4")).toBe(2383822364);
    expect(lasalCrc32("CableBreak")).toBe(3580028836);
    expect(lasalCrc32("Range")).toBe(1691588857);
    expect(lasalCrc32("State")).toBe(1422331979);
  });

  it("is case-insensitive as required by LASAL", () => {
    expect(lasalCrc32("pblib")).toBe(lasalCrc32("PBLIB"));
    expect(lasalCrc32("classsvr")).toBe(619352855);
  });
});
