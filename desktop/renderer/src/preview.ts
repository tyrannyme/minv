/** Standalone preview entry: the real renderer over the bundled fixture host. Not shipped. */
import { start } from './boot.js';
import { createCodeOssAdapter } from './editor/codeoss.js';
import { createFixtureHost } from './mock/host.js';
import type { EditorAdapter } from './contract.js';

async function editor(): Promise<EditorAdapter | undefined> {
  if (window.minvEditor) return window.minvEditor;
  try { return createCodeOssAdapter(await import(new URL('../../editor/generated/editor.js', import.meta.url).href)); }
  catch (error) { console.warn('Preview: Code-OSS editor build not found; editing is unavailable.', error); return undefined; }
}

void editor().then(adapter => start(window.minvHost ?? createFixtureHost(), adapter));
