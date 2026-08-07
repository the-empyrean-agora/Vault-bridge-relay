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
    expect(body.result.instructions).toContain("begin_session");
    expect(body.result.instructions).toContain("edit_range");
  });

  it("advertises all 18 tools, including move_file", async () => {
    const res = await handleMcpRequest(
      req({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      noopHandler
    );
    const body = (await res.json()) as any;
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("get_outgoing_links");
    expect(names).toContain("get_files_by_frontmatter");
    expect(names).toContain("append_to_section");
    expect(names).toContain("read_section");
    expect(names).toContain("read_frontmatter");
    expect(names).toContain("resolve_wikilink");
    expect(names).toContain("create_file");
    expect(names).toContain("edit_range");
    expect(names).toContain("move_file");
    expect(names.length).toBe(18);
  });
});
