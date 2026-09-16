import { GeminiProvider } from './gemini.ts';
import { OpenAIProvider } from './openai.ts';
import { MockProvider } from './mock.ts';
import type { ProviderAdapter, ProviderCallbacks, ProviderConfig, ProviderOptions } from './types.ts';
export type { ProviderAdapter, ProviderCallbacks, ProviderConfig, ProviderOptions } from './types.ts';
export { observeFrame, inferTask } from './inference.ts';

export function availability() {
  const gemini = !!(process.env.GEMINI_KEY || process.env.GEMINI_API_KEY);
  const openai = !!process.env.OPENAI_API_KEY;
  return [
    { id: 'mock', model: 'mock-coach', available: true, reason: 'Local simulation; audio is a test tone', inputRate: 16000, outputRate: 24000 },
    { id: 'gemini', model: 'gemini-3.8-live', available: gemini, reason: gemini ? 'Configured; model access checked on connect' : 'GEMINI_KEY is not configured', inputRate: 16000, outputRate: 24000 },
    { id: 'openai', model: 'gpt-live-1', available: openai && gemini, reason: !openai ? 'OPENAI_API_KEY is not configured' : !gemini ? 'Gemini observer/task handler key is not configured' : 'Configured; model access checked on connect', inputRate: 24000, outputRate: 24000 },
  ];
}
export function createProvider(config: ProviderConfig, callbacks: ProviderCallbacks, options: ProviderOptions = {}): ProviderAdapter {
  if (config.provider === 'mock') return new MockProvider(config, callbacks);
  if (config.provider === 'gemini' && ['gemini-3.8-live', 'gemini-3.8-live-extended-thinking'].includes(config.model))
    return new GeminiProvider(config, callbacks, options);
  if (config.provider === 'openai' && config.model === 'gpt-live-1') return new OpenAIProvider(config, callbacks, options);
  throw new Error('Unsupported provider/model combination');
}
