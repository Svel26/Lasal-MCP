import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import {
  addClassFileToManifest,
  addClassToFolders,
  addHeaderFileToManifest,
  clearProjectBuildArtifacts,
  clearProjectCaches,
  createClass,
  registerProjectFile,
  toProjectRelative,
} from "../src/utils/lcpManifest.js";

const FIXTURES = join(dirname(import.meta.filename), "fixtures");
const WORK = join(dirname(import.meta.filename), "_work-lcpmanifest");

const CUSTOM_LCP = `<?xml version="1.0" encoding="ISO-8859-1" ?>
<Project
\tVersion             = "14"
\tName                = "TestProject">
\t<HeaderFiles>
\t\t<File Path=".\\Class\\Motor\\Motor.h" Global="true"/>
\t</HeaderFiles>
\t<ClassFiles>
\t\t<File Path=".\\Class\\Motor\\Motor.st"/>
\t</ClassFiles>
\t<NetworkFiles>
\t\t<File Path=".\\Network\\Main.lcn"/>
\t</NetworkFiles>
\t<ClassFolders>
\t\t<Folder Name="Main">
\t\t\t<Class Name="Motor"/>
\t\t</Folder>
\t</ClassFolders>
</Project>
`;

function makeProject(): { dir: string; lcp: string } {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(join(WORK, "Class", "Motor"), { recursive: true });
  mkdirSync(join(WORK, "Network"), { recursive: true });
  mkdirSync(join(WORK, "ProjectInternal"), { recursive: true });
  writeFileSync(join(WORK, "ProjectInternal", "BrowserInfo.bin"), "x");
  writeFileSync(join(WORK, "ProjectInternal", "LobInfo.bin"), "x");
  const lcp = join(WORK, "TestProject.lcp");
  writeFileSync(lcp, CUSTOM_LCP, "latin1");
  return { dir: WORK, lcp };
}

beforeEach(() => {
  makeProject();
});

afterEach(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe("toProjectRelative", () => {
  it("normalizes absolute and relative paths to .\\ form", () => {
    const lcp = join(WORK, "TestProject.lcp");
    expect(toProjectRelative(lcp, join(WORK, "Class", "Foo", "C_Foo.cpp"))).toBe(".\\Class\\Foo\\C_Foo.cpp");
    expect(toProjectRelative(lcp, ".\\Class\\Foo\\C_Foo.cpp")).toBe(".\\Class\\Foo\\C_Foo.cpp");
    expect(toProjectRelative(lcp, "Class/Foo/C_Foo.cpp")).toBe(".\\Class\\Foo\\C_Foo.cpp");
  });
});

describe("class file manifest edits", () => {
  it("adds a class file with the section's indentation and is idempotent", () => {
    const { lcp } = makeProject();
    const first = addClassFileToManifest(lcp, ".\\Class\\PbLib\\PbLib.st");
    expect(first.changed).toBe(true);
    const content = readFileSync(lcp, "latin1");
    expect(content).toContain('\t\t<File Path=".\\Class\\PbLib\\PbLib.st"/>');

    const second = addClassFileToManifest(lcp, ".\\Class\\PbLib\\PbLib.st");
    expect(second.changed).toBe(false);
    expect(second.alreadyPresent).toEqual([".\\Class\\PbLib\\PbLib.st"]);
    expect(readFileSync(lcp, "latin1")).toBe(content);
  });

  it("adds a header file with the Global attribute", () => {
    const { lcp } = makeProject();
    addHeaderFileToManifest(lcp, ".\\Class\\PbLib\\C_PbLib.h", true);
    expect(readFileSync(lcp, "latin1")).toContain('<File Path=".\\Class\\PbLib\\C_PbLib.h" Global="true"/>');
  });

  it("adds a class into an existing folder", () => {
    const { lcp } = makeProject();
    const result = addClassToFolders(lcp, "PbLib", "Main");
    expect(result.changed).toBe(true);
    const content = readFileSync(lcp, "latin1");
    const mainFolder = content.slice(content.indexOf('<Folder Name="Main">'), content.indexOf("</Folder>"));
    expect(mainFolder).toContain('<Class Name="PbLib"/>');
    expect(mainFolder).toContain('<Class Name="Motor"/>');
  });

  it("creates a new folder when missing", () => {
    const { lcp } = makeProject();
    addClassToFolders(lcp, "PbLib", "IQ");
    const content = readFileSync(lcp, "latin1");
    expect(content).toContain('<Folder Name="IQ">');
    expect(content).toContain('<Class Name="PbLib"/>');
  });

  it("does not duplicate an existing class entry", () => {
    const { lcp } = makeProject();
    const result = addClassToFolders(lcp, "Motor", "Main");
    expect(result.changed).toBe(false);
  });
});

describe("clearProjectCaches", () => {
  it("deletes BrowserInfo.bin and LobInfo.bin only", () => {
    const { lcp } = makeProject();
    writeFileSync(join(WORK, "ProjectInternal", "Other.bin"), "keep");
    const cleared = clearProjectCaches(lcp);
    expect(cleared).toHaveLength(2);
    expect(existsSync(join(WORK, "ProjectInternal", "BrowserInfo.bin"))).toBe(false);
    expect(existsSync(join(WORK, "ProjectInternal", "Other.bin"))).toBe(true);
  });
});

describe("clearProjectBuildArtifacts", () => {
  it("also removes the .lcb and Network/ConfigObjects build artifacts", () => {
    const { lcp } = makeProject();
    writeFileSync(join(WORK, "TestProject.lcb"), "lcb");
    writeFileSync(join(WORK, "Network", "ConfigObjects.lob"), "lob");
    writeFileSync(join(WORK, "Network", "ConfigObjects.lba"), "lba");
    writeFileSync(join(WORK, "Class", "Motor", "Motor.st"), "// x");

    const cleared = clearProjectBuildArtifacts(lcp);
    expect(cleared).toHaveLength(5); // lcb + 2 config objects + 2 caches
    expect(existsSync(join(WORK, "TestProject.lcb"))).toBe(false);
    expect(existsSync(join(WORK, "Network", "ConfigObjects.lob"))).toBe(false);
    expect(existsSync(join(WORK, "Network", "ConfigObjects.lba"))).toBe(false);
    expect(existsSync(join(WORK, "ProjectInternal", "BrowserInfo.bin"))).toBe(false);
    expect(existsSync(join(WORK, "Class", "Motor", "Motor.st"))).toBe(true);
  });
});

describe("registerProjectFile", () => {
  it("registers an existing .h in HeaderFiles and clears caches", () => {
    const { lcp } = makeProject();
    const h = join(WORK, "Class", "Motor", "C_Motor.h");
    writeFileSync(h, "// header", "latin1");
    const result = registerProjectFile(lcp, h, { global: true });
    expect(result.changed).toBe(true);
    expect(readFileSync(lcp, "latin1")).toContain('<File Path=".\\Class\\Motor\\C_Motor.h" Global="true"/>');
    expect(existsSync(join(WORK, "ProjectInternal", "BrowserInfo.bin"))).toBe(false);
  });

  it("rejects a missing file", () => {
    const { lcp } = makeProject();
    expect(() => registerProjectFile(lcp, join(WORK, "nope.cpp"))).toThrow(/File not found/);
  });
});

describe("createClass", () => {
  it("scaffolds a class, registers it and creates dependency content", () => {
    const { lcp } = makeProject();
    const result = createClass(lcp, {
      name: "PbLib",
      folder: "IQ",
      comment: "encode helpers",
      servers: [{ name: "State", type: "SvrCh_UDINT", retentive: true }],
      files: [
        { path: ".\\Class\\PbLib\\C_PbLib.h", content: "#ifndef _C_PBLIB_H_\n#define _C_PBLIB_H_\n#endif\n" },
        {
          path: ".\\Class\\PbLib\\C_PbLib.cpp",
          content: 'extern "C" unsigned long pblib_encode(void) { return 0; }\n',
        },
      ],
    });

    const st = readFileSync(result.stPath, "latin1");
    expect(st).toContain('Name               = "PbLib"');
    expect(st).toContain('#include "..\\..\\Class\\PbLib\\C_PbLib.h"');
    expect(st).toContain("ClassSvr.pMeth");
    expect(st).toContain('TO_UDINT(619352855), "ClassSvr"');
    expect(st).toContain("(::PbLib.State.pMeth)$UINT, _CH_SVR$UINT, 2#0000000000001000$UINT");
    expect(st).toContain("FUNCTION GLOBAL TAB PbLib::@CT_");
    expect(st).toContain("C_PbLib.cpp");

    const manifest = readFileSync(lcp, "latin1");
    expect(manifest).toContain('<File Path=".\\Class\\PbLib\\PbLib.st"/>');
    expect(manifest).toContain('<File Path=".\\Class\\PbLib\\C_PbLib.cpp"/>');
    expect(manifest).toContain('<File Path=".\\Class\\PbLib\\C_PbLib.h"/>');
    expect(manifest).toContain('<Folder Name="IQ">');
    expect(manifest).toContain('<Class Name="PbLib"/>');

    expect(existsSync(join(WORK, "Class", "PbLib", "C_PbLib.cpp"))).toBe(true);
    expect(result.cachesCleared).toHaveLength(2);
  });

  it("rejects invalid names, invalid server types and duplicates", () => {
    const { lcp } = makeProject();
    expect(() => createClass(lcp, { name: "1Bad" })).toThrow(/Invalid class name/);
    expect(() => createClass(lcp, { name: "Ok", servers: [{ name: "X", type: "DINT" }] })).toThrow(
      /Invalid server type/,
    );
    createClass(lcp, { name: "Twice" });
    expect(() => createClass(lcp, { name: "Twice" })).toThrow(/already exists/);
  });
});
