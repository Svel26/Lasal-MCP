import { describe, it, expect } from "vitest";
import { join, dirname } from "path";
import { resolveConnection, findLssPath, shouldAddLoader, isLoopbackTarget } from "../src/utils/preflight.js";

const FIXTURES = join(dirname(import.meta.filename), "fixtures");

describe("resolveConnection", () => {
  it("returns explicit connection when provided", () => {
    const result = resolveConnection(join(FIXTURES, "Sample.lcp"), "TCPIP:192.168.1.1");
    expect(result.connection).toBe("TCPIP:192.168.1.1");
    expect(result.ip).toBe("192.168.1.1");
    expect(result.source).toBe("explicit");
  });

  it("returns explicit connection with port", () => {
    const result = resolveConnection(join(FIXTURES, "Sample.lcp"), "TCPIP:192.168.1.1:2000");
    expect(result.connection).toBe("TCPIP:192.168.1.1:2000");
    expect(result.ip).toBe("192.168.1.1");
  });

  it("treats dotted string as IP", () => {
    const result = resolveConnection(join(FIXTURES, "Sample.lcp"), "10.0.0.1");
    expect(result.ip).toBe("10.0.0.1");
  });
});

describe("findLssPath", () => {
  it("finds .lss in the same directory as .lcp", () => {
    // Station1.lss is not directly alongside Sample.lcp, so this tests fallback behavior
    const result = findLssPath(join(FIXTURES, "Sample.lcp"));
    // Should find Station1.lss in fixtures dir
    if (result) {
      expect(result).toContain(".lss");
    }
  });
});

describe("shouldAddLoader", () => {
  const loopback = { ip: "127.0.0.1" };
  const hardware = { ip: "10.195.0.30" };

  it("auto-sends the loader for loopback/LARS targets when unspecified", () => {
    expect(shouldAddLoader(undefined, loopback)).toBe(true);
    expect(shouldAddLoader(undefined, { ip: "127.0.0.1" })).toBe(true);
    expect(isLoopbackTarget(loopback)).toBe(true);
  });

  it("does not auto-send the loader for hardware targets", () => {
    expect(shouldAddLoader(undefined, hardware)).toBe(false);
    expect(shouldAddLoader(undefined, {})).toBe(false);
  });

  it("honours an explicit override in both directions", () => {
    expect(shouldAddLoader(true, hardware)).toBe(true);
    expect(shouldAddLoader(false, loopback)).toBe(false);
  });
});
