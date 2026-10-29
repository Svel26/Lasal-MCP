import { describe, it, expect } from "vitest";
import { join, dirname } from "path";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { parseLss } from "../src/utils/projectScanner.js";

const FIXTURES = join(dirname(import.meta.filename), "fixtures");

describe("parseLss", () => {
  it("parses station name", () => {
    const info = parseLss(join(FIXTURES, "Station1.lss"));
    expect(info.name).toBe("Station1");
  });

  it("extracts TCPIP connection info", () => {
    const info = parseLss(join(FIXTURES, "Station1.lss"));
    expect(info.ip).toBe("10.195.0.50");
    expect(info.port).toBe("1954");
    expect(info.ssltls).toBe("false");
  });

  it("reads the active profile when several <TCPIP> profiles exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "lss-"));
    const lss = join(dir, "PLC.lss");
    writeFileSync(
      lss,
      `<SlnStation Name="PLC" OnlineConnection="LARS">
  <OnlineConnectionInfo>
    <TCPIP ConfigName="PLC50" IP="10.195.0.50" PORT="1954" SSLTLS="0"/>
    <TCPIP ConfigName="LARS" IP="127.0.0.1" PORT="2004" SSLTLS="0"/>
  </OnlineConnectionInfo>
  <SlnProjects>
    <SlnClassProject File="p.lcp"/>
  </SlnProjects>
</SlnStation>`,
      "latin1",
    );
    const info = parseLss(lss);
    expect(info.ip).toBe("127.0.0.1");
    expect(info.port).toBe("2004");
  });

  it("parses SlnScreenProject (.lpr) references", () => {
    const dir = mkdtempSync(join(tmpdir(), "lss-"));
    writeFileSync(join(dir, "p.lpr"), "binary", "latin1");
    const lss = join(dir, "Station.lss");
    writeFileSync(
      lss,
      `<SlnStation Name="HMI">\n<SlnProjects>\n<SlnClassProject File="p.lcp"/>\n<SlnScreenProject File="p.lpr"/>\n</SlnProjects>\n</SlnStation>`,
      "latin1",
    );
    const info = parseLss(lss);
    expect(info.lprPaths).toEqual([join(dir, "p.lpr")]);
    // p.lcp does not exist on disk and must be skipped
    expect(info.lcpPaths).toEqual([]);
  });
});
