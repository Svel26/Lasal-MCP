import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("Tool Annotations", () => {
  it("allows setting readOnlyHint and destructiveHint on tools", () => {
    const server = new McpServer({ name: "test-server", version: "1.0.0" });

    server.tool("read_test", "desc", {}, { readOnlyHint: true, idempotentHint: true }, () => ({
      content: [],
    }));

    server.tool("delete_test", "desc", {}, { destructiveHint: true }, () => ({
      content: [],
    }));

    const tools = (server as any)._registeredTools;
    expect(tools["read_test"].annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
    expect(tools["delete_test"].annotations).toEqual({ destructiveHint: true });
  });
});
