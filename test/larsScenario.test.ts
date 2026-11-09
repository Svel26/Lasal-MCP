import { describe, expect, it } from "vitest";
import { buildScenarioBody, larsScenarioStepSchema } from "../src/tools/larsScenario.js";
import { createPilotRegistry } from "../src/core/actions/pilotCatalog.js";

describe("LARS scenario builder", () => {
  it("validates supported step types", () => {
    expect(larsScenarioStepSchema.safeParse({ type: "set", channel: "Motor1.s_Speed", value: "1200" }).success).toBe(
      true,
    );
    expect(
      larsScenarioStepSchema.safeParse({
        type: "wait",
        channel: "Motor1.s_Speed",
        equals: "1200",
        timeout_ms: 1000,
      }).success,
    ).toBe(true);
    expect(larsScenarioStepSchema.safeParse({ type: "sleep", ms: 100 }).success).toBe(true);
    expect(larsScenarioStepSchema.safeParse({ type: "unknown" }).success).toBe(false);
  });

  it("builds one connection and one result file for the whole scenario", () => {
    const body = buildScenarioBody("TCPIP:127.0.0.1:1954", "C:\\Temp\\scenario.json", [
      { type: "set", channel: "Motor1.s_Speed", value: "1200" },
      { type: "wait", channel: "Motor1.s_Speed", equals: "1200", timeout_ms: 2000, poll_ms: 100 },
      { type: "assert", channel: "Motor1.s_Speed", min: 1100, max: 1300 },
      { type: "read", channels: ["Motor1.s_Speed"] },
      { type: "sleep", ms: 50 },
    ]).join("\n");

    expect(body).toContain("batch.OpenPlcConnection");
    expect(body.match(/batch\.OpenPlcConnection/g)).toHaveLength(1);
    expect(body).toContain("batch.ClosePlcConnection()");
    expect(body).toContain("json.loads");
    expect(body).toContain("condition_met");
    expect(body).toContain("write_result()");
    expect(body).toContain("raise RuntimeError('Scenario failed')");
  });

  it("registers lars.scenario.run as an async project action", () => {
    const action = createPilotRegistry().get("lars.scenario.run");
    expect(action).toBeDefined();
    expect(action?.requiresProject).toBe(true);
    expect(action?.asyncCapable).toBe(true);
    expect(action?.risk).toBe("write");
  });
});
