import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deploySolutionHandler } from "../../src/tools/deploySolution.js";

// Pure file-system test for the MachineManager .lutc builder (no engine needed).
// Still lives in the lab suite for consistency with the other end-to-end checks.

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

describe("LAB: deploy_solution dry-run", () => {
  it("builds a schema-correct .lutc with DwnLdLSE from a solution with a SlnScreenProject entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "lasal-lab-deploy-"));
    const solDir = join(root, "Solution");
    const stnDir = join(solDir, "Stations", "HMI");
    mkdirSync(stnDir, { recursive: true });

    const lprDir = join(root, "LSE_VISU");
    mkdirSync(lprDir, { recursive: true });
    const lpr = join(lprDir, "visu.lpr");
    writeFileSync(lpr, "binary-placeholder", "latin1");

    const lsm = join(solDir, "Solution.lsm");
    writeFileSync(
      lsm,
      `<Solution Name="Lab">\n  <SlnStationFiles>\n    <File Path=".\\Stations\\HMI\\HMI.lss"/>\n  </SlnStationFiles>\n</Solution>`,
      "latin1",
    );
    writeFileSync(
      join(stnDir, "HMI.lss"),
      `<SlnStation Name="HMI">\n  <OnlineConnectionInfo>\n    <TCPIP ConfigName="Panel" BUS="3" Password="" IP="10.9.9.9" PORT="1954" SomeFlags="0" PLCID="" Repeater="0" SSLTLS="0" Favorite="0"/>\n  </OnlineConnectionInfo>\n  <SlnProjects>\n    <SlnScreenProject Name="visu" File="..\\..\\..\\LSE_VISU\\visu.lpr">\n    </SlnScreenProject>\n  </SlnProjects>\n</SlnStation>`,
      "latin1",
    );

    const res = await deploySolutionHandler({
      lsm_path: lsm,
      stations: [{ station: "HMI", screen: true, run: true }],
      dry_run: true,
    });
    const body = parse(res as unknown as { content: Array<{ text: string }> });

    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(JSON.stringify(body.targets)).toContain("10.9.9.9");
    expect(JSON.stringify(body.instructions)).toContain("screen");
    const lutc = String(body.lutc ?? "");
    expect(lutc).toContain('<DwnLdLSE TargetId="0">');
    expect(lutc).toContain('<PrjRun TargetId="0">');
    expect(lutc).toContain('Station="HMI"');
  });
});
