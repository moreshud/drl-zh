import { describe, it, expect } from 'vitest';
import { decideVoiceStatusAction } from '../src/webview/voiceStatusReducer';

describe('decideVoiceStatusAction', () => {
  it('returns "speaking" when state is speaking', () => {
    expect(decideVoiceStatusAction({ state: 'speaking', micMuted: false, ttsActive: false })).toBe('speaking');
    // Muted / TTS flags don't matter — speaking wins.
    expect(decideVoiceStatusAction({ state: 'speaking', micMuted: true,  ttsActive: true  })).toBe('speaking');
  });

  it('returns "idle_start_mic" on idle when not muted and TTS is silent', () => {
    expect(decideVoiceStatusAction({ state: 'idle', micMuted: false, ttsActive: false })).toBe('idle_start_mic');
  });

  it('returns "idle_muted" when idle and user has the mic muted', () => {
    // Mute takes precedence over TTS state — we still route to "Muted"
    // rather than starting the mic even if TTS happens to be silent.
    expect(decideVoiceStatusAction({ state: 'idle', micMuted: true, ttsActive: false })).toBe('idle_muted');
    expect(decideVoiceStatusAction({ state: 'idle', micMuted: true, ttsActive: true  })).toBe('idle_muted');
  });

  it('returns "idle_wait_tts" when idle, not muted, but TTS is still draining', () => {
    // Regression guard for the bug where chat.js referenced an undefined
    // `isPlayingAudio`, threw ReferenceError, and silently killed mic
    // restart on turn 2+. The reducer makes this gating path explicit.
    expect(decideVoiceStatusAction({ state: 'idle', micMuted: false, ttsActive: true })).toBe('idle_wait_tts');
  });

  it('returns "none" for other states (thinking, transcribing, unknown)', () => {
    expect(decideVoiceStatusAction({ state: 'thinking', micMuted: false, ttsActive: false })).toBe('none');
    expect(decideVoiceStatusAction({ state: 'transcribing', micMuted: false, ttsActive: false })).toBe('none');
    expect(decideVoiceStatusAction({ state: 'nonsense', micMuted: false, ttsActive: false })).toBe('none');
  });
});
