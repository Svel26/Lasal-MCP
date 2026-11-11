import { describe, expect, it } from "vitest";
import { buildInitRecommendation, renderInitRecommendation } from "../src/cli/init.js";
import type { ProjectContext } from "../src/core/project/context.js";

function context(profile: ProjectContext["recommendedProfile"]): ProjectContext {
  return {
    id: "abc123def456",
    root: "C:\\Projects\\Demo",
    stations: [],
    capabilities: {
      class2: profile === "class2" || profile === "solution",
      visu: profile === "visu" || profile === "solution",
      screen: profile === "screen" || profile === "solution",
      machineManager: false,
    },
    recommendedProfile: profile,
  };
}

describe("lasal-mcp init recommendation", () => {
  it("selects the matching domain bin", () => {
    expect(buildInitRecommendation(context("class2")).serverName).toBe("lasal-class2");
    expect(buildInitRecommendation(context("visu")).serverName).toBe("lasal-visu");
    expect(buildInitRecommendation(context("screen")).serverName).toBe("lasal-screen");
    expect(buildInitRecommendation(context("solution")).serverName).toBe("lasal-solution");
  });

  it("writes a pinned project into the MCP config", () => {
    const recommendation = buildInitRecommendation(context("visu"));
    const server = recommendation.config.mcpServers["lasal-visu"];
    expect(server?.command).toBe("node");
    expect(server?.args).toContain("--project");
    expect(server?.args).toContain("C:\\Projects\\Demo");
    expect(server?.args[0]?.replace(/\\/g, "/")).toContain("dist/servers/visu.js");
  });

  it("suggests LARS for CLASS 2 and SCREEN projects", () => {
    expect(buildInitRecommendation(context("class2")).notes.join(" ")).toContain("lasal-lars-mcp");
    expect(buildInitRecommendation(context("screen")).notes.join(" ")).toContain("lasal-lars-mcp");
    expect(buildInitRecommendation(context("visu")).notes.join(" ")).not.toContain("lasal-lars-mcp");
  });

  it("renders a copy-pasteable recommendation", () => {
    const ctx = context("class2");
    const text = renderInitRecommendation(ctx, buildInitRecommendation(ctx));
    expect(text).toContain("Recommended profile: class2");
    expect(text).toContain('"lasal-class2"');
    expect(text).toContain("--allow-destructive");
  });
});
