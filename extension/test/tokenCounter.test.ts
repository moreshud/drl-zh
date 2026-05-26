import { describe, it, expect } from 'vitest';
import { formatTokenCounter } from '../src/webview/tokenCounter';

describe('formatTokenCounter', () => {
  it('formats small numbers as raw integers', () => {
    expect(formatTokenCounter(0, 0).text).toBe('ctx 0 · total 0');
    expect(formatTokenCounter(50, 120).text).toBe('ctx 50 · total 120');
  });

  it('formats <10k with one decimal place', () => {
    expect(formatTokenCounter(4200, 12_800).text).toBe('ctx 4.2k · total 13k');
    expect(formatTokenCounter(1050, 1000).text).toBe('ctx 1.1k · total 1.0k');
  });

  it('formats >=10k as rounded k', () => {
    expect(formatTokenCounter(42_500, 100_000).text).toBe('ctx 43k · total 100k');
  });

  it('returns "normal" level when usage is modest', () => {
    expect(formatTokenCounter(500, 500).level).toBe('normal');
    expect(formatTokenCounter(19_999, 99_999).level).toBe('normal');
  });

  it('escalates to "warn" at the context warn threshold', () => {
    expect(formatTokenCounter(20_000, 0).level).toBe('warn');
  });

  it('escalates to "warn" on cumulative session size', () => {
    // Individual ctx is modest but the session has racked up — still warn.
    expect(formatTokenCounter(500, 100_000).level).toBe('warn');
  });

  it('escalates to "alert" once context is near request limits', () => {
    expect(formatTokenCounter(80_000, 0).level).toBe('alert');
    expect(formatTokenCounter(120_000, 0).level).toBe('alert');
  });

  it('escalates to "alert" on heavy cumulative session usage', () => {
    // Even with a fresh context, a 500k-token session means rate limits
    // are imminent on most free tiers.
    expect(formatTokenCounter(500, 500_000).level).toBe('alert');
  });

  it('alert dominates warn when both thresholds are crossed', () => {
    expect(formatTokenCounter(80_000, 100_000).level).toBe('alert');
  });
});
