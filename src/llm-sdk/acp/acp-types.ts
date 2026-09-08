/**
 * Agent Client Protocol (ACP) type definitions.
 *
 * Implements standard JSON-RPC 2.0 messages and ACP lifecycle:
 * - Handshake: initialize
 * - Session Management: session/new, session/cancel
 * - Prompt Interaction: session/prompt
 * - Streaming Notifications: session/update (agent_message_chunk, agent_thought_chunk, usage_update)
 */

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: T;
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: T;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result?: T;
  error?: JsonRpcError;
}

export interface AcpClientInfo {
  name: string;
  version: string;
}

export interface AcpAgentInfo {
  name: string;
  version?: string;
}

export interface AcpInitializeParams {
  protocolVersion: number | string;
  clientInfo: AcpClientInfo;
  capabilities?: Record<string, unknown>;
}

export interface AcpInitializeResult {
  protocolVersion: number | string;
  agentInfo?: AcpAgentInfo;
  capabilities?: Record<string, unknown>;
}

export interface AcpNewSessionParams {
  sessionId?: string;
  cwd?: string;
  mcpServers?: unknown[];
}

export interface AcpNewSessionResult {
  sessionId: string;
  [key: string]: unknown;
}

export interface AcpTextContentPart {
  type: 'text';
  text: string;
}

export interface AcpImageContentPart {
  type: 'image';
  data: string;
  mimeType: string;
}

export type AcpContentPart = AcpTextContentPart | AcpImageContentPart | { type: string; [key: string]: unknown };

export interface AcpPromptParams {
  sessionId: string;
  prompt: string | AcpContentPart[];
  system?: string;
  [key: string]: unknown;
}

export interface AcpUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AcpPromptResult {
  stopReason?: string;
  content?: AcpContentPart[];
  usage?: AcpUsage;
  [key: string]: unknown;
}

export type AcpSessionUpdate =
  | { type: 'agent_message_chunk'; text: string; [key: string]: unknown }
  | { type: 'agent_thought_chunk'; text: string; [key: string]: unknown }
  | { type: 'usage_update'; usage: AcpUsage; [key: string]: unknown }
  | { type: 'tool_call'; toolCallId?: string; name?: string; args?: unknown; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: AcpSessionUpdate;
}
