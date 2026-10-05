/**
 * EditorAdapter over the source-built Code-OSS editor (desktop/editor/generated).
 * Installed by the trusted renderer bootstrap; nothing here reaches the host.
 */
import type { CursorPosition, EditorAdapter, EditorDocument, EditorHandle, EditorOptions, EditorTheme, SavedEditorView } from '../contract.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type EditorModule = { editor: any; languages: any; Uri: any; initializeLanguages(): Promise<void> };

export function createCodeOssAdapter(module: EditorModule): EditorAdapter {
  const { editor: monaco, languages, Uri } = module;
  let languagesReady: Promise<void> | undefined;
  let options: EditorOptions = { fontSize: 13, tabSize: 2, wordWrap: false, renderWhitespace: false };
  let fontFamily = "'Commit Mono', monospace";
  let lineHeight = 20;
  const editors = new Set<any>();

  const languageFor = (uri: string, fallback: string): string => {
    const name = uri.slice(uri.lastIndexOf('/') + 1).toLowerCase();
    for (const language of languages.getLanguages() as { id: string; extensions?: string[]; filenames?: string[] }[]) {
      if (language.filenames?.some(f => f.toLowerCase() === name)) return language.id;
      if (language.extensions?.some(e => name.endsWith(e.toLowerCase()))) return language.id;
    }
    return fallback;
  };

  const base = (large?: boolean) => ({
    automaticLayout: false, minimap: { enabled: false }, glyphMargin: false, lineNumbersMinChars: 4, lineDecorationsWidth: 12,
    renderLineHighlight: 'line', scrollBeyondLastLine: false, overviewRulerBorder: false, overviewRulerLanes: 2, hideCursorInOverviewRuler: true,
    fontLigatures: false, stickyScroll: { enabled: false }, padding: { top: 18, bottom: 18 }, fontFamily, lineHeight,
    fontSize: options.fontSize, tabSize: options.tabSize, wordWrap: options.wordWrap ? 'on' : 'off', renderWhitespace: options.renderWhitespace ? 'all' : 'selection',
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false }, cursorBlinking: 'phase', cursorSmoothCaretAnimation: 'off',
    smoothScrolling: false, folding: !large, guides: { indentation: true, highlightActiveIndentation: false }, bracketPairColorization: { enabled: false },
    quickSuggestions: false, suggestOnTriggerCharacters: false, wordBasedSuggestions: 'off', parameterHints: { enabled: false }, hover: { enabled: false }, links: false,
    contextmenu: true, useShadowDOM: false, find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection' }, largeFileOptimizations: true, unicodeHighlight: { ambiguousCharacters: true, invisibleCharacters: true },
  });

  let ready = false;
  const ensureLanguages = () => (languagesReady ??= module.initializeLanguages().then(() => { ready = true; }, error => console.warn('Minv: syntax grammars unavailable', error)));
  // Start loading grammars immediately; models created earlier switch language once they are ready.
  void ensureLanguages();

  const model = (doc: EditorDocument) => {
    const uri = Uri.parse(doc.uri);
    monaco.getModel(uri)?.dispose();
    const created = monaco.createModel(doc.text, ready ? languageFor(doc.uri, doc.languageId) : 'plaintext', uri);
    if (!ready) void ensureLanguages().then(() => { if (!created.isDisposed()) monaco.setModelLanguage(created, languageFor(doc.uri, doc.languageId)); });
    return created;
  };

  return {
    name: 'Code-OSS',
    create(container, doc): EditorHandle {
      const instance = monaco.create(container, { ...base(doc.large), model: model(doc), readOnly: doc.readOnly, ariaLabel: doc.uri.slice(doc.uri.lastIndexOf('/') + 1) });
      editors.add(instance);
      return {
        getText: () => instance.getModel()?.getValue() ?? '',
        setText: (text: string) => {
          const view = instance.saveViewState();
          instance.getModel()?.setValue(text);
          if (view) instance.restoreViewState(view);
        },
        setReadOnly: (readOnly: boolean) => instance.updateOptions({ readOnly }),
        revealLine: (line: number, column = 1) => { instance.setPosition({ lineNumber: line, column }); instance.revealLineInCenter(line); },
        focus: () => instance.focus(),
        layout: () => instance.layout(),
        onDidChangeContent: (listener: () => void) => { const d = instance.onDidChangeModelContent(listener); return () => d.dispose(); },
        onDidChangeCursor: (listener: (p: CursorPosition) => void) => {
          const d = instance.onDidChangeCursorSelection((e: any) => listener({ line: e.selection.positionLineNumber, column: e.selection.positionColumn, selections: 1 + (e.secondarySelections?.length ?? 0) }));
          return () => d.dispose();
        },
        run: (action) => {
          const ids = { find: 'actions.find', replace: 'editor.action.startFindReplaceAction', undo: 'undo', redo: 'redo' } as const;
          instance.focus();
          if (action === 'undo' || action === 'redo') instance.trigger('minv', action, null);
          else instance.getAction(ids[action])?.run();
        },
        getView: (): SavedEditorView => {
          const p = instance.getPosition();
          return { line: p?.lineNumber ?? 1, column: p?.column ?? 1, scrollTop: Math.round(instance.getScrollTop()), scrollLeft: Math.round(instance.getScrollLeft()) };
        },
        setView: (v: SavedEditorView) => {
          instance.setPosition({ lineNumber: Math.max(1, v.line), column: Math.max(1, v.column) });
          instance.setScrollPosition({ scrollTop: v.scrollTop, scrollLeft: v.scrollLeft });
        },
        dispose: () => { editors.delete(instance); const m = instance.getModel(); instance.dispose(); m?.dispose(); },
      };
    },
    createComparison(container, original, modified, inline) {
      const diff = monaco.createDiffEditor(container, { ...base(), readOnly: true, originalEditable: false, renderSideBySide: !inline, renderOverviewRuler: false, ignoreTrimWhitespace: false });
      diff.setModel({ original: model(original), modified: model(modified) });
      return { layout: () => diff.layout(), dispose: () => { const m = diff.getModel(); diff.dispose(); m?.original.dispose(); m?.modified.dispose(); } };
    },
    setTheme(theme: EditorTheme) {
      fontFamily = theme.fontFamily; lineHeight = theme.lineHeight;
      const baseTheme = theme.highContrast ? (theme.base === 'dark' ? 'hc-black' : 'hc-light') : theme.base === 'dark' ? 'vs-dark' : 'vs';
      monaco.defineTheme('minv', { base: baseTheme, inherit: true, rules: theme.tokens, colors: theme.colors });
      monaco.setTheme('minv');
      for (const e of editors) e.updateOptions({ fontFamily, lineHeight });
      void document.fonts.ready.then(() => monaco.remeasureFonts());
    },
    setOptions(next: EditorOptions) {
      options = next;
      for (const e of editors) e.updateOptions({ fontSize: next.fontSize, tabSize: next.tabSize, wordWrap: next.wordWrap ? 'on' : 'off', renderWhitespace: next.renderWhitespace ? 'all' : 'selection' });
    },
  };
}

/** Builds the editor theme from the live CSS tokens so the editor and the shell never drift. */
export function themeFromTokens(style: CSSStyleDeclaration, highContrast: boolean): EditorTheme {
  const v = (name: string) => style.getPropertyValue(`--${name}`).trim();
  const hex = (name: string) => v(name);
  const dark = v('color-scheme-base') === 'dark';
  const strip = (c: string) => c.replace('#', '');
  return {
    base: dark ? 'dark' : 'light',
    highContrast,
    fontFamily: v('font-code'),
    lineHeight: 20,
    colors: {
      'editor.background': hex('surface'),
      'editor.foreground': hex('fg'),
      'editorLineNumber.foreground': hex('fg3') + (highContrast ? '' : '99'),
      'editorLineNumber.activeForeground': hex('fg2'),
      'editor.lineHighlightBackground': hex('raised'),
      'editor.lineHighlightBorder': highContrast ? hex('border') : '#00000000',
      'editor.selectionBackground': hex('selection'),
      'editor.inactiveSelectionBackground': hex('selection') + '99',
      'editorCursor.foreground': hex('accent-text'),
      'editorIndentGuide.background1': hex('line'),
      'editorIndentGuide.activeBackground1': hex('border'),
      'editorWhitespace.foreground': hex('border'),
      'editorWidget.background': hex('surface'),
      'editorWidget.border': hex('border'),
      'editorWidget.foreground': hex('fg'),
      'input.background': hex('sunken'),
      'input.border': hex('border'),
      'input.foreground': hex('fg'),
      'focusBorder': hex('focus'),
      'editor.findMatchBackground': hex('selection'),
      'editor.findMatchHighlightBackground': hex('selection') + '88',
      'scrollbarSlider.background': hex('border') + '88',
      'scrollbarSlider.hoverBackground': hex('border'),
      'scrollbarSlider.activeBackground': hex('fg3'),
      'editorGutter.background': hex('surface'),
      'diffEditor.insertedLineBackground': hex('added-wash'),
      'diffEditor.removedLineBackground': hex('deleted-wash'),
      'diffEditor.insertedTextBackground': hex('added') + '33',
      'diffEditor.removedTextBackground': hex('deleted') + '33',
      'editorBracketMatch.background': hex('selection'),
      'editorBracketMatch.border': '#00000000',
      'widget.shadow': '#00000000',
      'widget.border': hex('border'),
      'inputOption.activeBackground': hex('accent'),
      'inputOption.activeForeground': hex('on-accent'),
      'inputOption.activeBorder': '#00000000',
      'toolbar.hoverBackground': hex('hover'),
      'editor.findRangeHighlightBackground': hex('selection') + '55',
      'menu.background': hex('surface'),
      'menu.foreground': hex('fg'),
      'menu.border': hex('border'),
      'menu.selectionBackground': hex('hover'),
      'menu.selectionForeground': hex('fg'),
      'menu.separatorBackground': hex('line'),
    },
    tokens: [
      { token: '', foreground: strip(hex('fg')) },
      { token: 'comment', foreground: strip(v('syntax-comment')), fontStyle: 'italic' },
      { token: 'keyword', foreground: strip(v('syntax-keyword')) },
      { token: 'storage', foreground: strip(v('syntax-keyword')) },
      { token: 'string', foreground: strip(v('syntax-string')) },
      { token: 'constant.numeric', foreground: strip(v('syntax-number')) },
      { token: 'constant.language', foreground: strip(v('syntax-number')) },
      { token: 'entity.name.type', foreground: strip(v('syntax-type')) },
      { token: 'support.type', foreground: strip(v('syntax-type')) },
      { token: 'entity.name.class', foreground: strip(v('syntax-type')) },
      { token: 'entity.name.function', foreground: strip(v('syntax-function')), fontStyle: 'bold' },
      { token: 'support.function', foreground: strip(v('syntax-function')) },
      { token: 'variable.other.property', foreground: strip(v('syntax-property')) },
      { token: 'punctuation', foreground: strip(v('syntax-punctuation')) },
      { token: 'markup.heading', foreground: strip(hex('fg')), fontStyle: 'bold' },
      { token: 'markup.inline.raw', foreground: strip(v('syntax-string')) },
      { token: 'entity.name.tag', foreground: strip(v('syntax-keyword')) },
      { token: 'entity.other.attribute-name', foreground: strip(v('syntax-type')) },
    ],
  };
}
