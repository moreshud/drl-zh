/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-expect-error — webview module exports CommonJS for vitest
import { createVoiceCapture } from '../src/webview/voiceCapture.js';

describe('createVoiceCapture', () => {
  let statusCalls: Array<[string, string]>;
  let deps: any;

  beforeEach(() => {
    statusCalls = [];
    deps = {
      vscodeApi: { postMessage: vi.fn() },
      setStatus: (state: string, text: string) => { statusCalls.push([state, text]); },
      onActivity: vi.fn(),
      isVoiceMode: () => true,
      isTranscribing: () => false,
      setTranscribing: vi.fn(),
    };
    // Clean any prior stubs
    delete (globalThis as any).navigator;
    delete (globalThis as any).AudioContext;
    delete (globalThis as any).MediaRecorder;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('start() error handling', () => {
    it('when getUserMedia is unavailable, surfaces a clear status and throws', async () => {
      (globalThis as any).navigator = { mediaDevices: undefined };
      const vc = createVoiceCapture(deps);
      await expect(vc.start()).rejects.toThrow('getUserMedia unavailable');
      expect(statusCalls.at(-1)).toEqual(['error', 'No mic access available in this browser.']);
    });

    it('NotAllowedError → permission-guidance message', async () => {
      const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      (globalThis as any).navigator = {
        mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(err) },
      };
      const vc = createVoiceCapture(deps);
      await expect(vc.start()).rejects.toBe(err);
      expect(statusCalls.at(-1)?.[0]).toBe('error');
      expect(statusCalls.at(-1)?.[1].toLowerCase()).toContain('permission');
    });

    it('NotFoundError → "no microphone" guidance', async () => {
      const err = Object.assign(new Error('no device'), { name: 'NotFoundError' });
      (globalThis as any).navigator = {
        mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(err) },
      };
      const vc = createVoiceCapture(deps);
      await expect(vc.start()).rejects.toBe(err);
      expect(statusCalls.at(-1)?.[1].toLowerCase()).toContain('no microphone');
    });

    it('unknown error → generic fallback message', async () => {
      const err = Object.assign(new Error('weird thing'), { name: 'SomethingElse' });
      (globalThis as any).navigator = {
        mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(err) },
      };
      const vc = createVoiceCapture(deps);
      await expect(vc.start()).rejects.toBe(err);
      expect(statusCalls.at(-1)?.[1]).toContain('weird thing');
    });
  });

  describe('lifecycle', () => {
    it('isCapturing() is false before start', () => {
      const vc = createVoiceCapture(deps);
      expect(vc.isCapturing()).toBe(false);
    });

    it('stop() on a never-started capture is a safe no-op', () => {
      const vc = createVoiceCapture(deps);
      expect(() => vc.stop()).not.toThrow();
      expect(vc.isCapturing()).toBe(false);
    });

    it('getLocalVolume() returns 0 when not capturing', () => {
      const vc = createVoiceCapture(deps);
      expect(vc.getLocalVolume()).toBe(0);
    });
  });

  describe('factory contract', () => {
    it('returns the expected public surface', () => {
      const vc = createVoiceCapture(deps);
      expect(typeof vc.start).toBe('function');
      expect(typeof vc.stop).toBe('function');
      expect(typeof vc.isCapturing).toBe('function');
      expect(typeof vc.getLocalVolume).toBe('function');
    });
  });
});
