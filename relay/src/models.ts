/** WebSocket message types between relay and client. */

/** Client → DO on WebSocket open */
export interface ConnectMessage {
  type: "connect";
  token: string;
  vault_path_hint: string;
  client_version: string;
  platform: string;
}

/** DO → Client: execute a tool */
export interface ToolCallMessage {
  type: "tool_call";
  request_id: string;
  tool: string;
  params: Record<string, unknown>;
}

/** Client → DO: tool result */
export interface ToolResultMessage {
  type: "tool_result";
  request_id: string;
  result: string | null;
  error: string | null;
}

/** Union of all inbound messages the DO can receive from a client */
export type ClientMessage = ConnectMessage | ToolResultMessage;

/** Metadata stored via serializeAttachment on the WebSocket */
export interface ClientAttachment {
  token: string;
  vault_path_hint: string;
  client_version: string;
  platform: string;
  connectedAt: string;
}
