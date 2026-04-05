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
      "List the contents of a directory in the Obsidian vault. Returns sorted entries: directories first (with trailing /), then files. Hidden entries excluded.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the directory (empty string for vault root)",
          default: "",
        },
      },
    },
  },
  {
    name: "read_file",
    description:
      "Read a note from the Obsidian vault by relative path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the file within the vault (e.g. 'notes/my-note.md')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a note in the Obsidian vault. Creates parent directories as needed.",
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
    name: "search_files",
    description:
      "Search for files in the Obsidian vault by filename or content. Returns up to 50 results. Searches filenames first, then file contents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search term (case-insensitive)",
        },
      },
      required: ["query"],
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
