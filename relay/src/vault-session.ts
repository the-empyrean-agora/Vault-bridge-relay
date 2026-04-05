/**
 * VaultSession Durable Object — one per user.
 *
 * Holds the client WebSocket (hibernatable) and brokers MCP tool calls
 * from the Worker to the client and back.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./config.js";
import type {
  ClientMessage,
  ClientAttachment,
  ToolCallMessage,
} from "./models.js";
import { handleMcpRequest } from "./mcp.js";

const TOOL_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class VaultSession extends DurableObject<Env> {
  private pending: Map<string, PendingRequest> = new Map();

  /**
   * Called when the Worker forwards a WebSocket upgrade request.
   * Accepts the WebSocket in hibernatable mode.
   */
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      // Accept in hibernatable mode so the DO can sleep while the WS stays open
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Non-WebSocket requests are MCP tool calls routed by the Worker
    return handleMcpRequest(request, (tool, params) =>
      this.handleToolCall(tool, params)
    );
  }

  /**
   * Hibernatable WebSocket handler — called when a message arrives from the client.
   * The DO may have been evicted and recreated since the last message.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (msg.type === "connect") {
      // Store client metadata on the WebSocket for later retrieval
      const attachment: ClientAttachment = {
        token: msg.token,
        vault_path_hint: msg.vault_path_hint,
        client_version: msg.client_version,
        platform: msg.platform,
        connectedAt: new Date().toISOString(),
      };
      ws.serializeAttachment(attachment);
      ws.send(JSON.stringify({ type: "connected" }));
      return;
    }

    if (msg.type === "tool_result") {
      const pending = this.pending.get(msg.request_id);
      if (!pending) return; // stale or duplicate result, ignore
      clearTimeout(pending.timeout);
      this.pending.delete(msg.request_id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result ?? "");
      }
      return;
    }
  }

  /**
   * Hibernatable WebSocket handler — called when the client disconnects.
   */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    // Clean up any pending requests — they'll never get a response
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Client disconnected"));
    }
    this.pending.clear();
    ws.close();
  }

  /**
   * Hibernatable WebSocket handler — called on WebSocket error.
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Client WebSocket error"));
    }
    this.pending.clear();
    ws.close();
  }

  /**
   * Broker a tool call to the connected client.
   * Called by the MCP handler (Step 5) when Claude invokes a tool.
   *
   * Returns the result string from the client, or throws on timeout/disconnect.
   */
  async handleToolCall(
    tool: string,
    params: Record<string, unknown>
  ): Promise<string> {
    const clients = this.ctx.getWebSockets();
    if (clients.length === 0) {
      throw new Error(
        "Client not connected. Ensure Vault Bridge is running on your machine."
      );
    }

    const ws = clients[0]; // one client per user DO
    const requestId = crypto.randomUUID();

    const promise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Client timed out after 30s"));
      }, TOOL_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timeout });
    });

    const callMessage: ToolCallMessage = {
      type: "tool_call",
      request_id: requestId,
      tool,
      params,
    };
    ws.send(JSON.stringify(callMessage));

    return promise;
  }
}
