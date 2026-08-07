import { describe, it, expect } from "vitest";
import { handleMcpRequest } from "../src/mcp.js";

// Duck-typed Request so we don't depend on the global Request constructor;
// handleMcpRequest only calls request.json().
const req = (body: unknown) => ({ json: async () => body }) as unknown as Request;
const noopHandler = async () => "";

describe("initialize / tools/list", () => {
  it("returns Path-A instructions pointing at begin_session", async () => {
    const res = await handleMcpRequest(
      req({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      noopHandler
    );
    const body = (await res.json()) as any;
    expect(body.result.serverInfo.name).toBe("Vault Bridge");
    expect(typeof body.result.instructions).toBe("string");
    expect(body.result.instructions).toContain("vault_begin_session");
    expect(body.result.instructions).toContain("vault_edit_range");
  });

  it("advertises all 18 tools, vault_-prefixed, including vault_move_file", async () => {
    const res = await handleMcpRequest(
      req({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      noopHandler
    );
    const body = (await res.json()) as any;
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("vault_get_outgoing_links");
    expect(names).toContain("vault_get_files_by_frontmatter");
    expect(names).toContain("vault_append_to_section");
    expect(names).toContain("vault_read_section");
    expect(names).toContain("vault_read_frontmatter");
    expect(names).toContain("vault_resolve_wikilink");
    expect(names).toContain("vault_create_file");
    expect(names).toContain("vault_edit_range");
    expect(names).toContain("vault_move_file");
    expect(names.length).toBe(18);
    // Every tool is prefixed — none collides with a filesystem MCP server.
    expect(names.every((n: string) => n.startsWith("vault_"))).toBe(true);
  });

  it("dispatches a vault_-prefixed call to the bare internal tool name", async () => {
    let received = "";
    const res = await handleMcpRequest(
      req({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "vault_read_file", arguments: { path: "x.md" } },
      }),
      async (tool) => {
        received = tool;
        return "ok";
      }
    );
    expect((await res.json() as any).result.content[0].text).toBe("ok");
    expect(received).toBe("read_file"); // prefix stripped for the handler
  });

  it("still accepts a bare (unprefixed) tool name for leniency", async () => {
    let received = "";
    await handleMcpRequest(
      req({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "read_file", arguments: { path: "x.md" } },
      }),
      async (tool) => {
        received = tool;
        return "ok";
      }
    );
    expect(received).toBe("read_file");
  });
});
