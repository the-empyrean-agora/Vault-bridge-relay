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
    name: "vault_begin_session",
    description:
      "Call this FIRST, before any other tool, at the start of every vault session. Returns the vault's orientation file — the canonical rules, conventions, folder layout, and entry ritual the user has defined for working in this vault. Reading it before you act ensures you follow their established structure instead of guessing. Cheap to call; takes no arguments.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "vault_list_directory",
    description:
      "List the immediate contents of a directory in the Obsidian vault. Returns directories first (with trailing /) then files, sorted. Hidden entries are excluded. Use this to explore unfamiliar parts of the vault. For listing files modified recently across the whole vault, use vault_get_recent_files instead.",
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
    name: "vault_read_file",
    description:
      "Read the full content of a file in the vault. Use this when you know (or can guess) the exact path. Fast and exact — prefer this over vault_search_files when you have a specific file in mind.",
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
    name: "vault_write_file",
    description:
      "Create a new file or overwrite an existing one. Creates parent directories as needed. The vault index is updated immediately so the next search/vault_get_backlinks/vault_list_tags call will see the new file.",
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
    name: "vault_edit_range",
    description:
      "Make a surgical edit to an existing file by replacing an exact text span — like Claude Code's Edit tool. Prefer this over vault_write_file for any change to an existing note: it's safer (a typo can't silently replace the whole file), cheaper (no need to resend the full content), and preserves everything outside the edited span byte-for-byte (wikilinks, frontmatter, formatting all survive). Provide enough surrounding context in old_string to match exactly once. Errors without writing if old_string is not found, or if it matches more than once and replace_all is false. To DELETE text, put it in old_string and leave new_string empty (\"\"). Returns a change summary (lines/chars added or removed) so you can confirm the edit did what you intended. If the file has YAML frontmatter with an 'updated:' field, it is auto-bumped to today's date.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the existing file within the vault (e.g. 'notes/my-note.md')",
        },
        old_string: {
          type: "string",
          description:
            "The exact text to replace. Must match the file content verbatim, including whitespace. Include surrounding context so it matches exactly once (unless replace_all is true).",
        },
        new_string: {
          type: "string",
          description: "The text to replace old_string with.",
        },
        replace_all: {
          type: "boolean",
          description:
            "Replace every occurrence of old_string instead of requiring a unique match. Default false.",
          default: false,
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "vault_delete_file",
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
    name: "vault_search_files",
    description:
      "Search the vault. Index-backed and fast. Supports several query forms:\n  • plain text → matches filename, tags, and content tokens (filename matches scored highest)\n  • #tagname → exact tag match (e.g. '#project')\n  • path:somefolder → files whose path starts with the given prefix\n  • filename:foo → match in filename only\n\nReturns up to 50 results, ranked by relevance, each with a short preview snippet. For very specific known paths, prefer vault_read_file.",
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
    name: "vault_get_backlinks",
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
    name: "vault_list_tags",
    description:
      "List every unique tag in the vault with usage counts, sorted by most-used first. Includes both inline tags (#tag) and frontmatter tags. Useful when the user asks 'what tags do I have' or 'what topics do I write about'.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "vault_get_recent_files",
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
  {
    name: "vault_get_outgoing_links",
    description:
      "List the notes a file links OUT to via wikilinks ([[...]]) or markdown links ([text](path.md)). The complement of vault_get_backlinks — together they let you walk the vault's link graph in both directions without reading file bodies.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Relative path of the note to list outgoing links from (e.g. 'notes/big-idea.md')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "vault_get_files_by_frontmatter",
    description:
      "Find notes by a single YAML frontmatter condition — structured triage the keyword search can't do. Query forms:\n  • field: value → field equals value (for list fields like tags, membership; case-insensitive)\n  • field: * → the field is present with any value\n  • field > value / field < value / field >= / field <= → comparison (ISO dates and numbers compare naturally)\nExamples: 'status: seedling', 'tags: agora', 'updated > 2026-01-01'. One condition per call. Returns matching paths with the matched value.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "A single frontmatter condition, e.g. 'status: seedling' or 'updated > 2026-01-01'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "vault_append_to_section",
    description:
      "Add content under a specific markdown heading in an existing note, without resending the whole file. Finds the heading, then inserts at the end of its section (just before the next heading of equal or higher level) or at the start (right after the heading). Use this for the common 'add a bullet under Heading X' edit. Errors without writing if the heading is not found or matches more than once. Like vault_edit_range, if the file has YAML frontmatter with an 'updated:' field it is auto-bumped.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the existing note (e.g. 'notes/my-note.md')",
        },
        heading: {
          type: "string",
          description:
            "The heading text to add under, without the leading #s (e.g. 'Name Ideas'). Must match exactly one heading.",
        },
        content: {
          type: "string",
          description: "The text to insert under the heading.",
        },
        position: {
          type: "string",
          description:
            "'end' (default) inserts at the end of the section, before the next heading of equal/higher level; 'start' inserts immediately after the heading.",
          default: "end",
        },
      },
      required: ["path", "heading", "content"],
    },
  },
  {
    name: "vault_read_section",
    description:
      "Read a single section of a note — the heading line through to just before the next heading of equal or higher level. A token-efficient way to pull one part of a long note without reading the whole file. Errors if the heading is not found or matches more than once.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Relative path to the note (e.g. 'notes/my-note.md')",
        },
        heading: {
          type: "string",
          description:
            "The heading text to read, without leading #s (e.g. 'Tasks'). Must match exactly one heading.",
        },
      },
      required: ["path", "heading"],
    },
  },
  {
    name: "vault_read_frontmatter",
    description:
      "Read just the YAML frontmatter (tags, status, dates, etc.) of a note, without its body — a cheap way to inspect or triage a note's metadata. Returns the frontmatter block, or a short note if the file has none.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Relative path to the note (e.g. 'notes/my-note.md')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "vault_resolve_wikilink",
    description:
      "Resolve an Obsidian wikilink to the actual file path(s) it points to. Accepts a bare name ('Some Note'), a folder path ('folder/Some Note'), or the full '[[...]]' form (alias and #section suffixes are ignored). Returns the matching path, or all candidates if the name is ambiguous. Removes guess-the-path errors before a vault_read_file / vault_edit_range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        link: {
          type: "string",
          description:
            "The wikilink target to resolve (e.g. 'Big Idea', 'projects/Big Idea', or '[[Big Idea|alias]]')",
        },
      },
      required: ["link"],
    },
  },
  {
    name: "vault_create_file",
    description:
      "Create a NEW file, failing if one already exists at the path — the safe, create-only counterpart to vault_write_file (which overwrites). Use this when the intent is a new note and clobbering an existing one would be a mistake. Creates parent directories as needed and updates the vault index.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Relative path for the new file (e.g. 'notes/new-note.md')",
        },
        content: {
          type: "string",
          description: "The full text content to write.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "vault_move_file",
    description:
      "Move or rename a file within the vault as a single metadata operation — the content is untouched and the search index follows automatically. Always prefer this over read + write + delete for a move: it is atomic-per-file and cannot mangle content. Fails if the source does not exist or the destination already exists (a move never overwrites). Note: wikilinks in OTHER notes are not rewritten — Obsidian resolves [[Name]] links by filename regardless of folder, so folder moves are safe, but renaming the filename itself can break links; check vault_get_backlinks first when renaming a widely-linked note.",
    inputSchema: {
      type: "object" as const,
      properties: {
        from: {
          type: "string",
          description:
            "Current relative path of the file (e.g. 'notes/old-name.md')",
        },
        to: {
          type: "string",
          description:
            "New relative path, including filename and extension (e.g. 'archive/old-name.md')",
        },
      },
      required: ["from", "to"],
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
      // `instructions` is the MCP-spec mechanism for Path A auto-orientation:
      // clients that support it inject this into model context at connect
      // (Claude Code surfaces it in its "MCP Server Instructions" section);
      // clients that don't simply ignore it. Keep it short — it runs every
      // connect. It points at vault_begin_session (Path B) rather than duplicating it.
      return jsonRpcResponse(msg.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "Vault Bridge", version: "0.1.0" },
        instructions:
          "This server bridges a personal Obsidian vault. At the start of a vault " +
          "session, call `vault_begin_session` once before other tools — it returns the " +
          "vault's orientation file (rules, conventions, folder layout, entry ritual) " +
          "so you follow the user's established structure instead of guessing. For a " +
          "change to an existing note prefer `vault_edit_range` (exact-span patch) or " +
          "`vault_append_to_section` (add under a heading) over `vault_write_file`, which " +
          "overwrites the entire file.",
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

  // Public tool names are `vault_`-prefixed so they don't collide with a
  // filesystem MCP server (which also exposes read_file/write_file/etc.) mounted
  // over the same vault. The handlers below (R2 ops, relay client) use the bare
  // internal names, so we resolve to the public name then strip the prefix here,
  // in the one place both modes funnel through. Bare names are still accepted for
  // leniency, so an older cached caller doesn't break.
  const validTools = new Set(TOOL_DEFINITIONS.map((t) => t.name));
  const publicName = validTools.has(toolName)
    ? toolName
    : validTools.has(`vault_${toolName}`)
      ? `vault_${toolName}`
      : null;
  if (!publicName) {
    return jsonRpcErrorResponse(msg.id!, -32602, `Unknown tool: ${toolName}`);
  }
  const internalName = publicName.slice("vault_".length);

  try {
    const result = await toolHandler(internalName, toolArgs);
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
