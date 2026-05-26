import * as vscode from 'vscode';
import {
  KEY_LLM_PROVIDER, KEY_SPEECH_RATE, KEY_VOICE_RESPONSES, KEY_MIC_SENSITIVITY,
  KEY_DEFAULT_MODE, KEY_COMPANION_ENABLED,
  KEY_GROQ_MODEL, KEY_GEMINI_MODEL, KEY_OPENAI_MODEL, KEY_ANTHROPIC_MODEL,
  DEFAULT_GROQ_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_ANTHROPIC_MODEL,
  SECRET_GROQ_KEY, SECRET_GEMINI_KEY, SECRET_OPENAI_KEY, SECRET_ANTHROPIC_KEY,
  SPEECH_RATE_DEFAULT,
} from './constants';

export type LLMProviderId = 'groq' | 'gemini' | 'openai' | 'anthropic';
export type InteractionMode = 'chat' | 'voice';
export type MicSensitivity = 'quiet' | 'normal' | 'noisy';

export interface UserConfig {
  llmProvider: LLMProviderId;
  groqApiKey: string;
  geminiApiKey: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  groqModel: string;
  geminiModel: string;
  openaiModel: string;
  anthropicModel: string;

  speechRate: number;
  voiceResponsesEnabled: boolean;
  micSensitivity: MicSensitivity;

  defaultInteractionMode: InteractionMode;
  companionEnabled: boolean;
}

export const DEFAULT_CONFIG: UserConfig = {
  llmProvider: 'gemini',
  groqApiKey: '',
  geminiApiKey: '',
  openaiApiKey: '',
  anthropicApiKey: '',
  groqModel: DEFAULT_GROQ_MODEL,
  geminiModel: DEFAULT_GEMINI_MODEL,
  openaiModel: DEFAULT_OPENAI_MODEL,
  anthropicModel: DEFAULT_ANTHROPIC_MODEL,
  speechRate: SPEECH_RATE_DEFAULT,
  voiceResponsesEnabled: true,
  micSensitivity: 'normal',
  defaultInteractionMode: 'chat',
  companionEnabled: true,
};

/**
 * Multiplier applied on top of auto-calibrated VAD thresholds. Auto-calibration
 * measures the real ambient noise floor each time the mic opens and sets
 * START/STOP relative to it; this just nudges the floor → threshold gap.
 *   quiet   → more sensitive (lower thresholds; good for whisper-heavy rooms)
 *   normal  → default
 *   noisy   → less sensitive (more headroom above ambient; avoids false triggers)
 */
export function micSensitivityMultiplier(s: MicSensitivity): number {
  switch (s) {
    case 'quiet':  return 0.8;
    case 'noisy':  return 1.4;
    default:       return 1.0;
  }
}

export async function loadConfig(
  state: vscode.Memento,
  keyStore: vscode.Memento,
): Promise<UserConfig> {
  return {
    llmProvider: state.get<LLMProviderId>(KEY_LLM_PROVIDER, DEFAULT_CONFIG.llmProvider),
    groqApiKey: keyStore.get<string>(SECRET_GROQ_KEY, ''),
    geminiApiKey: keyStore.get<string>(SECRET_GEMINI_KEY, ''),
    openaiApiKey: keyStore.get<string>(SECRET_OPENAI_KEY, ''),
    anthropicApiKey: keyStore.get<string>(SECRET_ANTHROPIC_KEY, ''),
    groqModel: state.get<string>(KEY_GROQ_MODEL, DEFAULT_CONFIG.groqModel),
    geminiModel: state.get<string>(KEY_GEMINI_MODEL, DEFAULT_CONFIG.geminiModel),
    openaiModel: state.get<string>(KEY_OPENAI_MODEL, DEFAULT_CONFIG.openaiModel),
    anthropicModel: state.get<string>(KEY_ANTHROPIC_MODEL, DEFAULT_CONFIG.anthropicModel),
    speechRate: state.get<number>(KEY_SPEECH_RATE, DEFAULT_CONFIG.speechRate),
    voiceResponsesEnabled: state.get<boolean>(KEY_VOICE_RESPONSES, DEFAULT_CONFIG.voiceResponsesEnabled),
    micSensitivity: state.get<MicSensitivity>(KEY_MIC_SENSITIVITY, DEFAULT_CONFIG.micSensitivity),
    defaultInteractionMode: state.get<InteractionMode>(KEY_DEFAULT_MODE, DEFAULT_CONFIG.defaultInteractionMode),
    companionEnabled: state.get<boolean>(KEY_COMPANION_ENABLED, DEFAULT_CONFIG.companionEnabled),
  };
}

export async function saveConfig(
  config: UserConfig,
  state: vscode.Memento,
  keyStore: vscode.Memento,
): Promise<void> {
  const modelValue = (value: string | undefined, fallback: string) => (value || fallback).trim() || fallback;

  await Promise.all([
    state.update(KEY_LLM_PROVIDER, config.llmProvider),
    state.update(KEY_GROQ_MODEL, modelValue(config.groqModel, DEFAULT_CONFIG.groqModel)),
    state.update(KEY_GEMINI_MODEL, modelValue(config.geminiModel, DEFAULT_CONFIG.geminiModel)),
    state.update(KEY_OPENAI_MODEL, modelValue(config.openaiModel, DEFAULT_CONFIG.openaiModel)),
    state.update(KEY_ANTHROPIC_MODEL, modelValue(config.anthropicModel, DEFAULT_CONFIG.anthropicModel)),
    state.update(KEY_SPEECH_RATE, config.speechRate),
    state.update(KEY_VOICE_RESPONSES, config.voiceResponsesEnabled),
    state.update(KEY_MIC_SENSITIVITY, config.micSensitivity),
    state.update(KEY_DEFAULT_MODE, config.defaultInteractionMode),
    state.update(KEY_COMPANION_ENABLED, config.companionEnabled),
    keyStore.update(SECRET_GROQ_KEY, config.groqApiKey),
    keyStore.update(SECRET_GEMINI_KEY, config.geminiApiKey),
    keyStore.update(SECRET_OPENAI_KEY, config.openaiApiKey),
    keyStore.update(SECRET_ANTHROPIC_KEY, config.anthropicApiKey),
  ]);
}
