// Onboarding + settings + pause/resume lifecycle handlers. These all modify
// `config` and propagate the change to every dependent client, so they live
// together rather than sprinkled through CompanionViewProvider.

import * as vscode from 'vscode';
import {
  UserConfig, DEFAULT_CONFIG, InteractionMode, saveConfig,
  validateGroqKey, validateGeminiKey, validateOpenAIKey, validateAnthropicKey,
} from './providers';
import type { AIClient } from './aiClient';
import type { TTSClient } from './ttsClient';
import type { ContextTracker } from './contextTracker';
import type { LearnerProfileStore, SkillLevel } from './learnerProfile';
import type { AICoordinator } from './aiCoordinator';
import type { TranscriptStore } from './transcriptStore';
import type { NotebookPrep } from './notebookPrep';
import type { SessionManager } from './sessionManager';
import { KEY_ONBOARDING_COMPLETE, KEY_COMPANION_ENABLED } from './constants';

export interface OnboardingDeps {
  context: vscode.ExtensionContext;
  getConfig: () => UserConfig;
  setConfig: (c: UserConfig) => void;
  aiClient: AIClient;
  ttsClient: TTSClient;
  tracker: ContextTracker;
  learnerProfile: LearnerProfileStore;
  aiCoordinator: AICoordinator;
  transcriptStore: TranscriptStore;
  notebookPrep: NotebookPrep;
  session: SessionManager;
  getInteractionMode: () => InteractionMode;
  postMessage: (m: any) => void;
  /** Serializes `config` with API keys stripped out; used for webview replies. */
  sanitizedConfig: () => any;
}

export class OnboardingHandler {
  constructor(private deps: OnboardingDeps) {}

  /** Settings panel "save" — merges msg.settings / keyTarget into config, persists, propagates. */
  async handleSaveSettings(msg: any): Promise<void> {
    let config = this.deps.getConfig();

    if (msg.settings) {
      config = { ...config, ...msg.settings };
    }
    if (msg.keyTarget && msg.keyValue !== undefined) {
      (config as any)[msg.keyTarget] = msg.keyValue;
    }
    this.deps.setConfig(config);

    await saveConfig(config, this.deps.context.workspaceState, this.deps.context.globalState);

    this.deps.aiClient.updateConfig(config);
    this.deps.ttsClient.updateConfig(config);
    this.deps.tracker.updateConfig(config);

    this.deps.postMessage({ type: 'settings_saved', config: this.deps.sanitizedConfig() });
  }

  /** Live API-key validation — called on blur in the settings/onboarding form. */
  async handleValidateKey(provider: string, key: string): Promise<void> {
    let valid = false;
    switch (provider) {
      case 'groq':      valid = await validateGroqKey(key); break;
      case 'gemini':    valid = await validateGeminiKey(key); break;
      case 'openai':    valid = await validateOpenAIKey(key); break;
      case 'anthropic': valid = await validateAnthropicKey(key); break;
    }
    this.deps.postMessage({ type: 'key_validation_result', provider, valid });
  }

  /** Finish onboarding: save settings, record skill/goal in the learner profile, propagate. */
  async handleCompleteOnboarding(msg: any): Promise<void> {
    let config = this.deps.getConfig();
    if (msg.settings) { config = { ...config, ...msg.settings }; }
    if (msg.keyTarget && msg.keyValue) { (config as any)[msg.keyTarget] = msg.keyValue; }
    this.deps.setConfig(config);

    await saveConfig(config, this.deps.context.workspaceState, this.deps.context.globalState);
    await this.deps.context.workspaceState.update(KEY_ONBOARDING_COMPLETE, true);

    // Learner profile capture — optional fields from the onboarding form.
    const skill: SkillLevel = ['none', 'some', 'experienced'].includes(msg.skillLevel)
      ? msg.skillLevel
      : 'unknown';
    await this.deps.learnerProfile.update({
      skillLevel: skill,
      goal: typeof msg.goal === 'string' ? msg.goal.trim().slice(0, 500) : '',
    });
    this.deps.aiClient.setLearnerProfile(this.deps.learnerProfile.get());

    this.deps.aiClient.updateConfig(config);
    this.deps.ttsClient.updateConfig(config);
    this.deps.tracker.updateConfig(config);

    this.deps.postMessage({
      type: 'onboarding_complete',
      config: this.deps.sanitizedConfig(),
      mode: this.deps.getInteractionMode(),
    });
  }

  /**
   * "Reset Zee" from settings — full factory reset:
   *   - settings + API keys back to DEFAULT_CONFIG
   *   - onboarded flag cleared so the wizard runs again
   *   - learner profile (skill level, goal, touched-chapters) wiped
   *   - in-flight LLM/TTS state torn down
   *   - on-disk transcripts for every notebook deleted
   *   - notebook-prep cache (summaries + solutions) cleared
   *   - active per-notebook session state cleared
   */
  async handleResetZee(): Promise<void> {
    // Tear down anything in-flight before swapping config out from under it.
    if (this.deps.aiClient.isStreaming()) {
      this.deps.aiClient.cancel();
    }
    this.deps.ttsClient.cancel();
    this.deps.aiClient.clearContextWindow();
    this.deps.aiCoordinator.clearPending();

    const config = { ...DEFAULT_CONFIG };
    this.deps.setConfig(config);
    await saveConfig(config, this.deps.context.workspaceState, this.deps.context.globalState);
    await this.deps.context.workspaceState.update(KEY_ONBOARDING_COMPLETE, false);
    await this.deps.learnerProfile.reset();
    this.deps.aiClient.setLearnerProfile(this.deps.learnerProfile.get());

    this.deps.aiClient.updateConfig(config);
    this.deps.ttsClient.updateConfig(config);
    this.deps.tracker.updateConfig(config);

    // Wipe persistent state — every notebook's transcript, the prep cache,
    // and the in-memory session pointers. The webview is sent back to the
    // onboarding panel below, so any UI that referenced these is gone too.
    this.deps.transcriptStore.clearAllTranscripts();
    this.deps.notebookPrep.clear();
    this.deps.session.reset();

    this.deps.postMessage({ type: 'transcript_cleared' });
    this.deps.postMessage({ type: 'show_onboarding', config: this.deps.sanitizedConfig() });
  }

  /** Pause/resume Zee globally — cancels in-flight work on pause. */
  async handleToggleCompanion(enabled: boolean): Promise<void> {
    const config = this.deps.getConfig();
    config.companionEnabled = enabled;
    this.deps.setConfig(config);
    await this.deps.context.workspaceState.update(KEY_COMPANION_ENABLED, enabled);

    if (enabled) {
      this.deps.tracker.resume();
    } else {
      if (this.deps.aiClient.isStreaming()) {
        this.deps.aiClient.cancel();
        this.deps.postMessage({ type: 'ai_stopped' });
      }
      this.deps.ttsClient.cancel();
      this.deps.tracker.pause();
      this.deps.aiCoordinator.clearPending();
      this.deps.postMessage({ type: 'status', state: 'idle' });
    }

    this.deps.postMessage({ type: 'companion_state', enabled });
  }
}
