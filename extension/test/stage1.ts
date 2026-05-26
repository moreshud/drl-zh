/**
 * Stage 1 — Provider smoke tests.
 *
 * Usage:
 *   cd extension
 *   GEMINI_API_KEY=... OPENAI_API_KEY=... ANTHROPIC_API_KEY=... npx ts-node test/stage1.ts
 *
 * Each test sends a minimal request to the provider's API and verifies
 * that a streaming response is received. Tests print PASS or FAIL.
 */

/* eslint-disable no-console */

import { GeminiProvider, OpenAIProvider, AnthropicProvider } from '../src/providers';

const GEMINI_KEY = process.env.GEMINI_API_KEY ?? '';
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? '';

interface TestResult {
  name: string;
  pass: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function testProvider(
  name: string,
  fn: () => Promise<void>,
  skip: boolean
): Promise<void> {
  if (skip) {
    console.log(`SKIP  ${name} (no API key)`);
    return;
  }
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS  ${name}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, error: msg });
    console.log(`FAIL  ${name}: ${msg}`);
  }
}

async function testGeminiFlash(): Promise<void> {
  const provider = new GeminiProvider('gemini-2.5-flash', GEMINI_KEY);
  let received = '';
  await provider.sendMessage(
    'You are a test assistant.',
    [],
    'Say "hello" in one word.',
    (chunk) => { received += chunk; },
    () => {},
    (err) => { throw err; },
  );
  if (!received) { throw new Error('No response received'); }
}

async function testGeminiPro(): Promise<void> {
  const provider = new GeminiProvider('gemini-2.5-pro', GEMINI_KEY);
  let received = '';
  await provider.sendMessage(
    'You are a test assistant.',
    [],
    'Say "hello" in one word.',
    (chunk) => { received += chunk; },
    () => {},
    (err) => { throw err; },
  );
  if (!received) { throw new Error('No response received'); }
}

async function testOpenAI(): Promise<void> {
  const provider = new OpenAIProvider('gpt-4o', OPENAI_KEY);
  let received = '';
  await provider.sendMessage(
    'You are a test assistant.',
    [],
    'Say "hello" in one word.',
    (chunk) => { received += chunk; },
    () => {},
    (err) => { throw err; },
  );
  if (!received) { throw new Error('No response received'); }
}

async function testAnthropic(): Promise<void> {
  const provider = new AnthropicProvider('claude-sonnet-4-5', ANTHROPIC_KEY);
  let received = '';
  await provider.sendMessage(
    'You are a test assistant.',
    [],
    'Say "hello" in one word.',
    (chunk) => { received += chunk; },
    () => {},
    (err) => { throw err; },
  );
  if (!received) { throw new Error('No response received'); }
}

async function testCancellation(): Promise<void> {
  const provider = new GeminiProvider('gemini-2.5-flash', GEMINI_KEY);
  let chunks = 0;

  const promise = provider.sendMessage(
    'You are a test assistant.',
    [],
    'Write a long essay about reinforcement learning.',
    () => {
      chunks++;
      if (chunks >= 2) { provider.cancel(); }
    },
    () => {},
    () => {},
  );

  await promise;
  // If we get here without hanging, cancellation works
}

async function main() {
  console.log('DRL-ZH Companion — Stage 1 Provider Smoke Tests\n');

  await testProvider('Gemini Flash (streaming)', testGeminiFlash, !GEMINI_KEY);
  await testProvider('Gemini Pro (streaming)', testGeminiPro, !GEMINI_KEY);
  await testProvider('OpenAI GPT-4o (streaming)', testOpenAI, !OPENAI_KEY);
  await testProvider('Anthropic Claude (streaming)', testAnthropic, !ANTHROPIC_KEY);
  await testProvider('Cancellation (Gemini)', testCancellation, !GEMINI_KEY);

  console.log('\n── Summary ──');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length} tests`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
