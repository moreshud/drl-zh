// All LLM-facing code in one place: provider interface, the three stream
// implementations (Gemini, OpenAI, Anthropic — Groq reuses OpenAIProvider
// with a different baseUrl), factory helpers that pick a provider from
// UserConfig, and key-validation helpers.

import type { UserConfig } from './userConfig';
import {
  DEFAULT_GROQ_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_ANTHROPIC_MODEL,
} from './constants';

// ── Shared types ─────────────────────────────────────────────────────────

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * System prompt is split so we can keep the static prefix (persona + chapter +
 * notebook summary) byte-identical across turns — this is what unlocks
 * Anthropic's explicit prompt caching and Gemini's implicit caching.
 */
export interface SystemPrompt {
  staticPrefix: string;
  dynamic: string;
}

/**
 * Normalized token usage reported by a provider after a request. Each
 * provider exposes usage differently (Gemini has usageMetadata at the end
 * of the stream; OpenAI/Groq require stream_options.include_usage; Anthropic
 * splits it across message_start and message_delta events) — we normalize
 * them all to this shape. `inputTokens` is what we sent (prompt + history +
 * user message), `outputTokens` is the assistant's reply.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * An image the student attached to a turn — typically a plot output from a
 * notebook cell. Providers that support multimodal input (Gemini today)
 * inline these as image parts; providers without support ignore them.
 */
export interface ImageAttachment {
  mimeType: string;     // 'image/png'
  dataBase64: string;
}

export interface LLMProvider {
  name: string;
  sendMessage(
    system: SystemPrompt,
    history: Message[],
    userMessage: string,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (error: Error) => void,
    onUsage?: (usage: TokenUsage) => void,
    attachments?: ImageAttachment[],
  ): Promise<void>;
  cancel(): void;
}

// ── Gemini ────────────────────────────────────────────────────────────────

export class GeminiProvider implements LLMProvider {
  name: string;
  private model: string;
  private apiKey: string;
  private abortController: AbortController | null = null;

  constructor(model: string, apiKey: string) {
    this.model = model;
    this.apiKey = apiKey;
    this.name = 'Gemini';
  }

  async sendMessage(
    system: SystemPrompt,
    history: Message[],
    userMessage: string,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (error: Error) => void,
    onUsage?: (usage: TokenUsage) => void,
    attachments?: ImageAttachment[],
  ): Promise<void> {
    this.abortController = new AbortController();
    const contents: any[] = history.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    // Build user-turn parts: text first, then any inline image attachments.
    // Gemini accepts mixed text + image parts in a single user message.
    const userParts: any[] = [{ text: userMessage }];
    if (attachments) {
      for (const a of attachments) {
        userParts.push({ inline_data: { mime_type: a.mimeType, data: a.dataBase64 } });
      }
    }
    contents.push({ role: 'user', parts: userParts });

    // Gemini has no explicit cache markers on this endpoint; identical leading
    // bytes across requests enable implicit caching. Keep the prefix first.
    const systemText = system.dynamic
      ? `${system.staticPrefix}\n\n${system.dynamic}`
      : system.staticPrefix;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemText }] },
            contents,
            generationConfig: { temperature: 0.7 },
          }),
          signal: this.abortController.signal,
        },
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API error ${response.status}: ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) { throw new Error('No response body'); }
      const decoder = new TextDecoder();
      let buffer = '';
      let lastUsage: TokenUsage | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) { continue; }
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') { continue; }
          try {
            const parsed = JSON.parse(jsonStr);
            const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) { onChunk(text); }
            // Gemini includes cumulative usage on (typically the final)
            // stream chunk as usageMetadata — capture the latest.
            const u = parsed?.usageMetadata;
            if (u) {
              lastUsage = {
                inputTokens: u.promptTokenCount ?? 0,
                outputTokens: u.candidatesTokenCount ?? 0,
                totalTokens: u.totalTokenCount ?? ((u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0)),
              };
            }
          } catch { /* skip malformed JSON chunks */ }
        }
      }
      if (lastUsage && onUsage) { onUsage(lastUsage); }
      onDone();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') { return; }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}

// ── OpenAI (also serves Groq via baseUrl override) ───────────────────────

export class OpenAIProvider implements LLMProvider {
  name: string;
  private model: string;
  private apiKey: string;
  private baseUrl: string;
  private abortController: AbortController | null = null;

  constructor(model: string, apiKey: string, options?: { baseUrl?: string; name?: string }) {
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = options?.baseUrl ?? 'https://api.openai.com/v1';
    this.name = options?.name ?? 'OpenAI';
  }

  async sendMessage(
    system: SystemPrompt,
    history: Message[],
    userMessage: string,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (error: Error) => void,
    onUsage?: (usage: TokenUsage) => void,
  ): Promise<void> {
    this.abortController = new AbortController();
    // OpenAI/Groq don't expose cache markers; concatenate for an identical
    // leading prefix across turns.
    const systemContent = system.dynamic
      ? `${system.staticPrefix}\n\n${system.dynamic}`
      : system.staticPrefix;
    const messages = [
      { role: 'system' as const, content: systemContent },
      ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: userMessage },
    ];

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          temperature: 0.7,
          // Ask OpenAI/Groq to include a final usage chunk in the stream.
          stream_options: { include_usage: true },
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) { throw new Error('No response body'); }
      const decoder = new TextDecoder();
      let buffer = '';
      let lastUsage: TokenUsage | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) { continue; }
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') { continue; }
          try {
            const parsed = JSON.parse(jsonStr);
            const text = parsed?.choices?.[0]?.delta?.content;
            if (text) { onChunk(text); }
            // Final chunk (after the last content delta) has a usage block
            // with empty choices when stream_options.include_usage is set.
            const u = parsed?.usage;
            if (u) {
              lastUsage = {
                inputTokens: u.prompt_tokens ?? 0,
                outputTokens: u.completion_tokens ?? 0,
                totalTokens: u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)),
              };
            }
          } catch { /* skip malformed chunks */ }
        }
      }
      if (lastUsage && onUsage) { onUsage(lastUsage); }
      onDone();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') { return; }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}

// ── Anthropic ─────────────────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  name = 'Anthropic';
  private model: string;
  private apiKey: string;
  private abortController: AbortController | null = null;

  constructor(model: string, apiKey: string) {
    this.model = model;
    this.apiKey = apiKey;
  }

  async sendMessage(
    system: SystemPrompt,
    history: Message[],
    userMessage: string,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (error: Error) => void,
    onUsage?: (usage: TokenUsage) => void,
  ): Promise<void> {
    this.abortController = new AbortController();
    const messages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: userMessage },
    ];

    // Anthropic supports explicit prompt caching: marking the static prefix
    // with cache_control lets subsequent turns reuse it for ~10 % of the cost.
    const systemBlocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [
      { type: 'text', text: system.staticPrefix, cache_control: { type: 'ephemeral' } },
    ];
    if (system.dynamic) {
      systemBlocks.push({ type: 'text', text: system.dynamic });
    }

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 2048,
          system: systemBlocks,
          messages,
          stream: true,
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) { throw new Error('No response body'); }
      const decoder = new TextDecoder();
      let buffer = '';
      // Anthropic splits usage: input_tokens land on message_start (plus
      // cache_read/creation for cached turns), output_tokens arrive
      // incrementally on message_delta events.
      let inputTokens = 0;
      let outputTokens = 0;
      let sawUsage = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) { continue; }
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) { continue; }
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.type === 'content_block_delta') {
              const text = parsed.delta?.text;
              if (text) { onChunk(text); }
            } else if (parsed.type === 'message_start') {
              const u = parsed.message?.usage;
              if (u) {
                // Count cached input tokens toward the input total — they're
                // still part of the context we sent, just billed cheaper.
                inputTokens = (u.input_tokens ?? 0)
                  + (u.cache_read_input_tokens ?? 0)
                  + (u.cache_creation_input_tokens ?? 0);
                sawUsage = true;
              }
            } else if (parsed.type === 'message_delta') {
              const u = parsed.usage;
              if (u?.output_tokens !== undefined) {
                outputTokens = u.output_tokens;
                sawUsage = true;
              }
            }
          } catch { /* skip malformed chunks */ }
        }
      }
      if (sawUsage && onUsage) {
        onUsage({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
      }
      onDone();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') { return; }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}

// ── Factories ─────────────────────────────────────────────────────────────

function modelOrDefault(model: string | undefined, fallback: string): string {
  return model?.trim() || fallback;
}

export function getLLMProvider(config: UserConfig): LLMProvider {
  switch (config.llmProvider) {
    case 'gemini':
      return new GeminiProvider(
        modelOrDefault(config.geminiModel, DEFAULT_GEMINI_MODEL),
        config.geminiApiKey,
      );
    case 'openai':
      return new OpenAIProvider(
        modelOrDefault(config.openaiModel, DEFAULT_OPENAI_MODEL),
        config.openaiApiKey,
      );
    case 'anthropic':
      return new AnthropicProvider(
        modelOrDefault(config.anthropicModel, DEFAULT_ANTHROPIC_MODEL),
        config.anthropicApiKey,
      );
    case 'groq':
      return new OpenAIProvider(
        modelOrDefault(config.groqModel, DEFAULT_GROQ_MODEL),
        config.groqApiKey,
        { baseUrl: 'https://api.groq.com/openai/v1', name: 'Groq' },
      );
    default:
      return new GeminiProvider(DEFAULT_GEMINI_MODEL, config.geminiApiKey);
  }
}

/**
 * Cheap/fast provider for internal tasks (notebook summarization, drift
 * detection). Returns null if the user has no key for their chosen provider.
 */
export function getCheapProvider(config: UserConfig): LLMProvider | null {
  switch (config.llmProvider) {
    case 'gemini':
      return config.geminiApiKey ? new GeminiProvider('gemini-2.5-flash-lite', config.geminiApiKey) : null;
    case 'openai':
      return config.openaiApiKey ? new OpenAIProvider('gpt-4o-mini', config.openaiApiKey) : null;
    case 'anthropic':
      return config.anthropicApiKey ? new AnthropicProvider('claude-haiku-4-5-20251001', config.anthropicApiKey) : null;
    case 'groq':
      return config.groqApiKey ? new OpenAIProvider('llama-3.1-8b-instant', config.groqApiKey, { baseUrl: 'https://api.groq.com/openai/v1', name: 'Groq' }) : null;
    default:
      return config.geminiApiKey ? new GeminiProvider('gemini-2.5-flash-lite', config.geminiApiKey) : null;
  }
}

// ── Key validation ────────────────────────────────────────────────────────

export async function validateGeminiKey(apiKey: string): Promise<boolean> {
  try {
    // Models list endpoint — lightweight GET, validates key only
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=1`,
    );
    return response.ok;
  } catch { return false; }
}

export async function validateGroqKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    return response.ok;
  } catch { return false; }
}

export async function validateOpenAIKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    return response.ok;
  } catch { return false; }
}

export async function validateAnthropicKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Say hello' }],
      }),
    });
    return response.ok;
  } catch { return false; }
}
