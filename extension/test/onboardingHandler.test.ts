import { describe, it, expect, vi, beforeEach } from 'vitest';

// saveConfig + validate* live in providers.ts — mock them so these tests
// stay hermetic (no workspaceState disk writes, no real HTTP calls).
vi.mock('../src/providers', async (imp) => {
  const actual = await imp<typeof import('../src/providers')>();
  return {
    ...actual,
    saveConfig: vi.fn(async () => {}),
    validateGeminiKey: vi.fn(async () => true),
    validateGroqKey: vi.fn(async () => true),
    validateOpenAIKey: vi.fn(async () => false),
    validateAnthropicKey: vi.fn(async () => true),
  };
});

import { OnboardingHandler, OnboardingDeps } from '../src/onboardingHandler';
import { DEFAULT_CONFIG, UserConfig } from '../src/providers';

function makeDeps(overrides: Partial<OnboardingDeps> = {}): OnboardingDeps & {
  __posted: any[];
  __workspaceUpdates: Array<[string, any]>;
  __config: UserConfig;
} {
  const posted: any[] = [];
  const wsUpdates: Array<[string, any]> = [];
  const config = { ...DEFAULT_CONFIG };
  const learnerProfileState = { skillLevel: 'unknown', goal: '' };

  return {
    __posted: posted,
    __workspaceUpdates: wsUpdates,
    __config: config,
    context: {
      workspaceState: { update: vi.fn(async (k, v) => { wsUpdates.push([k, v]); }) },
      globalState: { update: vi.fn() },
    } as any,
    getConfig: () => config,
    setConfig: (c) => { Object.assign(config, c); },
    aiClient: {
      updateConfig: vi.fn(),
      setLearnerProfile: vi.fn(),
      isStreaming: vi.fn(() => false),
      cancel: vi.fn(),
      clearContextWindow: vi.fn(),
    } as any,
    ttsClient: {
      updateConfig: vi.fn(),
      cancel: vi.fn(),
    } as any,
    tracker: {
      updateConfig: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    } as any,
    learnerProfile: {
      update: vi.fn(async (patch: any) => { Object.assign(learnerProfileState, patch); }),
      reset: vi.fn(async () => {}),
      get: vi.fn(() => learnerProfileState),
    } as any,
    aiCoordinator: {
      clearPending: vi.fn(),
    } as any,
    transcriptStore: {
      clearAllTranscripts: vi.fn(),
    } as any,
    notebookPrep: {
      clear: vi.fn(),
    } as any,
    session: {
      reset: vi.fn(),
    } as any,
    getInteractionMode: () => 'chat',
    postMessage: (m) => posted.push(m),
    sanitizedConfig: () => ({ sanitized: true }),
    ...overrides,
  } as any;
}

describe('OnboardingHandler', () => {
  describe('handleSaveSettings', () => {
    it('merges msg.settings into config', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleSaveSettings({ settings: { speechRate: 1.25 } });
      expect(deps.__config.speechRate).toBe(1.25);
    });

    it('applies msg.keyTarget/keyValue into the matching config field', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleSaveSettings({ keyTarget: 'geminiApiKey', keyValue: 'AIzaXXXX' });
      expect(deps.__config.geminiApiKey).toBe('AIzaXXXX');
    });

    it('propagates updated config to all clients', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleSaveSettings({ settings: {} });
      expect(deps.aiClient.updateConfig).toHaveBeenCalled();
      expect(deps.ttsClient.updateConfig).toHaveBeenCalled();
      expect(deps.tracker.updateConfig).toHaveBeenCalled();
    });

    it('posts settings_saved with sanitized config (no raw keys)', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleSaveSettings({ settings: {} });
      const saved = deps.__posted.find((m) => m.type === 'settings_saved');
      expect(saved).toBeDefined();
      expect(saved.config).toEqual({ sanitized: true });
    });
  });

  describe('handleValidateKey', () => {
    it('posts key_validation_result with the provider verdict', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleValidateKey('gemini', 'AIza...');
      expect(deps.__posted).toContainEqual({ type: 'key_validation_result', provider: 'gemini', valid: true });
    });

    it('returns valid=false when the provider rejects', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleValidateKey('openai', 'bad-key');   // mocked to false
      expect(deps.__posted).toContainEqual({ type: 'key_validation_result', provider: 'openai', valid: false });
    });

    it('unknown provider → valid=false', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleValidateKey('mystery', 'x');
      expect(deps.__posted).toContainEqual({ type: 'key_validation_result', provider: 'mystery', valid: false });
    });
  });

  describe('handleCompleteOnboarding', () => {
    it('merges settings + key and marks onboarding complete', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleCompleteOnboarding({
        settings: { llmProvider: 'gemini' },
        keyTarget: 'geminiApiKey',
        keyValue: 'AIzaXXXX',
        skillLevel: 'some',
        goal: 'learn RL for robotics',
      });
      expect(deps.__config.llmProvider).toBe('gemini');
      expect(deps.__config.geminiApiKey).toBe('AIzaXXXX');
      expect(deps.__workspaceUpdates).toContainEqual(['drlzh.onboardingComplete', true]);
    });

    it('persists skill + goal into the learner profile (trims and caps goal length)', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      const longGoal = 'x'.repeat(800);
      await h.handleCompleteOnboarding({
        skillLevel: 'experienced',
        goal: '  ' + longGoal + '  ',
      });
      expect(deps.learnerProfile.update).toHaveBeenCalledWith({
        skillLevel: 'experienced',
        goal: 'x'.repeat(500),
      });
    });

    it('coerces invalid skillLevel to "unknown"', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleCompleteOnboarding({ skillLevel: 'nonsense' });
      expect(deps.learnerProfile.update).toHaveBeenCalledWith({
        skillLevel: 'unknown',
        goal: '',
      });
    });

    it('posts onboarding_complete with config + mode', async () => {
      const deps = makeDeps({ getInteractionMode: () => 'voice' } as any);
      const h = new OnboardingHandler(deps);
      await h.handleCompleteOnboarding({});
      const msg = deps.__posted.find((m) => m.type === 'onboarding_complete');
      expect(msg).toBeDefined();
      expect(msg.mode).toBe('voice');
    });
  });

  describe('handleResetZee', () => {
    it('resets config, wipes learner profile, clears onboarded flag', async () => {
      const deps = makeDeps();
      deps.__config.geminiApiKey = 'ABC';   // pretend we had a key
      const h = new OnboardingHandler(deps);
      await h.handleResetZee();
      expect(deps.__config.geminiApiKey).toBe('');   // default
      expect(deps.learnerProfile.reset).toHaveBeenCalled();
      expect(deps.__workspaceUpdates).toContainEqual(['drlzh.onboardingComplete', false]);
    });

    it('wipes every notebook transcript, the prep cache, and session state', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleResetZee();
      expect(deps.transcriptStore.clearAllTranscripts).toHaveBeenCalled();
      expect(deps.notebookPrep.clear).toHaveBeenCalled();
      expect(deps.session.reset).toHaveBeenCalled();
    });

    it('tears down in-flight AI + TTS so a fresh onboarding starts clean', async () => {
      const deps = makeDeps();
      (deps.aiClient.isStreaming as any).mockReturnValue(true);
      const h = new OnboardingHandler(deps);
      await h.handleResetZee();
      expect(deps.aiClient.cancel).toHaveBeenCalled();
      expect(deps.ttsClient.cancel).toHaveBeenCalled();
      expect(deps.aiClient.clearContextWindow).toHaveBeenCalled();
      expect(deps.aiCoordinator.clearPending).toHaveBeenCalled();
    });

    it('posts transcript_cleared then show_onboarding with sanitized config', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleResetZee();
      expect(deps.__posted).toContainEqual({ type: 'transcript_cleared' });
      const msg = deps.__posted.find((m) => m.type === 'show_onboarding');
      expect(msg).toBeDefined();
      expect(msg.config).toEqual({ sanitized: true });
    });
  });

  describe('handleToggleCompanion', () => {
    it('enabled=true resumes the tracker', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleToggleCompanion(true);
      expect(deps.tracker.resume).toHaveBeenCalled();
      expect(deps.__config.companionEnabled).toBe(true);
    });

    it('enabled=false pauses the tracker, cancels TTS, clears pending initiative', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleToggleCompanion(false);
      expect(deps.tracker.pause).toHaveBeenCalled();
      expect(deps.ttsClient.cancel).toHaveBeenCalled();
      expect(deps.aiCoordinator.clearPending).toHaveBeenCalled();
      expect(deps.__posted).toContainEqual({ type: 'status', state: 'idle' });
    });

    it('enabled=false cancels in-flight AI and emits ai_stopped', async () => {
      const deps = makeDeps();
      (deps.aiClient.isStreaming as any).mockReturnValue(true);
      const h = new OnboardingHandler(deps);
      await h.handleToggleCompanion(false);
      expect(deps.aiClient.cancel).toHaveBeenCalled();
      expect(deps.__posted).toContainEqual({ type: 'ai_stopped' });
    });

    it('broadcasts the new companion_state', async () => {
      const deps = makeDeps();
      const h = new OnboardingHandler(deps);
      await h.handleToggleCompanion(true);
      expect(deps.__posted).toContainEqual({ type: 'companion_state', enabled: true });
    });
  });
});
