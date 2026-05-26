import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { STT_CONFIDENCE_THRESHOLD, LEARN_MORE_DELAY_MS, META_MODE_COPY } from './constants';

/** Minimal HTML escaping for substitutions that flow into static markup.
 *  No ampersands, angle brackets, or quotes get through unencoded. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Load the webview HTML file and resolve placeholders for CSS/JS URIs and
 * runtime constants that the webview needs. VS Code requires all static
 * resources to be resolved through webview.asWebviewUri() so they pass the
 * CSP / localResourceRoots check.
 */
export function buildWebviewHtml(
  extensionPath: string,
  webview: vscode.Webview,
): string {
  const htmlPath = path.join(extensionPath, 'src', 'webview', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');

  const asset = (filename: string) =>
    webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'src', 'webview', filename))).toString();

  html = html.replace('{{cssUri}}', asset('style.css'));
  html = html.replace('{{jsUri}}', asset('chat.js'));
  html = html.replace('{{faceUri}}', asset('face.js'));
  html = html.replace('{{markdownUri}}', asset('markdown.js'));
  html = html.replace('{{ttsPlaybackUri}}', asset('ttsPlayback.js'));
  html = html.replace('{{transcriptUri}}', asset('transcript.js'));
  html = html.replace('{{voiceCaptureUri}}', asset('voiceCapture.js'));
  html = html.replace('{{voiceStatusReducerUri}}', asset('voiceStatusReducer.js'));
  html = html.replace('{{tokenCounterUri}}', asset('tokenCounter.js'));
  html = html.replace('{{awarenessPillUri}}', asset('awarenessPill.js'));
  html = html.replace('{{thoughtCloudUri}}', asset('thoughtCloud.js'));
  html = html.replace('{{inputKeyUri}}', asset('inputKey.js'));
  html = html.replace('{{STT_CONFIDENCE_THRESHOLD}}', String(STT_CONFIDENCE_THRESHOLD));
  html = html.replace('{{LEARN_MORE_DELAY_MS}}', String(LEARN_MORE_DELAY_MS));
  // Meta-mode copy: same constant powers the empty-state card AND the
  // runtime-injected pill that chat.js reads — keeps wording in lock-step.
  html = html.replace('{{META_MODE_DESCRIPTION_HTML}}', escapeHtml(META_MODE_COPY.description));
  html = html.replace('{{META_MODE_PILL_JSON}}', JSON.stringify(META_MODE_COPY.pill));

  return html;
}
