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
