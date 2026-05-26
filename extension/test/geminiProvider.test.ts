import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiProvider } from '../src/llmProviders';

// Minimal SSE response — Gemini emits one chunk + we close the stream.
function makeStreamingResponse(chunks: string[], extras?: object) {
  const body = {
    getReader() {
      let i = 0;
      return {
        async read() {
          if (i < chunks.length) {
            const text = `data: ${JSON.stringify({
              candidates: [{ content: { parts: [{ text: chunks[i++] }] } }],
              ...(i === chunks.length ? extras : {}),
            })}\n\n`;
            return { done: false, value: new TextEncoder().encode(text) };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { ok: true, body, status: 200, text: async () => '' };
}

describe('GeminiProvider attachments', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(makeStreamingResponse(['hi'])));
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    delete (globalThis as any).fetch;
  });

  it('omits inline_data parts when no attachments are passed', async () => {
    const p = new GeminiProvider('gemini-2.5-flash', 'KEY');
    await p.sendMessage(
      { staticPrefix: 'sys', dynamic: '' },
      [],
      'hello',
      () => {},
      () => {},
      () => {},
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userTurn = body.contents[body.contents.length - 1];
    expect(userTurn.role).toBe('user');
    expect(userTurn.parts).toEqual([{ text: 'hello' }]);
  });

  it('inlines attached images as inline_data parts on the user message', async () => {
    // Multimodal magic: when the student attaches a plot, we ship the bytes
    // as a sibling part to the user text. Gemini accepts mixed parts.
    const p = new GeminiProvider('gemini-2.5-flash', 'KEY');
    await p.sendMessage(
      { staticPrefix: 'sys', dynamic: '' },
      [],
      'what does this plot show?',
      () => {},
      () => {},
      () => {},
      undefined,
      [{ mimeType: 'image/png', dataBase64: 'BASE64_BYTES' }],
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userTurn = body.contents[body.contents.length - 1];
    expect(userTurn.parts).toHaveLength(2);
    expect(userTurn.parts[0]).toEqual({ text: 'what does this plot show?' });
    expect(userTurn.parts[1]).toEqual({
      inline_data: { mime_type: 'image/png', data: 'BASE64_BYTES' },
    });
  });

  it('inlines multiple attachments in order', async () => {
    const p = new GeminiProvider('gemini-2.5-flash', 'KEY');
    await p.sendMessage(
      { staticPrefix: 'sys', dynamic: '' },
      [],
      'compare these',
      () => {},
      () => {},
      () => {},
      undefined,
      [
        { mimeType: 'image/png', dataBase64: 'AAA' },
        { mimeType: 'image/png', dataBase64: 'BBB' },
      ],
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userTurn = body.contents[body.contents.length - 1];
    expect(userTurn.parts).toHaveLength(3); // text + 2 images
    expect(userTurn.parts[1].inline_data.data).toBe('AAA');
    expect(userTurn.parts[2].inline_data.data).toBe('BBB');
  });
});
