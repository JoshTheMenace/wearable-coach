import type WebSocket from 'ws';

export type ProviderConfig = {
  provider: 'mock' | 'gemini' | 'openai';
  model: string;
  voice?: string;
  manualActivity?: boolean;
};
export type ProviderCallbacks = {
  event(type: string, payload: Record<string, unknown>): void;
  audio(pcm: Buffer): void;
  tool(call: { id: string; name: string; args: Record<string, unknown> }): void;
  delegation?(id: string, offsetMs?: number): void;
  interrupted(): void;
  error(error: Error): void;
  closed(reason: string): void;
};
export type ProviderOptions = {
  resumeHandle?: string;
  history?: string;
  /** Dependency injection for local wire tests, never accepted from clients. */
  socketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  connectTimeoutMs?: number;
  closeTimeoutMs?: number;
};
export interface ProviderAdapter {
  connect(): Promise<void>;
  sendAudio(pcm: Buffer): void;
  sendText(text: string): void;
  inspect(image: Buffer, mime: string, question: string): void;
  toolResult(id: string, result: unknown): void;
  activity(active: boolean): void;
  appendContext(text: string, delegationId?: string | null, spoken?: boolean): void;
  close(): Promise<void>;
  resumeHandle?: string;
  inputRate: number;
  outputRate: number;
}
