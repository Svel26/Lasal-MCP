import { describe, it, expect } from "vitest";
import { buildBatchScript, emitPy27String, emitPath, validateMbcsEncodable, type BatchOp } from "../src/utils/batchScript.js";

describe("emitPy27String", () => {
  it("wraps a plain string", () => {
    expect(emitPy27String("hello")).toBe('u"hello".encode(\'mbcs\')');
  });

  it("escapes backslashes", () => {
    expect(emitPy27String("C:\\foo\\bar")).toBe('u"C:\\\\foo\\\\bar".encode(\'mbcs\')');
  });

  it("escapes double quotes", () => {
    expect(emitPy27String('say "hi"')).toBe('u"say \\"hi\\"".encode(\'mbcs\')');
  });

  it("handles empty string", () => {
    expect(emitPy27String("")).toBe('u"".encode(\'mbcs\')');
  });

  it("accepts latin1 characters (U+00FF and below)", () => {
    expect(() => emitPy27String("café")).not.toThrow();
    expect(() => emitPy27String("Ü")).not.toThrow();
  });

  it("rejects characters outside latin1 range", () => {
    expect(() => emitPy27String("日本語")).toThrow(/not representable in mbcs/);
    expect(() => emitPy27String("path/to/名前")).toThrow(/not representable in mbcs/);
  });
});

describe("validateMbcsEncodable", () => {
  it("passes for ASCII strings", () => {
    expect(() => validateMbcsEncodable("hello world")).not.toThrow();
  });

  it("passes for latin1 extended characters", () => {
    expect(() => validateMbcsEncodable("ÄÖÜäöüß")).not.toThrow();
  });

  it("throws for emoji", () => {
    expect(() => validateMbcsEncodable("test 🎉")).toThrow(/not representable in mbcs/);
  });
});

describe("buildBatchScript", () => {
  it("generates a valid Python 2.7 script preamble", () => {
    const { script } = buildBatchScript("C:\\proj\\test.lcp", [], "C:\\tmp\\test.log", "C:\\tmp\\test.steps");
    expect(script).toContain("# -*- coding: utf-8 -*-");
    expect(script).toContain("import sigmatek.lasal.batch as batch");
    expect(script).toContain("batch.SetExceptionOnError(True)");
    expect(script).toContain("batch.Save(prj)");
    expect(script).toContain("batch.CloseProject(prj)");
  });

  it("emits compile operation", () => {
    const ops: BatchOp[] = [{ type: "compile", optionName: "RebuildAll" }];
    const { script, expectedSteps } = buildBatchScript("C:\\proj\\test.lcp", ops, "C:\\tmp\\test.log", "C:\\tmp\\test.steps");
    expect(script).toContain("batch.Compile(prj, batch.CompileOptions.RebuildAll)");
    expect(expectedSteps).toContain("0_compile");
  });

  it("emits create_network operation", () => {
    const ops: BatchOp[] = [{ type: "create_network", name: "TestNet" }];
    const { script } = buildBatchScript("C:\\proj\\test.lcp", ops, "C:\\tmp\\test.log", "C:\\tmp\\test.steps");
    expect(script).toContain("batch.CreateNetwork(prj,");
    expect(script).toContain("TestNet");
  });

  it("emits add_object operation", () => {
    const ops: BatchOp[] = [{
      type: "add_object",
      network: "Main",
      className: "Motor",
      objectName: "Motor1",
      x: 100,
      y: 200,
      visualized: true,
    }];
    const { script } = buildBatchScript("C:\\proj\\test.lcp", ops, "C:\\tmp\\test.log", "C:\\tmp\\test.steps");
    expect(script).toContain("batch.CreateObject(prj,");
    expect(script).toContain("Motor");
    expect(script).toContain("Motor1");
  });

  it("emits create_connection with network", () => {
    const ops: BatchOp[] = [{
      type: "create_connection",
      network: "Main",
      fromObject: "Sensor1",
      fromClient: "c_Out",
      toObject: "Motor1",
      toServer: "s_In",
    }];
    const { script } = buildBatchScript("C:\\proj\\test.lcp", ops, "C:\\tmp\\test.log", "C:\\tmp\\test.steps");
    expect(script).toContain("batch.CreateConnection(prj,");
  });

  it("emits create_connection without network (uses CreateConnection2)", () => {
    const ops: BatchOp[] = [{
      type: "create_connection",
      fromObject: "Sensor1",
      fromClient: "c_Out",
      toObject: "Motor1",
      toServer: "s_In",
    }];
    const { script } = buildBatchScript("C:\\proj\\test.lcp", ops, "C:\\tmp\\test.log", "C:\\tmp\\test.steps");
    expect(script).toContain("batch.CreateConnection2(prj,");
  });

  it("emits download with state readback", () => {
    const ops: BatchOp[] = [{ type: "download", connection: "TCPIP:10.0.0.1" }];
    const { script } = buildBatchScript("C:\\proj\\test.lcp", ops, "C:\\tmp\\test.log", "C:\\tmp\\test.steps");
    expect(script).toContain("batch.Download(prj,");
    expect(script).toContain("batch.GetPlcState(prj,");
    expect(script).toContain("json.dump(result, f_state)");
  });

  it("emits step markers for each operation", () => {
    const ops: BatchOp[] = [
      { type: "create_network", name: "Net1" },
      { type: "compile" },
    ];
    const { script, expectedSteps } = buildBatchScript("C:\\proj\\test.lcp", ops, "C:\\tmp\\test.log", "C:\\tmp\\test.steps");
    expect(expectedSteps).toEqual(["0_create_network", "1_compile"]);
    expect(script).toContain("STEP 0_create_network OK");
    expect(script).toContain("STEP 1_compile OK");
  });

  it("emits set_task_order operation", () => {
    const ops: BatchOp[] = [{
      type: "set_task_order",
      network: "Main",
      objectName: "Motor1",
      task: "CyclicTask",
      position: 1,
    }];
    const { script } = buildBatchScript("C:\\proj\\test.lcp", ops, "C:\\tmp\\test.log", "C:\\tmp\\test.steps");
    expect(script).toContain("batch.SetTaskOrder(prj,");
  });

  it("emits set_init_value with network", () => {
    const ops: BatchOp[] = [{
      type: "set_init_value",
      network: "Main",
      objectName: "Motor1",
      channelName: "s_Speed",
      value: "100",
    }];
    const { script } = buildBatchScript("C:\\proj\\test.lcp", ops, "C:\\tmp\\test.log", "C:\\tmp\\test.steps");
    expect(script).toContain("batch.SetInitValue(prj,");
  });

  it("emits set_init_value without network (uses SetInitValue2)", () => {
    const ops: BatchOp[] = [{
      type: "set_init_value",
      objectName: "Motor1",
      channelName: "s_Speed",
      value: "100",
    }];
    const { script } = buildBatchScript("C:\\proj\\test.lcp", ops, "C:\\tmp\\test.log", "C:\\tmp\\test.steps");
    expect(script).toContain("batch.SetInitValue2(prj,");
  });

  it("wraps everything in try/except", () => {
    const { script } = buildBatchScript("C:\\proj\\test.lcp", [], "C:\\tmp\\test.log", "C:\\tmp\\test.steps");
    expect(script).toContain("except Exception as e:");
    expect(script).toContain("traceback.print_exc()");
    expect(script).toContain("sys.exit(1)");
  });
});
