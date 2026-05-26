import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error — plain JS module with CommonJS dual export, see face.js header
import { FaceController, deriveFaceState } from '../src/webview/face.js';

/**
 * Minimal element stub matching the duck-typed contract expected by
 * FaceController: setAttribute + style.setProperty. Tests inspect the captured
 * attributes/CSS variables directly.
 */
function makeStubElement() {
  const attrs: Record<string, string> = {};
  const styles: Record<string, string> = {};
  return {
    setAttribute(name: string, value: string) { attrs[name] = value; },
    style: { setProperty(name: string, value: string) { styles[name] = value; } },
    _attrs: attrs,
    _styles: styles,
  };
}

describe('FaceController', () => {
  let el: ReturnType<typeof makeStubElement>;
  let face: InstanceType<typeof FaceController>;

  beforeEach(() => {
    el = makeStubElement();
    face = new FaceController(el);
  });

  describe('construction', () => {
    it('initialises with idle state', () => {
      expect(face.getState()).toBe('idle');
      expect(el._attrs['data-state']).toBe('idle');
    });

    it('initialises mouth intensity to 0', () => {
      expect(face.getMouthIntensity()).toBe(0);
    });

    it('throws if given a non-element', () => {
      expect(() => new FaceController(null)).toThrow();
      expect(() => new FaceController({} as any)).toThrow();
      expect(() => new FaceController({ setAttribute: 'not-a-function' } as any)).toThrow();
    });
  });

  describe('setState', () => {
    it('accepts idle / listening / thinking / speaking', () => {
      for (const state of ['idle', 'listening', 'thinking', 'speaking']) {
        expect(face.setState(state)).toBe(true);
        expect(face.getState()).toBe(state);
        expect(el._attrs['data-state']).toBe(state);
      }
    });

    it('rejects unknown states and keeps prior state', () => {
      face.setState('thinking');
      expect(face.setState('dancing')).toBe(false);
      expect(face.setState('')).toBe(false);
      expect(face.setState(undefined as any)).toBe(false);
      expect(face.getState()).toBe('thinking');
      expect(el._attrs['data-state']).toBe('thinking');
    });

    it('is a no-op when the state is unchanged (but still returns true)', () => {
      face.setState('speaking');
      el._attrs['data-state'] = 'tampered'; // detect whether setAttribute fires
      expect(face.setState('speaking')).toBe(true);
      expect(el._attrs['data-state']).toBe('tampered'); // not overwritten
    });

    it('exposes the valid state list as a static', () => {
      expect(FaceController.VALID_STATES).toEqual(['idle', 'drowsy', 'listening', 'thinking', 'speaking']);
    });
  });

  describe('setMouthIntensity', () => {
    it('writes clamped value as CSS custom property', () => {
      face.setMouthIntensity(0.5);
      expect(face.getMouthIntensity()).toBe(0.5);
      expect(el._styles['--mouth-intensity']).toBe('0.500');
    });

    it('clamps values above 1 and below 0', () => {
      face.setMouthIntensity(5);
      expect(face.getMouthIntensity()).toBe(1);
      expect(el._styles['--mouth-intensity']).toBe('1.000');

      face.setMouthIntensity(-3);
      expect(face.getMouthIntensity()).toBe(0);
      expect(el._styles['--mouth-intensity']).toBe('0.000');
    });

    it('treats NaN / non-numeric as 0', () => {
      face.setMouthIntensity(NaN);
      expect(face.getMouthIntensity()).toBe(0);
      face.setMouthIntensity('oops' as any);
      expect(face.getMouthIntensity()).toBe(0);
    });

    it('silently skips when element has no style object', () => {
      const noStyleEl = { setAttribute: (_n: string, _v: string) => {} };
      const f = new FaceController(noStyleEl);
      expect(() => f.setMouthIntensity(0.7)).not.toThrow();
      expect(f.getMouthIntensity()).toBe(0.7);
    });
  });

  describe('independence of controls', () => {
    it('mouth intensity does not interact with state', () => {
      face.setMouthIntensity(0.8);
      face.setState('idle');
      expect(face.getMouthIntensity()).toBe(0.8);
    });
  });
});

describe('deriveFaceState', () => {
  it('returns idle when all flags are false or missing', () => {
    expect(deriveFaceState({})).toBe('idle');
    expect(deriveFaceState({ isSpeaking: false, isListening: false, isThinking: false })).toBe('idle');
    expect(deriveFaceState(null as any)).toBe('idle');
    expect(deriveFaceState(undefined as any)).toBe('idle');
  });

  it('maps thinking when only isThinking is set', () => {
    expect(deriveFaceState({ isThinking: true })).toBe('thinking');
  });

  it('maps listening when only isListening is set', () => {
    expect(deriveFaceState({ isListening: true })).toBe('listening');
  });

  it('maps speaking when only isSpeaking is set', () => {
    expect(deriveFaceState({ isSpeaking: true })).toBe('speaking');
  });

  it('speaking wins over listening and thinking', () => {
    expect(deriveFaceState({ isSpeaking: true, isListening: true, isThinking: true })).toBe('speaking');
  });

  it('listening wins over thinking', () => {
    expect(deriveFaceState({ isListening: true, isThinking: true })).toBe('listening');
  });
});
