import { describe, expect, it } from "vitest";
import {
  buildScenarioBody,
  larsScenarioStepSchema,
  renderJUnit,
  type ScenarioStepResult,
} from "../src/tools/larsScenario.js";
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
    expect(
      larsScenarioStepSchema.safeParse({ type: "read", channels: ["Motor1.s_Speed"], saveAs: "speed" }).success,
    ).toBe(true);
    expect(larsScenarioStepSchema.safeParse({ type: "trace_start", config_path: "C:\\trace.xml" }).success).toBe(true);
    expect(larsScenarioStepSchema.safeParse({ type: "trace_stop" }).success).toBe(true);
    expect(larsScenarioStepSchema.safeParse({ type: "screenshot", workspace: "PLC" }).success).toBe(true);
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

  it("adds saved reads, trace and screenshot support to the one-connection body", () => {
    const body = buildScenarioBody(
      "TCPIP:127.0.0.1:1954",
      "C:\\Temp\\scenario.json",
      [
        { type: "trace_start", config_path: "C:\\trace.xml" },
        { type: "read", channels: ["Motor1.s_Speed"], saveAs: "speed" },
        { type: "screenshot", name: "after-start" },
        { type: "trace_stop", output_path: "C:\\Temp\\trace.csv" },
      ],
      {
        artifactsDir: "C:\\Temp\\scenario-artifacts",
        screenshotScriptPath: "C:\\Temp\\capture.ps1",
        workspace: "MyProject_PLC",
      },
    ).join("\n");

    expect(body).toContain("saved[name] = values");
    expect(body).toContain("batch.DataAnalyzerLoadConfig");
    expect(body).toContain("batch.DataAnalyzerRun");
    expect(body).toContain("batch.DataAnalyzerStop");
    expect(body).toContain("batch.DataAnalyzerSaveData");
    expect(body).toContain("subprocess.call(cmd)");
    expect(body).toContain("'artifacts': artifacts");
    expect(body).toContain("'saved': saved");
  });

  it("renders JUnit XML with failures and escaping", () => {
    const steps: ScenarioStepResult[] = [
      { index: 0, type: "set", ok: true },
      { index: 1, type: "assert", ok: false, error: "expected < 5 & got 7" },
    ];
    const xml = renderJUnit(steps, false);
    expect(xml).toContain('tests="2" failures="1"');
    expect(xml).toContain('name="1_assert"');
    expect(xml).toContain("expected &lt; 5 &amp; got 7");
  });

  it("registers lars.scenario.run as an async project action", () => {
    const action = createPilotRegistry().get("lars.scenario.run");
    expect(action).toBeDefined();
    expect(action?.requiresProject).toBe(true);
    expect(action?.asyncCapable).toBe(true);
    expect(action?.risk).toBe("write");
  });
});
