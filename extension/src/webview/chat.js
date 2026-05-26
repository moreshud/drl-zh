// @ts-check
/// <reference lib="dom" />

(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ── DOM refs ────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const stopBtn = $('stopBtn');
  const settingsBtn = $('settingsBtn');
  const contextPill = $('contextPill');
  const modeToggle = $('modeToggle');
  const chatModeBtn = $('chatModeBtn');
  const voiceModeBtn = $('voiceModeBtn');
  const onboardingPanel = $('onboardingPanel');
  const transcriptPanel = $('transcriptPanel');
  const settingsPanel = $('settingsPanel');
  const transcript = $('transcript');
  const inputBar = $('inputBar');
  const chatInput = $('chatInput');
  const voiceInput = $('voiceInput');
  const chatTextField = $('chatTextField');
  const chatSendBtn = $('chatSendBtn');
  const voiceCanvas = $('voiceCanvas');
  const settingsBackBtn = $('settingsBackBtn');
  const clearBtn = $('clearBtn');
  const toggleBtn = $('toggleBtn');
  const pausedOverlay = $('pausedOverlay');
  const resumeBtn = $('resumeBtn');
  const noKeyBanner = $('noKeyBanner');
  const noKeyBannerText = $('noKeyBannerText');
  const noKeySettingsBtn = $('noKeySettingsBtn');
  const voiceWarning = $('voiceWarning');
  const voiceWarningText = $('voiceWarningText');
  const voiceWarnSettingsBtn = $('voiceWarnSettingsBtn');
  const noNotebookState = $('noNotebookState');

  // ── Zee face controller ─────────────────────────────────────────────────
  // FaceController comes from face.js, loaded just before this script. It
  // drives the avatar SVG via data-state / --mouth-intensity.
  const zeeFaceEl = $('zeeFace');
  const FaceControllerCtor = /** @type {any} */ (globalThis).FaceController;
  const faceCtl = (zeeFaceEl && FaceControllerCtor) ? new FaceControllerCtor(zeeFaceEl) : null;
  const faceFlags = { isThinking: false, isListening: false, isSpeaking: false, isDrowsy: false };
  function refreshFace() {
    if (!faceCtl || !FaceControllerCtor) { return; }
    faceCtl.setState(FaceControllerCtor.deriveFaceState(faceFlags));
  }

  // ── Thought cloud ───────────────────────────────────────────────────────
  // Replaces the old "ai_request_to_speak" Accept/Dismiss bar. A thought
  // cloud surfaces near Zee, click → sends a `thought_followup` to host
  // which turns it into a "Tell me more …" user message.
  const thoughtCloudHostEl = $('thoughtCloudHost');
  const ThoughtCloudCtor = /** @type {any} */ (globalThis).ZeeThoughtCloud;
  // The .header-face wrapper toggles a `has-thought` class while the cloud
  // is up, which shifts Zee subtly to the left so the bubble (anchored on
  // the right) doesn't crowd her face.
  const headerFaceEl = thoughtCloudHostEl?.parentElement ?? null;
  const thoughtCloud = (thoughtCloudHostEl && ThoughtCloudCtor)
    ? ThoughtCloudCtor.createThoughtCloud({
        root: thoughtCloudHostEl,
        onFollowUp: (expandHint) => {
          vscode.postMessage({ type: 'thought_followup', expandHint });
        },
        onVisibilityChange: (visible) => {
          headerFaceEl?.classList.toggle('has-thought', visible);
        },
      })
    : null;

  // ── Activity pings: throttled so we don't flood the host on every keystroke ─
  let lastActivityPingAt = 0;
  function sendActivityPing() {
    const now = Date.now();
    if (now - lastActivityPingAt < 1000) return;
    lastActivityPingAt = now;
    vscode.postMessage({ type: 'activity_ping' });
  }

  // ── State ───────────────────────────────────────────────────────────────
  let mode = 'chat'; // 'chat' | 'voice'
  let currentPanel = 'transcript'; // 'onboarding' | 'transcript' | 'settings'
  // Audio capture always happens here in the webview via getUserMedia +
  // MediaRecorder. The webview also decodes/resamples to 16 kHz PCM before
  // forwarding to the extension host, which runs Moonshine in a worker
  // thread. This keeps mic behaviour identical across desktop VS Code,
  // code-server, and the Dockerized environment.
  let companionEnabled = true;
  let micMuted = false;
  let aiIsSpeaking = false;
  let notebookOpen = false; // true when an ipynb is active
  let currentCellIndex = -1;

  // ── Readiness state ─────────────────────────────────────────────────────
  // Moonshine (STT) and Kokoro (TTS) both run locally — only the LLM key
  // needs to be configured.
  let currentReadiness = { hasLLMKey: false };
  let lastSanitizedConfig = null; // last config from extension (has hasXxxKey flags)

  function computeReadiness(config) {
    if (!config) { return { hasLLMKey: false }; }

    const hasLLMKey = (() => {
      switch (config.llmProvider) {
        case 'groq':        return !!config.hasGroqKey;
        case 'gemini':      return !!config.hasGeminiKey;
        case 'openai':      return !!config.hasOpenaiKey;
        case 'anthropic':   return !!config.hasAnthropicKey;
        default:            return false;
      }
    })();

    return { hasLLMKey };
  }

  function updateReadinessUI(readiness) {
    currentReadiness = readiness;

    // LLM key banner
    noKeyBanner.classList.toggle('hidden', readiness.hasLLMKey);

    // If voice mode is active, re-evaluate voice warnings
    if (mode === 'voice') {
      applyVoiceWarning();
    }
  }

  function applyVoiceWarning() {
    voiceWarning.classList.add('hidden');
    voiceCanvas.classList.remove('hidden');
    $('micIndicator').classList.remove('hidden');
  }

  // ── Awareness pill rendering ──────────────────────────────────────────────
  // Render the structured pill segments into the contextPill element +
  // pulse the pill briefly when the cursor line changes, so the student
  // can SEE Zee tracking their cursor in real time.
  let lastRenderedCursorLine = -1;
  /** @type {any} */ let pulseTimer = null;
  function renderAwarenessPill(ctx) {
    const api = /** @type {any} */ (globalThis).ZeeAwarenessPill;
    const pill = api.formatAwarenessPill(ctx);
    // Rebuild children from segments (no innerHTML — strict CSP-safe DOM).
    contextPill.replaceChildren();
    for (const seg of pill.segments) {
      if (seg.kind === 'label') {
        const strong = document.createElement('strong');
        strong.textContent = seg.text;
        contextPill.appendChild(strong);
      } else {
        contextPill.appendChild(document.createTextNode(seg.text));
      }
    }
    contextPill.title = pill.tooltip;

    // Brief pulse on cursor-line changes.
    const newCursor = typeof ctx.cursorLine === 'number' ? ctx.cursorLine : -1;
    if (newCursor > 0 && newCursor !== lastRenderedCursorLine) {
      contextPill.classList.remove('cursor-bumped');
      // Force reflow so re-adding the class restarts the animation even
      // when the line changes faster than the animation duration.
      // eslint-disable-next-line no-unused-expressions
      contextPill.offsetWidth;
      contextPill.classList.add('cursor-bumped');
      if (pulseTimer) { clearTimeout(pulseTimer); }
      pulseTimer = setTimeout(() => {
        contextPill.classList.remove('cursor-bumped');
        pulseTimer = null;
      }, 220);
    }
    lastRenderedCursorLine = newCursor;
  }

  // ── Markdown rendering ──────────────────────────────────────────────────
  // Implementation lives in webview/markdown.js so it's independently testable.
  const renderMarkdown = /** @type {any} */ (globalThis).ZeeMarkdown.renderMarkdown;

  // ── Panels ──────────────────────────────────────────────────────────────
  function showPanel(name) {
    currentPanel = name;
    onboardingPanel.classList.toggle('hidden', name !== 'onboarding');
    transcriptPanel.classList.toggle('hidden', name !== 'transcript');
    settingsPanel.classList.toggle('hidden', name !== 'settings');
    inputBar.classList.toggle('hidden', name !== 'transcript');
  }

  // ── Mode toggle ─────────────────────────────────────────────────────────
  function setMode(newMode) {
    mode = newMode;
    chatModeBtn.classList.toggle('active', mode === 'chat');
    voiceModeBtn.classList.toggle('active', mode === 'voice');
    chatInput.classList.toggle('hidden', mode !== 'chat');
    voiceInput.classList.toggle('hidden', mode !== 'voice');
    vscode.postMessage({ type: 'set_mode', mode });

    if (mode === 'voice') {
      getAudioContext(); // prime AudioContext on user gesture so TTS can play later
      micMuted = false;
      $('micIndicator')?.classList.remove('muted');
      applyVoiceWarning();
      startSTT(); // opens mic via getUserMedia and kicks off the VAD + volume-vis loops
    } else {
      voiceWarning.classList.add('hidden');
      setVoiceStatus('', '');
      stopSTT();
      stopVolumeVis();
      cancelAllSpeech(); // stop any TTS audio that was playing
      faceFlags.isListening = false;
      faceFlags.isSpeaking = false;
      refreshFace();
    }
    refreshSendNowVisibility();
  }

  noKeySettingsBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'show_settings' });
  });

  voiceWarnSettingsBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'show_settings' });
  });

  chatModeBtn.addEventListener('click', () => setMode('chat'));
  voiceModeBtn.addEventListener('click', () => setMode('voice'));

  // ── Chat input ──────────────────────────────────────────────────────────
  function sendChatMessage() {
    const text = chatTextField.value.trim();
    if (!text) return;
    chatTextField.value = '';
    resetChatFieldSize();
    // Hide the no-notebook welcome card once the student has started chatting.
    if (!notebookOpen) { noNotebookState?.classList.add('hidden'); }
    appendEntry('user', 'chat', text);
    refreshUndoVisibility();
    // Host already knows about any pending attachment via prior
    // set_pending_attachment messages — no extra payload needed here.
    vscode.postMessage({ type: 'user_message', text, mode: 'chat' });
    // Local UI: the attachment was one-shot; clear the thumbnail.
    consumePendingAttachment();
  }

  chatSendBtn.addEventListener('click', sendChatMessage);

  const decideKeyAction = /** @type {any} */ (globalThis).ZeeInputKey?.decideKeyAction;
  chatTextField.addEventListener('keydown', (e) => {
    const action = decideKeyAction ? decideKeyAction(e) : (e.key === 'Enter' && !e.shiftKey ? 'send' : 'pass');
    if (action === 'send') { e.preventDefault(); sendChatMessage(); }
    // 'newline' and 'pass' fall through — the textarea inserts \n or
    // whatever the platform default is.
  });

  // Auto-grow the textarea up to a max-height so single-line stays compact
  // and multi-line composing gets room to breathe. CSS sets max-height; we
  // shrink-then-set scrollHeight so it reflows correctly.
  function autoSizeChatField() {
    chatTextField.style.height = 'auto';
    chatTextField.style.height = chatTextField.scrollHeight + 'px';
  }
  // Typing itself counts as activity — keeps Zee from fading to drowsy while
  // the user is composing a message.
  chatTextField.addEventListener('input', () => {
    sendActivityPing();
    autoSizeChatField();
  });
  // Reset height after sending so the field collapses back to one row.
  function resetChatFieldSize() { chatTextField.style.height = ''; }

  // ── Stop buttons ────────────────────────────────────────────────────────
  stopBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop_speaking' });
    cancelAllSpeech();
  });

  $('voiceStopBtn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop_speaking' });
    cancelAllSpeech();
  });

  // ── "Send now" button: force the current utterance to transcribe ─────────
  // without waiting for VAD silence. Useful when background noise keeps
  // resetting the silence timer — the student clicks this to commit.
  $('sendNowBtn')?.addEventListener('click', () => {
    if (mode !== 'voice' || micMuted || !micActive || aiIsSpeaking || sttTranscribing) { return; }
    vscode.postMessage({ type: 'force_finish_utterance' });
  });

  /**
   * Keep the "Send now" button visible only when it can actually be used:
   *   - we're in voice mode
   *   - mic is hot (micActive) and not muted
   *   - Zee isn't speaking
   *   - we aren't already transcribing
   * Called from every state transition that might change those conditions.
   */
  function refreshSendNowVisibility() {
    const btn = $('sendNowBtn');
    if (!btn) { return; }
    const canUse = mode === 'voice' && micActive && !micMuted && !aiIsSpeaking && !sttTranscribing;
    btn.classList.toggle('hidden', !canUse);
  }
  // Hidden by default — revealed when setMode('voice') runs.
  $('sendNowBtn')?.classList.add('hidden');

  // ── Undo last turn ──────────────────────────────────────────────────────
  // Peels off the last (you, Zee) exchange from the transcript. Useful
  // when background noise or a misheard word derailed it. Visibility is
  // driven by refreshUndoVisibility — shown when there's a real pair, or
  // a trailing errored stub from a failed LLM turn.
  //
  // Always confirm-on-second-click (mirrors clearBtn). Two underlying
  // actions depending on what's at the tail:
  //   - Real pair → roundtrip `undo_last_turn` so disk + LLM context get
  //     popped on the host, then the host posts `turn_undone` and we
  //     peel the bubbles.
  //   - Errored stub → peel locally only; those entries don't exist in
  //     disk/LLM state. One click confirms one failed turn, so stacked
  //     errors get unwound one at a time.
  const undoBtns = [$('chatUndoBtn'), $('voiceUndoBtn')].filter(Boolean);
  let undoConfirmTimeout = null;

  function setUndoConfirming(confirming) {
    for (const btn of undoBtns) {
      btn.dataset.confirming = confirming ? 'true' : 'false';
      btn.title = confirming ? 'Click again to confirm' : 'Undo last turn';
    }
  }
  function resetUndoConfirm() {
    if (undoConfirmTimeout) {
      clearTimeout(undoConfirmTimeout);
      undoConfirmTimeout = null;
    }
    setUndoConfirming(false);
  }

  function handleUndoClick() {
    const confirming = undoBtns.some((b) => b.dataset.confirming === 'true');
    if (!confirming) {
      setUndoConfirming(true);
      undoConfirmTimeout = setTimeout(() => {
        resetUndoConfirm();
      }, 3000);
      return;
    }
    resetUndoConfirm();
    if (transcript.lastElementChild?.classList.contains('errored')) {
      transcriptView.removeTrailingErrored();
      refreshUndoVisibility();
    } else {
      vscode.postMessage({ type: 'undo_last_turn' });
    }
  }
  for (const btn of undoBtns) {
    btn.addEventListener('click', handleUndoClick);
  }

  function refreshUndoVisibility() {
    // Undo is offered when nothing is streaming AND either:
    //   a) the trailing entry is `.errored` (LLM-failure leftovers), or
    //   b) the last two entries are a clean user+companion pair.
    let canUndo = false;
    if (!transcriptView.isStreaming()) {
      const last = transcript.lastElementChild;
      if (last?.classList.contains('errored')) {
        canUndo = true;
      } else {
        const entries = transcript.querySelectorAll('.transcript-entry');
        if (entries.length >= 2) {
          const tail = entries[entries.length - 1];
          const prev = entries[entries.length - 2];
          const lastIsPlainCompanion = !!tail.querySelector('.entry-label.companion')
            && !tail.classList.contains('entry-initiative');
          const prevIsUser = !!prev.querySelector('.entry-label.user');
          canUndo = lastIsPlainCompanion && prevIsUser;
        }
      }
    }
    if (!canUndo) { resetUndoConfirm(); }
    for (const btn of undoBtns) {
      btn.classList.toggle('hidden', !canUndo);
    }
  }

  // ── Attach plot to next message ─────────────────────────────────────────
  // The host detects a nearby PNG output and ships it in context_update.
  // We surface an attach button + thumbnail; the student deliberately
  // attaches it before sending. Auto-clears after one send (one-shot).
  /** @type {{cellIndex:number, mimeType:string, dataBase64:string} | null} */
  let attachableCandidate = null;
  /** @type {{cellIndex:number, mimeType:string, dataBase64:string} | null} */
  let pendingAttachment = null;

  function handleAttachableUpdate(candidate) {
    attachableCandidate = candidate ?? null;
    // If the user had a pending attachment for a cell that is no longer
    // attachable (e.g. they navigated far away, or the plot was cleared),
    // detach quietly. Otherwise keep the attachment as-is until send.
    if (pendingAttachment && (!candidate || candidate.cellIndex !== pendingAttachment.cellIndex)) {
      // Tolerate the case where the SAME cell is still attachable but the
      // image data changed — refresh the pending attachment to the latest.
      if (candidate && candidate.cellIndex === pendingAttachment.cellIndex) {
        pendingAttachment = candidate;
      }
    }
    refreshAttachUI();
  }

  function refreshAttachUI() {
    const canAttach = !!attachableCandidate;
    $('chatAttachBtn')?.classList.toggle('hidden', !canAttach);
    $('voiceAttachBtn')?.classList.toggle('hidden', !canAttach);

    const preview = $('attachmentPreview');
    if (!preview) { return; }
    if (pendingAttachment) {
      $('attachmentThumb').src = `data:${pendingAttachment.mimeType};base64,${pendingAttachment.dataBase64}`;
      $('attachmentLabel').textContent = `plot from cell ${pendingAttachment.cellIndex + 1}`;
      preview.classList.remove('hidden');
    } else {
      preview.classList.add('hidden');
    }
  }

  function attachCurrentPlot() {
    if (!attachableCandidate) { return; }
    pendingAttachment = attachableCandidate;
    refreshAttachUI();
    // Tell the host so it picks up the attachment on the NEXT user message —
    // works for chat AND voice (host-side handleUserMessage is the single
    // join point for both).
    vscode.postMessage({ type: 'set_pending_attachment', cellIndex: pendingAttachment.cellIndex });
  }

  function detachPlot() {
    pendingAttachment = null;
    refreshAttachUI();
    vscode.postMessage({ type: 'set_pending_attachment', cellIndex: null });
  }

  /** Local UI clear after a send completes. Host clears its own state. */
  function consumePendingAttachment() {
    pendingAttachment = null;
    refreshAttachUI();
  }

  $('chatAttachBtn')?.addEventListener('click', attachCurrentPlot);
  $('voiceAttachBtn')?.addEventListener('click', attachCurrentPlot);
  $('attachmentDetach')?.addEventListener('click', detachPlot);

  // ── Mute toggle (clicking the pulsing red dot) ──────────────────────────
  // The mic indicator IS the mute button — a single control that both shows
  // recording state and toggles it. Active = pulsing red dot, muted = dim
  // dot with a diagonal strike-through (handled in CSS).
  $('micIndicator')?.addEventListener('click', () => {
    micMuted = !micMuted;
    const dot = $('micIndicator');
    dot.classList.toggle('muted', micMuted);
    dot.title = micMuted ? 'Click to unmute microphone' : 'Click to mute microphone';
    dot.setAttribute('aria-label', micMuted
      ? 'Microphone is muted — click to unmute'
      : 'Microphone is active — click to mute');
    if (micMuted) {
      stopSTT();
      stopVolumeVis();
      voiceCanvas.classList.add('hidden');
      // Don't hide the dot — keep it visible in its "muted" state so users
      // know where to click to unmute.
      // Preserve in-flight UI states: don't stomp "Transcribing…" or the
      // AI-speaking status. The stt_status handler will route to "Muted"
      // once the current transcription completes.
      if (!aiIsSpeaking && !sttTranscribing) {
        setVoiceStatus('', 'Muted');
      }
    } else {
      // Don't start recording if AI is speaking — mic resumes when AI finishes
      if (!aiIsSpeaking) {
        voiceCanvas.classList.remove('hidden');
        setVoiceStatus('', '');
        startSTT();
      }
    }
    refreshSendNowVisibility();
  });

  // ── Settings ────────────────────────────────────────────────────────────
  settingsBtn.addEventListener('click', () => {
    if (currentPanel === 'settings') {
      showPanel('transcript');
    } else {
      showPanel('settings');
    }
  });

  settingsBackBtn.addEventListener('click', () => {
    saveCurrentSettings();
    showPanel('transcript');
  });

  // ── Clear button (header) ─────────────────────────────────────────────
  let clearBtnTimeout = null;
  clearBtn.addEventListener('click', () => {
    if (clearBtn.dataset.confirming === 'true') {
      clearBtn.dataset.confirming = 'false';
      clearBtn.title = 'Clear conversation';
      clearTimeout(clearBtnTimeout);
      vscode.postMessage({ type: 'clear_transcript' });
    } else {
      clearBtn.dataset.confirming = 'true';
      clearBtn.title = 'Click again to confirm';
      clearBtnTimeout = setTimeout(() => {
        clearBtn.dataset.confirming = 'false';
        clearBtn.title = 'Clear conversation';
      }, 3000);
    }
  });

  // ── Enable/disable toggle ──────────────────────────────────────────────
  function setCompanionEnabled(enabled) {
    companionEnabled = enabled;
    toggleBtn.className = 'icon-btn ' + (enabled ? 'toggle-on' : 'toggle-off');
    toggleBtn.title = enabled ? 'Pause companion' : 'Resume companion';
    toggleBtn.innerHTML = enabled ? '&#9208;' : '&#9654;';
    pausedOverlay.classList.toggle('hidden', enabled);
    // When paused, Zee returns to idle.
    if (!enabled) {
      faceFlags.isThinking = false;
      faceFlags.isListening = false;
      faceFlags.isSpeaking = false;
      refreshFace();
    }
  }

  toggleBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'toggle_companion', enabled: !companionEnabled });
  });

  resumeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'toggle_companion', enabled: true });
  });

  // The "Delve deeper" learn-more pill was removed — the same offer now
  // surfaces as a callout-flavored thought cloud (the existing `reading`
  // signal, fired by the context tracker after READING_ON_MARKDOWN_MS).

  // ── Transcript rendering ────────────────────────────────────────────────
  // Implementation lives in webview/transcript.js. onStreamStart is wired
  // to expose the stop button (the only external side effect).
  const transcriptView = /** @type {any} */ (globalThis).ZeeTranscript.createTranscript({
    transcriptEl: transcript,
    scrollContainer: transcriptPanel,
    renderMarkdown,
    onStreamStart: () => { stopBtn.classList.remove('hidden'); },
  });
  const appendEntry = transcriptView.appendEntry;
  const appendThinking = transcriptView.appendThinking;
  const removeThinking = transcriptView.removeThinking;
  const startStreamingEntry = transcriptView.startStreamingEntry;
  const appendStreamChunk = transcriptView.appendStreamChunk;
  const finishStreamingEntry = transcriptView.finishStreamingEntry;
  const markStopped = transcriptView.markStopped;
  const appendSessionDivider = transcriptView.appendSessionDivider;
  const scrollToBottom = transcriptView.scrollToBottom;

  // ── STT — dual-path recording ───────────────────────────────────────────
  //
  // Native VS Code sidebar: iframe Permissions Policy blocks getUserMedia,
  //   so the extension host spawns a native recorder (pw-record/parecord/
  //   arecord/sox/ffmpeg) and streams PCM into Moonshine. The webview just
  //   sends start/stop + receives mic_volume / stt_status updates.
  //
  // Docker / code-server in browser: the container has no audio hardware,
  //   so the host answers start_recording with a `mic_use_webview` message.
  //   The webview then captures audio via the browser's getUserMedia and
  //   forwards encoded PCM back as `voice_audio`. Implementation in
  //   webview/voiceCapture.js.
  //
  // One UI surface, two transports; the user sees the same thing either way.
  let sttTranscribing = false;
  let micActive = false;
  let micMode = 'host';      // 'host' | 'webview' — switched by host's signal
  let lastVolume = 0;
  let volumeAnimFrame = null;

  const voiceCapture = /** @type {any} */ (globalThis).ZeeVoiceCapture.createVoiceCapture({
    vscodeApi: vscode,
    setStatus: (state, text) => { setVoiceStatus(state, text); },
    onActivity: sendActivityPing,
    isVoiceMode: () => mode === 'voice',
    isTranscribing: () => sttTranscribing,
    setTranscribing: (b) => { sttTranscribing = b; },
  });

  function startSTT() {
    if (micActive) return;
    micActive = true;
    setVoiceStatus('', 'Listening...');
    vscode.postMessage({ type: 'start_recording' });
    // Host will reply with either `mic_started` (native) or `mic_use_webview`
    // (no recorder available). Webview capture only runs in the latter case.
  }

  function stopSTT() {
    if (!micActive) return;
    micActive = false;
    // Don't reset sttTranscribing — if a transcription is in flight on
    // the host, let it complete and show its result. The stt_status
    // handler will notice micMuted and switch the final UI to "Muted".
    lastVolume = 0;
    if (micMode === 'webview') {
      voiceCapture.stop();
    }
    micMode = 'host';   // reset so the next start tries host first again
    vscode.postMessage({ type: 'stop_recording' });
  }

  // When the host signals mic_use_webview, hand capture over to the browser.
  function activateWebviewCapture() {
    voiceCapture.start().then(() => {
      faceFlags.isListening = (mode === 'voice');
      refreshFace();
      startVolumeVis();
    }).catch(() => {
      micActive = false;
      micMode = 'host';
    });
  }


  // ── Voice status indicator ───────────────────────────────────────────────
  const voiceStatus = $('voiceStatus');
  function setVoiceStatus(state, text) {
    if (!voiceStatus) return;
    voiceStatus.textContent = text || '';
    voiceStatus.className = 'voice-status' + (state ? ' ' + state : '');
    voiceStatus.classList.toggle('hidden', !text);
  }

  // ── Volume visualiser ────────────────────────────────────────────────────
  // In host-capture mode, `lastVolume` is pushed via `mic_volume` messages.
  // In webview-capture mode, poll the local component each RAF tick.
  function startVolumeVis() {
    function draw() {
      if (mode !== 'voice' || !micActive) { volumeAnimFrame = null; return; }
      if (micMode === 'webview') {
        lastVolume = voiceCapture.getLocalVolume();
      }
      drawVolumeVis();
      volumeAnimFrame = requestAnimationFrame(draw);
    }
    draw();
  }

  function drawVolumeVis() {
    const canvas = voiceCanvas;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const barCount = 28;
    const barWidth = w / barCount - 2;
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue('--zee-accent').trim() || '#5FD3CB';

    // Time-varying idle shimmer so the viz is visibly alive even in silence —
    // tells the student "mic is hot, nothing detected yet" rather than looking
    // broken. The shimmer stays tiny (<= ~10% of canvas height) so actual
    // speech obviously dominates.
    const t = performance.now() / 1000;
    const shimmerBase = 0.06 + 0.04 * Math.sin(t * 2);

    // Pull the bars toward whichever is taller — either the shimmer baseline
    // or the actual amplitude. sqrt curve keeps quiet speech visible without
    // full-scale speech clipping.
    const drive = Math.sqrt(Math.min(1, lastVolume * 5));
    const amplitude = Math.max(shimmerBase, drive);

    ctx.fillStyle = accent;
    ctx.globalAlpha = drive > 0.08 ? 0.95 : 0.55;  // dim the idle shimmer

    for (let i = 0; i < barCount; i++) {
      // Per-bar offset so the wave has shape rather than a block of identical
      // bars. Higher at the center (natural "breath" feel) and lower at edges.
      const centerFalloff = 1 - Math.abs((i - (barCount - 1) / 2) / ((barCount - 1) / 2)) * 0.35;
      const wobble = 0.7 + 0.3 * Math.sin(t * 3 + i * 0.4);
      const val = Math.min(1, amplitude * wobble * centerFalloff);
      const barHeight = Math.max(2, val * h * 0.8);
      const x = i * (barWidth + 2);
      const y = (h - barHeight) / 2;
      ctx.fillRect(x, y, barWidth, barHeight);
    }
    ctx.globalAlpha = 1;
  }

  function stopVolumeVis() {
    if (volumeAnimFrame) { cancelAnimationFrame(volumeAnimFrame); volumeAnimFrame = null; }
    lastVolume = 0;
  }

  // ── TTS audio playback ───────────────────────────────────────────────
  // Implementation lives in webview/ttsPlayback.js (independently testable).
  const ttsPlayback = /** @type {any} */ (globalThis).ZeeTTSPlayback.createTTSPlayback({
    vscodeApi: () => vscode,
    getSpeechRate: () => parseFloat($('speechRateSlider')?.value || '1.0'),
  });
  function getAudioContext() { ttsPlayback.prime(); }
  function enqueueAudioChunk(base64) { ttsPlayback.enqueueChunk(base64); }
  function finalizeAudioSentence() { ttsPlayback.finalizeSentence(); }
  function cancelAllSpeech() { ttsPlayback.cancelAll(); }

  // ── Settings: provider selectors ────────────────────────────────────────
  function setupProviderSelector(groupId, radioName, onChange) {
    const group = $(groupId);
    if (!group) return;
    const options = group.querySelectorAll('.provider-option');
    options.forEach((opt) => {
      opt.addEventListener('click', () => {
        options.forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        const radio = opt.querySelector('input[type="radio"]');
        if (radio) radio.checked = true;
        if (onChange) onChange(radio?.value);
      });
    });
  }

  // LLM key field config per provider
  const LLM_KEY_CONFIG = {
    'groq': {
      label: 'Groq API key', placeholder: 'gsk_...', link: 'https://console.groq.com',
      linkText: 'Get a free key \u2192', target: 'groqApiKey', validateProvider: 'groq',
      modelLabel: 'Groq model', modelTarget: 'groqModel', defaultModel: 'llama-3.3-70b-versatile',
    },
    'gemini': {
      label: 'Google AI Studio key', placeholder: 'AIza...', link: 'https://aistudio.google.com',
      linkText: 'Get a free key \u2192', target: 'geminiApiKey', validateProvider: 'gemini',
      modelLabel: 'Gemini model', modelTarget: 'geminiModel', defaultModel: 'gemini-2.5-flash',
    },
    'openai': {
      label: 'OpenAI API key', placeholder: 'sk-...', link: 'https://platform.openai.com',
      linkText: 'Get a key \u2192', target: 'openaiApiKey', validateProvider: 'openai',
      modelLabel: 'OpenAI model', modelTarget: 'openaiModel', defaultModel: 'gpt-4o',
    },
    'anthropic': {
      label: 'Anthropic API key', placeholder: 'sk-ant-...', link: 'https://console.anthropic.com',
      linkText: 'Get a key \u2192', target: 'anthropicApiKey', validateProvider: 'anthropic',
      modelLabel: 'Anthropic model', modelTarget: 'anthropicModel', defaultModel: 'claude-sonnet-4-5',
    },
  };

  function updateKeyField(prefix, provider) {
    const config = LLM_KEY_CONFIG[provider];
    if (!config) return;
    $(prefix + 'KeyLabel').textContent = config.label;
    $(prefix + 'KeyInput').placeholder = config.placeholder;
    $(prefix + 'KeyInput').value = '';
    $(prefix + 'KeyStatus').textContent = '';
    $(prefix + 'KeyStatus').className = 'key-status';
    $(prefix + 'KeyLink').href = config.link;
    $(prefix + 'KeyLink').textContent = config.linkText;
  }

  function updateModelField(provider) {
    const config = LLM_KEY_CONFIG[provider];
    const label = $('setModelLabel');
    const input = $('setModelInput');
    const hint = $('setModelHint');
    if (!config || !label || !input || !hint) return;

    label.textContent = config.modelLabel;
    input.placeholder = config.defaultModel;
    const saved = lastSanitizedConfig?.[config.modelTarget] || config.defaultModel;
    input.value = saved && saved !== config.defaultModel ? saved : '';
    hint.textContent = `Leave blank to use ${config.defaultModel}.`;
  }

  function cacheVisibleModel(provider) {
    const config = LLM_KEY_CONFIG[provider];
    const input = $('setModelInput');
    if (!config || !input) return;

    const model = input.value.trim() || config.defaultModel;
    if (lastSanitizedConfig) {
      lastSanitizedConfig[config.modelTarget] = model;
    }
  }

  function collectModelSettings(activeProvider) {
    const models = {};
    for (const provider of Object.keys(LLM_KEY_CONFIG)) {
      const config = LLM_KEY_CONFIG[provider];
      models[config.modelTarget] = lastSanitizedConfig?.[config.modelTarget] || config.defaultModel;
    }
    const activeConfig = LLM_KEY_CONFIG[activeProvider];
    if (activeConfig) {
      models[activeConfig.modelTarget] = $('setModelInput')?.value.trim() || activeConfig.defaultModel;
    }
    return models;
  }

  // Onboarding provider selector
  setupProviderSelector('onboardingProviders', 'onb-llm', (val) => {
    updateKeyField('onb', val);
  });

  // Settings LLM provider selector
  let currentSetLLM = null; // tracks the active LLM so we can save its key before switching
  setupProviderSelector('settingsLLMProviders', 'set-llm', (val) => {
    // Save any key typed for the *previous* provider before clearing the field
    const prevKey = $('setKeyInput')?.value.trim();
    if (prevKey && currentSetLLM) {
      const prevConfig = LLM_KEY_CONFIG[currentSetLLM];
      if (prevConfig) {
        vscode.postMessage({
          type: 'save_settings',
          settings: { llmProvider: val },
          keyTarget: prevConfig.target,
          keyValue: prevKey,
        });
      }
    }
    if (currentSetLLM) {
      cacheVisibleModel(currentSetLLM);
    }
    currentSetLLM = val;
    updateKeyField('set', val);
    updateModelField(val);
    if (lastSanitizedConfig) {
      applyKeySavedIndicator('setKeyInput', 'setKeyStatus', lastSanitizedConfig, val);
    }
  });

  // Key toggle (show/hide)
  function setupKeyToggle(toggleId, inputId) {
    $(toggleId)?.addEventListener('click', () => {
      const inp = $(inputId);
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
  }
  setupKeyToggle('onbKeyToggle', 'onbKeyInput');
  setupKeyToggle('setKeyToggle', 'setKeyInput');

  // Key validation on blur
  function setupKeyValidation(inputId, statusId, providerFn) {
    $(inputId)?.addEventListener('blur', () => {
      const key = $(inputId).value.trim();
      if (!key) {
        $(statusId).textContent = '';
        $(statusId).className = 'key-status';
        return;
      }
      $(statusId).textContent = 'Checking...';
      $(statusId).className = 'key-status checking';
      const provider = providerFn();
      vscode.postMessage({ type: 'validate_key', provider, key });
    });
  }

  // Onboarding key validation
  setupKeyValidation('onbKeyInput', 'onbKeyStatus', () => {
    const selected = document.querySelector('input[name="onb-llm"]:checked')?.value;
    return LLM_KEY_CONFIG[selected]?.validateProvider || 'gemini';
  });

  // Settings key validation
  setupKeyValidation('setKeyInput', 'setKeyStatus', () => {
    const selected = document.querySelector('input[name="set-llm"]:checked')?.value;
    return LLM_KEY_CONFIG[selected]?.validateProvider || 'gemini';
  });

  // Speech rate slider
  $('speechRateSlider')?.addEventListener('input', () => {
    $('speechRateValue').textContent = parseFloat($('speechRateSlider').value).toFixed(2) + 'x';
  });

  // Test voice button — save settings first so keys and TTS provider are up to date
  $('testVoiceBtn')?.addEventListener('click', () => {
    saveCurrentSettings();
    cancelAllSpeech();
    vscode.postMessage({ type: 'test_voice', text: 'Welcome to the Deep RL course. Let\'s learn together.' });
  });

  // Reset Zee — wipes all settings, API keys, and every notebook's chat
  // history, then sends the user back to onboarding. Two-click confirm
  // (mirrors the header trash + ↶ undo pattern) to make the destructive
  // intent explicit.
  let resetZeeTimeout = null;
  $('resetZeeBtn')?.addEventListener('click', () => {
    const btn = $('resetZeeBtn');
    if (btn.dataset.confirming === 'true') {
      btn.dataset.confirming = 'false';
      btn.textContent = 'Reset Zee';
      clearTimeout(resetZeeTimeout);
      vscode.postMessage({ type: 'reset_zee' });
    } else {
      btn.dataset.confirming = 'true';
      btn.textContent = 'Are you sure?';
      resetZeeTimeout = setTimeout(() => {
        btn.dataset.confirming = 'false';
        btn.textContent = 'Reset Zee';
      }, 3000);
    }
  });

  // Onboarding start button
  $('onbStartBtn')?.addEventListener('click', () => {
    const selected = document.querySelector('input[name="onb-llm"]:checked')?.value || 'gemini';
    const keyConfig = LLM_KEY_CONFIG[selected];
    const key = $('onbKeyInput').value.trim();
    const skillLevel = document.querySelector('input[name="onb-skill"]:checked')?.value || 'unknown';
    const goal = ($('onbGoal')?.value || '').trim();
    vscode.postMessage({
      type: 'complete_onboarding',
      settings: { llmProvider: selected },
      keyTarget: keyConfig?.target,
      keyValue: key,
      skillLevel,
      goal,
    });
  });

  function saveCurrentSettings() {
    const llmProvider = document.querySelector('input[name="set-llm"]:checked')?.value || 'gemini';
    const settings = {
      llmProvider,
      ...collectModelSettings(llmProvider),
      speechRate: parseFloat($('speechRateSlider')?.value || '1.0'),
      voiceResponsesEnabled: $('voiceResponsesToggle')?.checked ?? true,
      micSensitivity: $('micSensitivitySelect')?.value || 'normal',
      defaultInteractionMode: $('defaultModeSelect')?.value || 'chat',
    };

    // Save non-secret settings
    vscode.postMessage({ type: 'save_settings', settings });

    // Save LLM key if changed
    const llmKey = $('setKeyInput')?.value.trim();
    if (llmKey) {
      const keyConfig = LLM_KEY_CONFIG[llmProvider];
      if (keyConfig) {
        vscode.postMessage({ type: 'save_settings', keyTarget: keyConfig.target, keyValue: llmKey });
      }
    }

  }

  // ── Message handler from extension host ─────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'show_onboarding':
        showPanel('onboarding');
        applyConfig(msg.config);
        break;

      case 'init':
        showPanel('transcript');
        applyConfig(msg.config);
        setMode(msg.mode || 'chat');
        modeToggle.classList.remove('hidden');
        vscode.postMessage({ type: 'webview_ready' });
        break;

      case 'onboarding_complete':
        showPanel('transcript');
        applyConfig(msg.config);
        setMode(msg.mode || 'chat');
        modeToggle.classList.remove('hidden');
        vscode.postMessage({ type: 'webview_ready' });
        break;

      case 'context_update':
        if (msg.notebook) {
          const wasOpen = notebookOpen;
          notebookOpen = true;
          noNotebookState?.classList.add('hidden');
          // Render the pill from a structured segment list — bold "Cell"
          // and "TODO:" / "Reading" / "Coding" / "Debugging" labels next
          // to plain text. Pulse the eye for ~200ms whenever the cursor
          // line changes so the pill feels alive on every keystroke.
          renderAwarenessPill(msg);
          modeToggle.classList.remove('hidden');
          inputBar.classList.remove('hidden');
          // No transcript clear here. The host explicitly drives transcript
          // content via `transcript_loaded` (restore prior turns) or
          // `transcript_cleared` (start fresh). Clearing in this handler
          // raced with a freshly-loaded transcript: on cold start the
          // host posted transcript_loaded BEFORE context_update, and a
          // !wasOpen-conditioned clear here wiped the rendered turns —
          // user saw an empty chat after restart.
          // If we just transitioned from no-notebook → notebook while in voice mode, restart STT
          if (!wasOpen && mode === 'voice' && !micMuted && !aiIsSpeaking) {
            startSTT();
          }
          // Track the latest attachable plot so the attach button shows up
          // when one is available. Detaches any pending attachment whose
          // cell is no longer attachable.
          handleAttachableUpdate(msg.attachablePlot);
        } else {
          // Notebook closed — drop into meta-mode. Both chat and voice stay
          // available (voice meta-chat uses the same LLM path as text).
          // Only the in-notebook focus signals go quiet.
          notebookOpen = false;
          // Pill text comes from the same META_MODE_COPY constant that
          // powers the empty-state card and the meta-mode system prompt —
          // single source so they don't drift.
          contextPill.textContent = window.__DRL_CONSTANTS__?.META_MODE_PILL
            ?? 'No notebook open — ask me anything about the course.';
          modeToggle.classList.remove('hidden');
          transcript.innerHTML = '';
          noNotebookState?.classList.remove('hidden');
          inputBar.classList.remove('hidden');
          // Cut off any mid-sentence notebook-specific speech + drop in-flight
          // audio so we don't transcribe stale context. Voice mode itself stays on.
          cancelAllSpeech();
          vscode.postMessage({ type: 'stop_speaking' });
          if (mode === 'voice') { stopSTT(); startSTT(); }
          handleAttachableUpdate(undefined);
        }

        // Track current cell index (still used elsewhere for awareness UI).
        if (msg.cell !== undefined) { currentCellIndex = msg.cell; }
        break;

      case 'ai_chunk':
        if (!transcriptView.isStreaming() && !msg.done) {
          removeThinking();
          startStreamingEntry();
        }
        if (msg.text) {
          appendStreamChunk(msg.text);
        }
        faceFlags.isThinking = true;
        refreshFace();
        break;

      case 'ai_response_complete':
        removeThinking();
        if (transcriptView.isStreaming()) {
          finishStreamingEntry(msg.richText, msg.text);
        } else if (msg.text) {
          // Voice mode or error recovery: no streaming, show complete response
          appendEntry('companion', 'chat', msg.text, msg.richText);
        } else {
          // Error case: close any dangling streaming entry
          finishStreamingEntry();
        }
        faceFlags.isThinking = false;
        refreshFace();
        refreshUndoVisibility();
        break;

      case 'ai_stopped':
        markStopped();
        faceFlags.isThinking = false;
        faceFlags.isSpeaking = false;
        refreshFace();
        break;

      case 'mark_last_turn_errored':
        transcriptView.markLastTurnErrored();
        refreshUndoVisibility();
        break;

      case 'status':
        if (msg.state === 'thinking') {
          appendThinking();
          faceFlags.isThinking = true;
        }
        if (msg.state === 'preparing') {
          contextPill.textContent = 'Getting ready\u2026';
          contextPill.classList.add('preparing');
          faceFlags.isThinking = true;
        } else {
          contextPill.classList.remove('preparing');
        }

        // Track AI speaking state + pause the mic while TTS is playing.
        // Without this pause, the mic captures Zee's own voice, VAD triggers
        // on it, and the transcribed echo gets fed back into handleUserMessage
        // which cancels Zee's streaming + TTS and restarts — an infinite
        // feedback loop. Pausing the mic for the duration of TTS playback
        // is the simplest fix (and what most real voice assistants do).
        if (msg.state === 'speaking') {
          aiIsSpeaking = true;
          faceFlags.isSpeaking = true;
          faceFlags.isThinking = false;
          if (mode === 'voice' && !micMuted && micActive) { stopSTT(); }
        } else if (msg.state === 'idle') {
          const wasSpeaking = aiIsSpeaking;
          aiIsSpeaking = false;
          faceFlags.isSpeaking = false;
          faceFlags.isThinking = false;
          // Only restart the mic if we paused it for TTS and the user is
          // still in voice mode (i.e. they didn't switch to chat meanwhile).
          if (wasSpeaking && mode === 'voice' && !micMuted && !micActive) {
            startSTT();
          }
        }
        refreshFace();
        refreshSendNowVisibility();

        // Control stop button visibility based on mode
        if (msg.state === 'idle') {
          stopBtn.classList.add('hidden');
          $('voiceStopBtn')?.classList.add('hidden');
        } else {
          if (mode === 'voice') {
            $('voiceStopBtn')?.classList.remove('hidden');
            stopBtn.classList.add('hidden');
          } else {
            stopBtn.classList.remove('hidden');
            $('voiceStopBtn')?.classList.add('hidden');
          }
        }

        // Voice mode: pause mic while AI is speaking, resume when idle.
        // Gating rules live in webview/voiceStatusReducer.js so they're
        // unit-testable (regression guard for the bug where referencing an
        // undefined `isPlayingAudio` threw ReferenceError and silently
        // killed mic restart on turn 2+).
        if (mode === 'voice') {
          const action = /** @type {any} */ (globalThis).ZeeVoiceStatusReducer
            .decideVoiceStatusAction({
              state: msg.state,
              micMuted,
              ttsActive: ttsPlayback.isActive(),
            });
          if (action === 'speaking') {
            stopSTT();
            stopVolumeVis();
            voiceCanvas.classList.add('hidden');
            $('micIndicator').classList.add('hidden');
            setVoiceStatus('', 'AI is speaking\u2026');
          } else if (action === 'idle_start_mic') {
            voiceCanvas.classList.remove('hidden');
            $('micIndicator').classList.remove('hidden');
            setVoiceStatus('', '');
            startSTT();
          } else if (action === 'idle_muted') {
            setVoiceStatus('', 'Muted');
          }
          // 'idle_wait_tts' and 'none' \u2192 no-op; when TTS finishes draining
          // locally, the host re-sends status=idle and we retry above.
        }
        break;

      case 'token_usage': {
        const el = $('tokenCounter');
        if (!el) { break; }
        const { text, level } = /** @type {any} */ (globalThis).ZeeTokenCounter
          .formatTokenCounter(msg.context || 0, msg.sessionTotal || 0);
        el.textContent = text;
        el.classList.toggle('warn',  level === 'warn');
        el.classList.toggle('alert', level === 'alert');
        el.classList.toggle('hidden', (msg.context || 0) === 0 && (msg.sessionTotal || 0) === 0);
        break;
      }

      case 'tts_chunk':
        if (mode === 'voice' && msg.audio) {
          enqueueAudioChunk(msg.audio);
        }
        break;

      case 'tts_sentence_done':
        finalizeAudioSentence();
        break;

      case 'thought_cloud':
        // Surface a hedged "thought" or attentive "callout" near Zee.
        // Click escalates to a user message via thought_followup.
        if (msg.text && thoughtCloud) {
          thoughtCloud.show({
            text: msg.text,
            expandHint: msg.expandHint || msg.text,
            ttlMs: typeof msg.ttlMs === 'number' ? msg.ttlMs : 25_000,
            trigger: msg.trigger,
            kind: msg.kind === 'callout' ? 'callout' : 'thought',
          });
        }
        break;

      case 'echo_user_message':
        // Host echoes a synthetic user message it's about to dispatch (e.g.
        // a thought-cloud follow-up). We render it locally so the chat
        // shows what was sent without waiting for transcript_loaded.
        if (msg.text) {
          appendEntry('user', mode === 'voice' ? 'voice' : 'chat', msg.text);
          refreshUndoVisibility();
        }
        break;

      case 'transcript_loaded':
        // Render all loaded entries — session is active. If entries exist,
        // we're definitely in a notebook session, so hide the no-notebook
        // welcome card. (context_update also hides it, but that may arrive
        // after this message and we don't want the card to sit above the
        // restored conversation.)
        inputBar.classList.remove('hidden');
        if (msg.entries) {
          noNotebookState?.classList.add('hidden');
          transcript.innerHTML = '';
          msg.entries.forEach((entry) => {
            appendEntry(entry.role, entry.inputMode, entry.text, entry.richText);
          });
        }
        refreshUndoVisibility();
        break;

      case 'session_divider':
        appendSessionDivider(msg.timestamp);
        break;

      case 'session_started':
        // Host auto-started a fresh session — ensure input is ready.
        inputBar.classList.remove('hidden');
        break;

      case 'transcript_cleared':
        // Session was cleared — host will auto-restart if notebook is open.
        // If no notebook, surface the meta-mode welcome card again.
        transcript.innerHTML = '';
        if (!notebookOpen) { noNotebookState?.classList.remove('hidden'); }
        refreshUndoVisibility();
        break;

      case 'turn_undone':
        // Host rolled back the trailing (user, Zee) pair from both its
        // context window and (if a notebook is open) on-disk transcript.
        // Keep the webview in sync by peeling the two bubbles from the DOM.
        transcriptView.removeLastPair();
        refreshUndoVisibility();
        break;

      case 'welcome_message':
        appendEntry('companion', 'initiative', msg.text);
        break;

      case 'flow_state':
        // Host emits 'active' | 'soft-idle-presence' | 'soft-idle-nudge'.
        // Drowsy face applies only for the presence level; active returns
        // to idle (derived from the other flags). The nudge level is now
        // accompanied by a thought_cloud (handled separately above).
        faceFlags.isDrowsy = (msg.state === 'soft-idle-presence' || msg.state === 'soft-idle-nudge');
        refreshFace();
        break;

      case 'key_validation_result':
        // Update the appropriate status field
        updateValidationStatus(msg.provider, msg.valid);
        break;

      case 'settings_saved':
        applyConfig(msg.config);
        break;

      case 'show_settings':
        showPanel('settings');
        break;

      case 'stt_result':
        sttTranscribing = false;
        // If the user muted while transcription was in flight, switch the
        // status from "Transcribing…" to "Muted" now that we're done.
        // Otherwise show the normal listening hint.
        setVoiceStatus('', micMuted ? 'Muted' : 'Listening...');
        if (msg.text) {
          appendEntry('user', 'voice', msg.text);
          refreshUndoVisibility();
        }
        refreshSendNowVisibility();
        break;

      case 'stt_status':
        if (msg.state === 'idle') {
          sttTranscribing = false;
          setVoiceStatus('', micMuted ? 'Muted' : 'Listening...');
          faceFlags.isListening = (mode === 'voice' && !micMuted);
        } else if (msg.state === 'listening') {
          sttTranscribing = false;
          setVoiceStatus('', micMuted ? 'Muted' : 'Listening...');
          faceFlags.isListening = !micMuted;
        } else if (msg.state === 'recording') {
          setVoiceStatus('recording', 'Recording...');
          faceFlags.isListening = true;
        } else if (msg.state === 'transcribing') {
          sttTranscribing = true;
          setVoiceStatus('transcribing', 'Transcribing...');
          faceFlags.isListening = false;
          faceFlags.isThinking = true;
        } else if (msg.state === 'error') {
          sttTranscribing = false;
          const errMsg = msg.message || 'Transcription failed';
          setVoiceStatus('error', errMsg);
          faceFlags.isListening = false;
          faceFlags.isThinking = false;
          // Show persistent error for setup issues, auto-clear for transient errors
          if (!msg.message) {
            setTimeout(() => {
              if (mode === 'voice') {
                setVoiceStatus('', micMuted ? 'Muted' : 'Listening...');
              }
            }, 3000);
          }
        }
        refreshFace();
        refreshSendNowVisibility();
        break;

      case 'mic_started':
        // Host-capture path confirmed
        micMode = 'host';
        micActive = true;
        faceFlags.isListening = (mode === 'voice');
        refreshFace();
        startVolumeVis();
        refreshSendNowVisibility();
        break;

      case 'mic_use_webview':
        // Host has no native recorder (Docker / code-server). Capture locally.
        micMode = 'webview';
        micActive = true;
        activateWebviewCapture();
        refreshSendNowVisibility();
        break;

      case 'mic_stopped':
        micActive = false;
        lastVolume = 0;
        faceFlags.isListening = false;
        refreshFace();
        refreshSendNowVisibility();
        break;

      case 'mic_volume':
        // Host sends RMS in [0, 1]. Scale to the same range the old analyser
        // feed used so the visualizer curves behave the same way.
        lastVolume = Math.max(0, Math.min(1, msg.volume ?? 0));
        if (lastVolume > 0.02) { sendActivityPing(); }
        break;

      case 'companion_state':
        setCompanionEnabled(msg.enabled);
        break;
    }
  });

  function updateValidationStatus(provider, valid) {
    // Check which panel is visible and update the right status
    const panels = [
      { status: 'onbKeyStatus', input: 'onbKeyInput', btn: 'onbStartBtn' },
      { status: 'setKeyStatus', input: 'setKeyInput', btn: null },
    ];

    for (const p of panels) {
      const statusEl = $(p.status);
      if (!statusEl) continue;
      if (statusEl.classList.contains('checking')) {
        statusEl.textContent = valid ? '\u2714 Valid' : '\u2716 Invalid key';
        statusEl.className = `key-status ${valid ? 'valid' : 'invalid'}`;
        if (p.btn) {
          $(p.btn).disabled = !valid;
        }
        break;
      }
    }
  }

  function applyConfig(config) {
    if (!config) return;
    lastSanitizedConfig = config;

    // LLM provider radio
    const llmRadio = document.querySelector(`input[name="set-llm"][value="${config.llmProvider}"]`);
    if (llmRadio) {
      llmRadio.checked = true;
      document
        .querySelectorAll('#settingsLLMProviders .provider-option')
        .forEach((opt) => opt.classList.toggle('selected', opt === llmRadio.closest('.provider-option')));
      currentSetLLM = config.llmProvider;
      updateKeyField('set', config.llmProvider);
      updateModelField(config.llmProvider);
    }

    // Other settings
    if ($('speechRateSlider')) {
      $('speechRateSlider').value = config.speechRate || 1.0;
      $('speechRateValue').textContent = (config.speechRate || 1.0).toFixed(2) + 'x';
    }
    if ($('voiceResponsesToggle')) $('voiceResponsesToggle').checked = config.voiceResponsesEnabled !== false;
    if ($('micSensitivitySelect')) $('micSensitivitySelect').value = config.micSensitivity || 'normal';
    if ($('defaultModeSelect')) $('defaultModeSelect').value = config.defaultInteractionMode || 'chat';

    // Show "key saved" indicators for configured keys
    applyKeySavedIndicator('setKeyInput', 'setKeyStatus', config, config.llmProvider);


    // Companion enabled state
    if (config.companionEnabled !== undefined) {
      setCompanionEnabled(config.companionEnabled);
    }

    // Update readiness warnings
    updateReadinessUI(computeReadiness(config));
  }

  /** Show a "saved" indicator on key inputs when a key is stored but the textbox is empty */
  function applyKeySavedIndicator(inputId, statusId, config, provider) {
    const input = $(inputId);
    const status = $(statusId);
    if (!input || !status) return;
    // Only show indicator if textbox is empty (we never send actual keys to webview)
    if (input.value.trim()) return;

    const keyMap = {
      'groq': 'hasGroqKey',
      'gemini': 'hasGeminiKey',
      'openai': 'hasOpenaiKey',
      'anthropic': 'hasAnthropicKey',
    };
    const flag = keyMap[provider];
    if (flag && config[flag]) {
      input.placeholder = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (saved)';
      status.textContent = '\u2714 Key saved';
      status.className = 'key-status valid';
    }
  }

  // Tell the extension host we're ready to receive messages
  vscode.postMessage({ type: 'webview_loaded' });
})();
