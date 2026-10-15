import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runLseOps } from "../../src/utils/lseScript.js";
import { getLseRegistration } from "../../src/utils/engine.js";

// Requires LASAL SCREEN with the automation component registered. Run via: npm run test:lab
const ENABLED = process.env.LASAL_LAB === "1";
const d = ENABLED ? describe : describe.skip;

d("LAB: LASAL SCREEN on a fresh project", () => {
  it("creates a new .lpr, edits text lists, inventories and compiles it", async () => {
    const reg = getLseRegistration();
    expect(reg.registered, "LASALScreen.Application must be registered").toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "lasal-lab-lse-"));
    const lpr = join(dir, "LabVisu.lpr");

    // 1. Fresh project (IApplication.New) + text list content
    const created = await runLseOps(
      lpr,
      [
        { type: "textlist_create", name: "LabList", text: "Hello" },
        { type: "textlist_add_text", text_list: "LabList", text: "World" },
      ],
      { create: true, timeoutMs: 180_000 },
    );
    expect(created.ok, JSON.stringify({ errors: created.errors, data: created.data })).toBe(true);
    expect(existsSync(lpr)).toBe(true);

    // 2. Inventory the fresh project
    const info = await runLseOps(lpr, [{ type: "info" }], { timeoutMs: 180_000 });
    expect(info.ok, JSON.stringify(info.errors)).toBe(true);
    const textLists = (info.data?.textLists as Array<{ name: string; itemCount: number }>) ?? [];
    expect(textLists.some((t) => t.name === "LabList")).toBe(true);

    // 3. Read texts back from the persisted project
    const texts = await runLseOps(lpr, [{ type: "textlist_get_texts", text_list: "LabList" }], {
      timeoutMs: 180_000,
    });
    expect(texts.ok, JSON.stringify(texts.errors)).toBe(true);
    const items = (texts.data?.textItems as Array<Record<string, string>>) ?? [];
    expect(items.length).toBeGreaterThan(0);

    // 4. Compile (creates the Runtime output folder)
    const compiled = await runLseOps(lpr, [{ type: "compile" }], { saveAtEnd: true, timeoutMs: 300_000 });
    expect(compiled.ok, JSON.stringify(compiled.errors)).toBe(true);
    // Runtime folder presence is informational — not asserted hard, some engine builds place it lazily.
    console.log("[lab] LSE Runtime folder exists:", existsSync(join(dir, "Runtime")));

    // 5. XML text export gate watchdog: with LSE 01.01.197 automation this is expected to
    //    fail with "No language selected". If it starts passing, Sigmatek fixed the gate
    //    and the export_xml op can be upgraded to a first-class feature.
    const xmlPath = join(dir, "export.xml");
    const exported = await runLseOps(lpr, [{ type: "export_xml", path: xmlPath }], { timeoutMs: 180_000 });
    if (exported.ok) {
      console.log("[lab] XML export gate is FIXED in this LASAL SCREEN build — consider promoting export_xml!");
      expect(existsSync(xmlPath)).toBe(true);
    } else {
      const msg = [...exported.errors, String(exported.data?.error ?? "")].join(" ");
      console.log("[lab] XML export gate still present:", msg.slice(0, 200));
      expect(/language/i.test(msg), `expected the known language-gate error, got: ${msg}`).toBe(true);
    }
  });
});
