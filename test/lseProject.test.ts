import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  findLseOnlineConfig,
  updateLseOnlineConfig,
  readLseOnlineConfigTarget,
  lseRuntimeInfo,
} from "../src/utils/lseProject.js";

const SAMPLE_CFG = `<XML_ONLINE_CONFIGURATION>
<HEADER VERSION="109"/>
<SETTINGS>
<ONLINE>
<TCPIP ConfigName="MyARM_TEST" BUS="3" Password="" IP="10.10.116.222" PORT="1954" SomeFlags="0" PLCID="" Repeater="0" SSLTLS="0" Favorite="1"/>
</ONLINE>
<DOWNLOAD/>
<PROPERTIES DownlEqualOnl="1"/>
</SETTINGS>
<TCPIP ConfigName="MyARM_TEST" BUS="3" Password="" IP="10.10.116.222" PORT="1954" SomeFlags="0" PLCID="" Repeater="0" SSLTLS="0" Favorite="1"/>
</XML_ONLINE_CONFIGURATION>
`;

describe("LSE online config", () => {
  it("finds LSEOnlineConfig.xml next to the .lpr", () => {
    const dir = mkdtempSync(join(tmpdir(), "lse-cfg-"));
    const lpr = join(dir, "visu.lpr");
    writeFileSync(lpr, "binary", "latin1");
    const cfg = join(dir, "LSEOnlineConfig.xml");
    writeFileSync(cfg, SAMPLE_CFG, "latin1");
    expect(findLseOnlineConfig(lpr)).toBe(cfg);
  });

  it("reads the first TCPIP target", () => {
    const dir = mkdtempSync(join(tmpdir(), "lse-cfg-"));
    const cfg = join(dir, "LSEOnlineConfig.xml");
    writeFileSync(cfg, SAMPLE_CFG, "latin1");
    expect(readLseOnlineConfigTarget(cfg)).toEqual({ ip: "10.10.116.222", port: "1954" });
  });

  it("updates every TCPIP element, byte-preserving the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "lse-cfg-"));
    const cfg = join(dir, "LSEOnlineConfig.xml");
    writeFileSync(cfg, SAMPLE_CFG, "latin1");
    updateLseOnlineConfig(cfg, { ip: "127.0.0.1", port: "1964", ssltls: "1" });
    const updated = readFileSync(cfg, "latin1");
    expect((updated.match(/IP="127\.0\.0\.1"/g) ?? []).length).toBe(2);
    expect((updated.match(/PORT="1964"/g) ?? []).length).toBe(2);
    expect((updated.match(/SSLTLS="1"/g) ?? []).length).toBe(2);
    expect(updated).toContain('<PROPERTIES DownlEqualOnl="1"/>');
    expect(updated).toContain("MyARM_TEST");
  });

  it("throws when no TCPIP element exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "lse-cfg-"));
    const cfg = join(dir, "LSEOnlineConfig.xml");
    writeFileSync(cfg, "<XML_ONLINE_CONFIGURATION/>", "latin1");
    expect(() => updateLseOnlineConfig(cfg, { ip: "10.0.0.1" })).toThrow(/TCPIP/);
  });
});

describe("lseRuntimeInfo", () => {
  it("counts compiled files in the Runtime folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "lse-rt-"));
    const lpr = join(dir, "visu.lpr");
    writeFileSync(lpr, "binary", "latin1");
    const rt = join(dir, "Runtime");
    mkdirSync(rt);
    writeFileSync(join(rt, "a.bin"), "x");
    mkdirSync(join(rt, "sub"));
    writeFileSync(join(rt, "sub", "b.bin"), "y");

    const info = lseRuntimeInfo(lpr);
    expect(info.exists).toBe(true);
    expect(info.fileCount).toBe(2);
    expect(info.lastModifiedMs).toBeGreaterThan(0);
  });

  it("reports missing Runtime folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "lse-rt-"));
    const lpr = join(dir, "visu.lpr");
    writeFileSync(lpr, "binary", "latin1");
    const info = lseRuntimeInfo(lpr);
    expect(info.exists).toBe(false);
    expect(info.fileCount).toBe(0);
  });
});
