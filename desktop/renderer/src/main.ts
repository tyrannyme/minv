/** Desktop entry. Requires the preload host; never references the preview fixture. */
import { start } from './boot.js';
import { createCodeOssAdapter } from './editor/codeoss.js';
import type { EditorAdapter } from './contract.js';

async function editor(): Promise<EditorAdapter | undefined> {
  if (window.minvEditor) return window.minvEditor;
  try {
    const url = new URL('../../editor/generated/editor.js', import.meta.url).href;
    return createCodeOssAdapter(await import(url));
  } catch (error) { console.error('Minv: Code-OSS editor unavailable', error); return undefined; }
}

const host = window.minvHost;
if (!host) {
  document.body.textContent = 'Minv could not connect to its desktop host. Restart the application.';
} else {
  void editor().then(adapter => start(host, adapter));
}
