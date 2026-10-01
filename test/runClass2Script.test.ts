import { describe, it, expect } from "vitest";
import { buildClass2ScriptBody } from "../src/tools/runClass2Script.js";

describe("buildClass2ScriptBody", () => {
  it("passes the script body through unchanged", () => {
    const body = buildClass2ScriptBody("batch.Save(prj)");
    expect(body).toEqual(["batch.Save(prj)"]);
  });

  it("normalizes CRLF and keeps multi-line bodies", () => {
    const body = buildClass2ScriptBody("a = 1\r\nb = 2");
    expect(body).toEqual(["a = 1", "b = 2"]);
  });

  it("injects sys.argv only when arguments are provided", () => {
    expect(buildClass2ScriptBody("pass")).toHaveLength(1);
    const withArgs = buildClass2ScriptBody("pass", ["C75", 'say "hi"']);
    expect(withArgs[0]).toBe(
      'sys.argv = [u"class2_script"] + [u"C75".encode(\'mbcs\'), u"say \\"hi\\"".encode(\'mbcs\')]',
    );
    expect(withArgs[1]).toBe("pass");
  });
});
