// Minv's public editor surface is deliberately restricted to text, diff and syntax APIs.
// All implementation imports are compiled directly from the pinned Code-OSS source.
import {
  create, createDiffEditor, createModel, getModel, getModels, getEditors, getDiffEditors,
  setModelLanguage, defineTheme, setTheme, remeasureFonts, tokenize,
} from '@codeoss/editor/standalone/browser/standaloneEditor.js';
import {
  register, getLanguages, setLanguageConfiguration, setTokensProvider, setMonarchTokensProvider,
  registerTokensProviderFactory, onLanguage,
} from '@codeoss/editor/standalone/browser/standaloneLanguages.js';
export { URI as Uri } from '@codeoss/base/common/uri.js';
export { Range } from '@codeoss/editor/common/core/range.js';
export { Selection } from '@codeoss/editor/common/core/selection.js';
export { Position } from '@codeoss/editor/common/core/position.js';
export { KeyCode, KeyMod } from '@codeoss/base/common/keyCodes.js';
import { EditorOptions, WrappingIndent, EditorAutoIndentStrategy } from '@codeoss/editor/common/config/editorOptions.js';
import '@codeoss/base/browser/ui/codicons/codiconStyles.js';
import { initializeLanguages } from './languages';
export { initializeLanguages };

EditorOptions.wrappingIndent.defaultValue = WrappingIndent.None;
EditorOptions.glyphMargin.defaultValue = false;
EditorOptions.autoIndent.defaultValue = EditorAutoIndentStrategy.Advanced;
EditorOptions.overviewRulerLanes.defaultValue = 2;

// Only this local worker is reachable. No arbitrary worker/module URL is exposed.
(globalThis as any).MonacoEnvironment = {
  getWorker(_module: string, label: string) {
    if (label !== 'editorWorkerService' && label !== 'editor') throw new Error(`Unbundled worker: ${label}`);
    return new Worker(new URL('./editor.worker.js', import.meta.url), { type: 'module', name: 'minv-editor' });
  },
};

export const editor = Object.freeze({
  create, createDiffEditor, createModel, getModel, getModels, getEditors, getDiffEditors,
  setModelLanguage, defineTheme, setTheme, remeasureFonts, tokenize,
});
export const languages = Object.freeze({
  register, getLanguages, setLanguageConfiguration, setTokensProvider, setMonarchTokensProvider,
  registerTokensProviderFactory, onLanguage,
});
