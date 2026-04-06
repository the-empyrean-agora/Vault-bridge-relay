/**
 * MCP protocol handler — JSON-RPC 2.0 over HTTP.
 *
 * Handles initialize, tools/list, and tools/call.
 * Stateless: no session tracking needed.
 */

/** Callback to broker a tool call to the connected client */
export type ToolHandler = (
  tool: string,
  params: Record<string, unknown>
) => Promise<string>;

// --- Tool definitions (v1 parity) ---

const TOOL_DEFINITIONS = [
  {
    name: "list_directory",
    description:
      "List the immediate contents of a directory in the Obsidian vault. Returns directories first (with trailing /) then files, sorted. Hidden entries are excluded. Use this to explore unfamiliar parts of the vault. For listing files modified recently across the whole vault, use get_recent_files instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the directory (empty string for vault root, e.g. 'notes' or 'projects/2026')",
          default: "",
        },
      },
    },
  },
  {
    name: "read_file",
    description:
      "Read the full content of a file in the vault. Use this when you know (or can guess) the exact path. Fast and exact — prefer this over search_files when you have a specific file in mind.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the file within the vault, including extension (e.g. 'notes/my-note.md')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create a new file or overwrite an existing one. Creates parent directories as needed. The vault index is updated immediately so the next search/get_backlinks/list_tags call will see the new file.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Relative path for the file within the vault (e.g. 'notes/new-note.md')",
        },
        content: {
          type: "string",
          description: "The full text content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "delete_file",
    description:
      "Permanently delete a file from the vault. The deletion will sync down to the user's local Obsidian vault on its next sync. Use sparingly — there's no undo. Confirm with the user before destructive deletes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Relative path of the file to delete",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description:
      "Search the vault. Index-backed and fast. Supports several query forms:\n  • plain text → matches filename, tags, and content tokens (filename matches scored highest)\n  • #tagname → exact tag match (e.g. '#project')\n  • path:somefolder → files whose path starts with the given prefix\n  • filename:foo → match in filename only\n\nReturns up to 50 results, ranked by relevance, each with a short preview snippet. For very specific known paths, prefer read_file.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search query. Case-insensitive. See description for query forms.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_backlinks",
    description:
      "Find all files that link TO the given file via wikilinks ([[...]]) or markdown links ([text](path.md)). Useful for discovering connections, building knowledge graphs, or understanding which notes reference a given concept.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Relative path of the file to find backlinks for (e.g. 'notes/big-idea.md')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_tags",
    description:
      "List every unique tag in the vault with usage counts, sorted by most-used first. Includes both inline tags (#tag) and frontmatter tags. Useful when the user asks 'what tags do I have' or 'what topics do I write about'.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_recent_files",
    description:
      "List files modified in the last N days, most recent first. Useful when the user asks 'what was I working on yesterday', 'show me this week's notes', or wants to find recently-edited files without knowing their paths.",
    inputSchema: {
      type: "object" as const,
      properties: {
        days: {
          type: "number",
          description: "How many days back to look (default 7)",
          default: 7,
        },
        limit: {
          type: "number",
          description: "Maximum number of files to return (default 25)",
          default: 25,
        },
      },
    },
  },
];

// --- JSON-RPC types ---

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// --- Handler ---

/**
 * Process an MCP HTTP request body and return an HTTP Response.
 *
 * Handles JSON-RPC requests for the MCP protocol:
 * - initialize → server info + capabilities
 * - notifications/initialized → 202 Accepted (no response body)
 * - tools/list → tool definitions
 * - tools/call → dispatch to toolHandler
 */
export async function handleMcpRequest(
  request: Request,
  toolHandler: ToolHandler
): Promise<Response> {
  // Parse request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonRpcErrorResponse(null, -32700, "Parse error");
  }

  // Handle single request (not batches — Claude sends one at a time)
  const msg = body as JsonRpcRequest;
  if (!msg.jsonrpc || msg.jsonrpc !== "2.0" || !msg.method) {
    return jsonRpcErrorResponse(
      msg.id ?? null,
      -32600,
      "Invalid JSON-RPC request"
    );
  }

  // Notifications (no id) — acknowledge without response body
  if (msg.id === undefined) {
    return new Response(null, { status: 202 });
  }

  switch (msg.method) {
    case "initialize":
      return jsonRpcResponse(msg.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "Vault Bridge", version: "0.1.0" },
      });

    case "tools/list":
      return jsonRpcResponse(msg.id, { tools: TOOL_DEFINITIONS });

    case "tools/call":
      return handleToolsCall(msg, toolHandler);

    default:
      return jsonRpcErrorResponse(
        msg.id,
        -32601,
        `Method not found: ${msg.method}`
      );
  }
}

async function handleToolsCall(
  msg: JsonRpcRequest,
  toolHandler: ToolHandler
): Promise<Response> {
  const params = msg.params as
    | { name?: string; arguments?: Record<string, unknown> }
    | undefined;

  const toolName = params?.name;
  const toolArgs = params?.arguments ?? {};

  if (!toolName) {
    return jsonRpcErrorResponse(msg.id!, -32602, "Missing tool name");
  }

  const validTools = TOOL_DEFINITIONS.map((t) => t.name);
  if (!validTools.includes(toolName)) {
    return jsonRpcErrorResponse(
      msg.id!,
      -32602,
      `Unknown tool: ${toolName}`
    );
  }

  try {
    const result = await toolHandler(toolName, toolArgs);
    return jsonRpcResponse(msg.id!, {
      content: [{ type: "text", text: result }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonRpcResponse(msg.id!, {
      content: [{ type: "text", text: message }],
      isError: true,
    });
  }
}

// --- Response helpers ---

function jsonRpcResponse(
  id: string | number | null,
  result: unknown
): Response {
  const body: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function jsonRpcErrorResponse(
  id: string | number | null,
  code: number,
  message: string
): Response {
  const body: JsonRpcResponse = {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
