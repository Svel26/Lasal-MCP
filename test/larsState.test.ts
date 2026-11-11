import { describe, it, expect } from "vitest";
import { mergeLarsInstance, getLarsInstance, type LasalState } from "../src/state.js";

// setup() only knows configuration (ports, station paths). It must not erase runtime
// bookkeeping it does not set: replacing the record made the "never claim a port
// another running instance owns" guard trust a stale port and grab the wrong
// instance's online port.
describe("mergeLarsInstance", () => {
  it("preserves runtime bookkeeping the caller does not set", () => {
    const state: LasalState = { currentProject: null };
    mergeLarsInstance(state, {
      name: "PLC",
      onlinePort: 1974,
      stationName: "PLC",
      effectiveOnlinePort: 1954,
      pid: 1234,
      originalIp: "10.195.0.30",
      originalPort: "1954",
      stationTargetOverridden: true,
      originalTargetTag: '<Target UseFPU="true" Processor="ARM">',
    });

    // A later setup() pass knows only configuration.
    mergeLarsInstance(state, { name: "PLC", onlinePort: 1974, stationName: "PLC", role: "plc" });

    const inst = getLarsInstance(state, "PLC")!;
    expect(inst.effectiveOnlinePort).toBe(1954);
    expect(inst.pid).toBe(1234);
    expect(inst.originalIp).toBe("10.195.0.30");
    expect(inst.stationTargetOverridden).toBe(true);
    expect(inst.originalTargetTag).toContain("ARM");
    expect(inst.role).toBe("plc");
  });

  it("updates fields the caller does provide", () => {
    const state: LasalState = { currentProject: null };
    mergeLarsInstance(state, { name: "PLC", onlinePort: 1974, stationLssPath: "C:\\a.lss" });
    mergeLarsInstance(state, { name: "PLC", onlinePort: 1984, stationLssPath: "C:\\b.lss" });
    const inst = getLarsInstance(state, "PLC")!;
    expect(inst.onlinePort).toBe(1984);
    expect(inst.stationLssPath).toBe("C:\\b.lss");
  });

  it("ignores undefined values so a missing .lss cannot wipe a known path", () => {
    const state: LasalState = { currentProject: null };
    mergeLarsInstance(state, { name: "HMI", onlinePort: 1964, stationLssPath: "C:\\hmi.lss" });
    mergeLarsInstance(state, { name: "HMI", onlinePort: 1964, stationLssPath: undefined });
    expect(getLarsInstance(state, "HMI")!.stationLssPath).toBe("C:\\hmi.lss");
  });

  it("creates the record when none exists", () => {
    const state: LasalState = { currentProject: null };
    const inst = mergeLarsInstance(state, { name: "New", onlinePort: 1954 });
    expect(inst.name).toBe("New");
    expect(getLarsInstance(state, "New")!.onlinePort).toBe(1954);
  });
});
