// Backward-compatibility barrel. The real code moved to focused modules
// during the Phase 5 reorganization — this file just re-exports everything
// so existing imports (`from './providers'`) keep compiling.
//
// New code should import directly from the focused module:
//   userConfig.ts      — UserConfig, DEFAULT_CONFIG, load/save, MicSensitivity
//   course.ts          — CHAPTER_TITLES, CHAPTER_CONTEXT, buildCourseTOC
//   systemPrompts.ts   — SYSTEM_PROMPT_PERSONA, META_MODE, VOICE_MODE
//   llmProviders.ts    — LLMProvider + Gemini/OpenAI/Anthropic classes,
//                        getLLMProvider, getCheapProvider, validate*
//   moonshineSTT.ts    — MoonshineSTT
//   kokoroTTS.ts       — KokoroTTSProvider, TTSProvider, getTTSProvider
//   audioUtils.ts      — pcmToWav

export * from './userConfig';
export * from './course';
export * from './systemPrompts';
export * from './llmProviders';
export * from './moonshineSTT';
export * from './kokoroTTS';
export * from './audioUtils';
