import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerResources } from "../src/resources/registerResources.js";
import { writeState } from "../src/state.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("Dynamic Resources & Resource Templates", () => {
  let server: McpServer;
  let stateDir: string;

  beforeEach(() => {
    server = new McpServer({ name: "test-server", version: "1.0.0" });
    stateDir = mkdtempSync(join(tmpdir(), "lasal-mcp-state-"));
    process.env.LASAL_MCP_STATE_FILE = join(stateDir, "lasal-state.json");
    writeState({ currentProject: FIXTURES });
  });

  afterEach(() => {
    delete process.env.LASAL_MCP_STATE_FILE;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("registers static and dynamic resources on the McpServer", () => {
    registerResources(server, "# Guide Content");
    // McpServer stores registered resources and templates internally
    const registeredResources = (server as any)._registeredResources;
    const registeredTemplates = (server as any)._registeredResourceTemplates;

    expect(registeredResources["lasal://guide"]).toBeDefined();
    expect(registeredResources["lasal://project/status"]).toBeDefined();
    expect(registeredResources["lasal://stations"]).toBeDefined();

    const classTemplate = Object.values(registeredTemplates).find((t: any) =>
      t.resourceTemplate.uriTemplate.toString().includes("classes/{className}"),
    );
    expect(classTemplate).toBeDefined();
  });

  it("reads the static guide content", async () => {
    registerResources(server, "# Guide Content");
    const guideResource = (server as any)._registeredResources["lasal://guide"];
    const result = await guideResource.readCallback(new URL("lasal://guide"), {});
    expect(result.contents[0].text).toBe("# Guide Content");
    expect(result.contents[0].mimeType).toBe("text/markdown");
  });

  it("reads dynamic project status with active project data", async () => {
    registerResources(server, "guide");
    const statusResource = (server as any)._registeredResources["lasal://project/status"];
    const result = await statusResource.readCallback(new URL("lasal://project/status"), {});
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.currentProject).toBe(FIXTURES);
    expect(Array.isArray(parsed.lcpPaths)).toBe(true);
  });
});
