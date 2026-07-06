import { describe, it, expect } from "vitest";
import { join, dirname } from "path";
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
});
