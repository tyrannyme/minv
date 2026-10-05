import type { CursorPosition, EditorAdapter, EditorDocument, EditorHandle, EditorOptions, EditorTheme } from '../renderer/src/contract.js';

/** Only the audited public facade of our source-built editor is accepted here. */
export interface LocalEditorModule {
  editor: any;
  languages: { getLanguages(): Array<{ id: string; extensions?: string[]; filenames?: string[] }> };
  Uri: { parse(uri: string): any };
  initializeLanguages(): Promise<void>;
}

type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
type Change = { range: Range; text: string };
type RawEdit = { offset: number; removed: string; inserted: string };
type Transaction = { before: number; after: number; forward: RawEdit[]; reverse: RawEdit[] };

/** Code-OSS normalizes model EOLs; retain raw EOLs separately and mirror its undo versions. */
export class RawText {
  private transactions: Transaction[] = [];
  private cursor = 0;
  private version: number;
  constructor(public value: string, version: number) { this.version = version; }

  reset(text: string, version: number): void {
    this.value = text; this.version = version; this.transactions = []; this.cursor = 0;
  }

  private offset(line: number, column: number): number {
    let current = 1;
    const endings = /\r\n|\r|\n/g;
    let start = 0;
    for (let match; current < line && (match = endings.exec(this.value)); current++) start = match.index + match[0].length;
    return Math.min(this.value.length, start + Math.max(0, column - 1));
  }

  private apply(edits: RawEdit[]): void {
    for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) {
      if (this.value.slice(edit.offset, edit.offset + edit.removed.length) !== edit.removed) throw new Error('Editor raw-text history no longer matches its model.');
      this.value = this.value.slice(0, edit.offset) + edit.inserted + this.value.slice(edit.offset + edit.removed.length);
    }
  }

  change(changes: Change[], version: number, undo: boolean, redo: boolean): void {
    if (undo) {
      while (this.cursor > 0 && this.version !== version) {
        const transaction = this.transactions[this.cursor - 1]!;
        if (transaction.after !== this.version) break;
        this.apply(transaction.reverse); this.version = transaction.before; this.cursor--;
      }
      if (this.version === version) return;
      throw new Error('Editor undo cannot be reconciled without changing original line endings.');
    }
    if (redo) {
      while (this.cursor < this.transactions.length && this.version !== version) {
        const transaction = this.transactions[this.cursor]!;
        if (transaction.before !== this.version) break;
        this.apply(transaction.forward); this.version = transaction.after; this.cursor++;
      }
      if (this.version === version) return;
      throw new Error('Editor redo cannot be reconciled without changing original line endings.');
    }
    const defaultEol = /\r\n|\r|\n/.exec(this.value)?.[0] ?? '\n';
    const forward = changes.map(change => {
      const offset = this.offset(change.range.startLineNumber, change.range.startColumn);
      const end = this.offset(change.range.endLineNumber, change.range.endColumn);
      const localEol = /\r\n|\r|\n/.exec(this.value.slice(offset))?.[0] ?? defaultEol;
      return { offset, removed: this.value.slice(offset, end), inserted: change.text.replace(/\r\n|\r|\n/g, localEol) };
    }).sort((a, b) => a.offset - b.offset);
    let shift = 0;
    const reverse = forward.map(edit => {
      const inverse = { offset: edit.offset + shift, removed: edit.inserted, inserted: edit.removed };
      shift += edit.inserted.length - edit.removed.length;
      return inverse;
    });
    this.apply(forward);
    this.transactions.splice(this.cursor);
    this.transactions.push({ before: this.version, after: version, forward, reverse });
    this.cursor++; this.version = version;
  }
}

type ModelRecord = {
  model: any; refs: number; raw: RawText; changed: { dispose(): void }; replacing: boolean; pendingText?: string; failure?: Error;
};

export function createEditorAdapter(module: LocalEditorModule): EditorAdapter {
  const { editor, languages, Uri } = module;
  const models = new Map<string, ModelRecord>();
  const instances = new Map<any, boolean>();
  const comparisons = new Map<any, boolean>();
  let nextComparison = 0;
  let options: EditorOptions = { fontSize: 13, tabSize: 2, wordWrap: false, renderWhitespace: false };
  let fontFamily = "'IBM Plex Mono', monospace";
  let lineHeight = 20;

  function languageFor(doc: EditorDocument): string {
    if (doc.large) return 'plaintext';
    const name = decodeURIComponent(new URL(doc.uri).pathname.split('/').at(-1) || '').toLowerCase();
    const all = languages.getLanguages();
    if (doc.languageId && doc.languageId !== 'plaintext' && all.some(language => language.id === doc.languageId)) return doc.languageId;
    const exact = all.find(language => language.filenames?.some(file => file.toLowerCase() === name));
    if (exact) return exact.id;
    let match: { id: string; length: number } | undefined;
    for (const language of all) for (const extension of language.extensions ?? []) {
      if (name.endsWith(extension.toLowerCase()) && extension.length > (match?.length ?? 0)) match = { id: language.id, length: extension.length };
    }
    return match?.id ?? doc.languageId ?? 'plaintext';
  }

  // Visual values follow Claude's renderer/editor/codeoss.ts. Reduced mode is functional.
  const base = (large = false) => ({
    automaticLayout: false, minimap: { enabled: false }, glyphMargin: false, lineNumbersMinChars: 4, lineDecorationsWidth: 12,
    renderLineHighlight: 'line', scrollBeyondLastLine: false, overviewRulerBorder: false, overviewRulerLanes: 2, hideCursorInOverviewRuler: true,
    fontLigatures: false, stickyScroll: { enabled: false }, padding: { top: 18, bottom: 18 }, fontFamily, lineHeight,
    fontSize: options.fontSize, tabSize: options.tabSize, wordWrap: !large && options.wordWrap ? 'on' : 'off', renderWhitespace: options.renderWhitespace ? 'all' : 'selection',
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false }, cursorBlinking: 'phase', cursorSmoothCaretAnimation: 'off',
    smoothScrolling: false, folding: !large, guides: { indentation: !large, highlightActiveIndentation: false }, bracketPairColorization: { enabled: false },
    quickSuggestions: false, suggestOnTriggerCharacters: false, wordBasedSuggestions: 'off', parameterHints: { enabled: false }, hover: { enabled: false }, links: false,
    contextmenu: true, largeFileOptimizations: true, unicodeHighlight: { ambiguousCharacters: !large, invisibleCharacters: !large },
    ...(large ? { maxTokenizationLineLength: 0, renderValidationDecorations: 'off', matchBrackets: 'never', occurrencesHighlight: 'off' } : {}),
  });

  function acquire(doc: EditorDocument, isolate = false): { key: string; record: ModelRecord } {
    const key = isolate ? `minv-comparison://view/${++nextComparison}/${encodeURIComponent(doc.uri)}` : Uri.parse(doc.uri).toString();
    const existing = models.get(key);
    if (existing) {
      existing.refs++;
      if (doc.large) editor.setModelLanguage(existing.model, 'plaintext');
      return { key, record: existing };
    }
    if (editor.getModel(Uri.parse(key))) throw new Error('The document already belongs to another editor owner.');
    const model = editor.createModel(doc.text, languageFor(doc), Uri.parse(key));
    model.updateOptions({ tabSize: options.tabSize });
    const record = { model, refs: 1, raw: new RawText(doc.text, model.getAlternativeVersionId()), replacing: false } as ModelRecord;
    record.changed = model.onDidChangeContent((event: any) => {
      if (record.replacing) return;
      try { record.raw.change(event.changes, model.getAlternativeVersionId(), event.isUndoing, event.isRedoing); }
      catch (error) { record.failure = error instanceof Error ? error : new Error(String(error)); }
    });
    models.set(key, record);
    return { key, record };
  }

  function release(key: string): void {
    const record = models.get(key);
    if (!record || --record.refs > 0) return;
    record.changed.dispose(); record.model.dispose(); models.delete(key);
  }

  return {
    name: 'Code-OSS',
    create(container, doc): EditorHandle {
      const { key, record } = acquire(doc);
      let instance: any;
      try { instance = editor.create(container, { ...base(doc.large), model: record.model, readOnly: doc.readOnly, ariaLabel: doc.uri.split('/').at(-1) || 'Text editor' }); }
      catch (error) { release(key); throw error; }
      instances.set(instance, !!doc.large);
      let disposed = false;
      const subscriptions = new Set<{ dispose(): void }>();
      return {
        getText: () => { if (record.replacing) return record.pendingText!; if (record.failure) throw record.failure; return record.raw.value; },
        setText: text => {
          const states = [...instances.keys()].filter(view => view.getModel() === record.model).map(view => ({ view, state: view.saveViewState() }));
          record.replacing = true;
          record.pendingText = text;
          try { record.model.setValue(text); record.raw.reset(text, record.model.getAlternativeVersionId()); record.failure = undefined; }
          finally { record.replacing = false; record.pendingText = undefined; }
          for (const { view, state } of states) if (state) view.restoreViewState(state);
        },
        setReadOnly: readOnly => instance.updateOptions({ readOnly }),
        revealLine: (line, column = 1) => {
          const position = record.model.validatePosition({ lineNumber: Math.max(1, line), column: Math.max(1, column) });
          instance.setPosition(position); instance.revealLineInCenter(position.lineNumber);
        },
        focus: () => instance.focus(), layout: () => instance.layout(),
        // The editor's fast forwarded event can run before the public model event.
        // Subscribe here after the raw-text listener so consumers observe the new text.
        onDidChangeContent: listener => {
          if (disposed) return () => {};
          const subscription = record.model.onDidChangeContent(listener);
          subscriptions.add(subscription);
          return () => { subscriptions.delete(subscription); subscription.dispose(); };
        },
        onDidChangeCursor: (listener: (position: CursorPosition) => void) => {
          const subscription = instance.onDidChangeCursorSelection((event: any) => listener({ line: event.selection.positionLineNumber, column: event.selection.positionColumn, selections: 1 + (event.secondarySelections?.length ?? 0) }));
          return () => subscription.dispose();
        },
        run: action => {
          instance.focus();
          if (action === 'undo' || action === 'redo') instance.trigger('minv', action, null);
          else {
            const id = { find: 'actions.find', replace: 'editor.action.startFindReplaceAction', gotoLine: 'editor.action.gotoLine' }[action];
            const command = instance.getAction(id);
            if (!command) throw new Error(`Editor action is unavailable: ${action}`);
            void command.run();
          }
        },
        getView: () => {
          const position = instance.getPosition();
          return { line: position?.lineNumber ?? 1, column: position?.column ?? 1, scrollTop: Math.round(instance.getScrollTop()), scrollLeft: Math.round(instance.getScrollLeft()) };
        },
        setView: view => {
          instance.setPosition(record.model.validatePosition({ lineNumber: Math.max(1, view.line), column: Math.max(1, view.column) }));
          instance.setScrollPosition({ scrollTop: view.scrollTop, scrollLeft: view.scrollLeft });
        },
        dispose: () => { if (!disposed) { disposed = true; for (const subscription of subscriptions) subscription.dispose(); subscriptions.clear(); instances.delete(instance); instance.dispose(); release(key); } },
      };
    },
    createComparison(container, original, modified, inline) {
      const left = acquire({ ...original, readOnly: true }, true);
      let right: ReturnType<typeof acquire>;
      try { right = acquire({ ...modified, readOnly: true }, true); }
      catch (error) { release(left.key); throw error; }
      const large = !!(original.large || modified.large);
      let diff: any;
      try {
        diff = editor.createDiffEditor(container, { ...base(large), readOnly: true, originalEditable: false, renderSideBySide: !inline, renderOverviewRuler: false, ignoreTrimWhitespace: false, diffAlgorithm: 'advanced', maxComputationTime: 5000 });
        diff.setModel({ original: left.record.model, modified: right.record.model });
      } catch (error) { diff?.dispose(); release(left.key); release(right.key); throw error; }
      comparisons.set(diff, large);
      let disposed = false;
      return { layout: () => diff.layout(), dispose: () => { if (!disposed) { disposed = true; comparisons.delete(diff); diff.dispose(); release(left.key); release(right.key); } } };
    },
    setTheme(theme: EditorTheme) {
      fontFamily = theme.fontFamily; lineHeight = theme.lineHeight;
      const baseTheme = theme.highContrast ? (theme.base === 'dark' ? 'hc-black' : 'hc-light') : theme.base === 'dark' ? 'vs-dark' : 'vs';
      editor.defineTheme('minv', { base: baseTheme, inherit: true, rules: theme.tokens, colors: theme.colors });
      editor.setTheme('minv');
      for (const view of [...instances.keys(), ...comparisons.keys()]) view.updateOptions({ fontFamily, lineHeight });
      void document.fonts.ready.then(() => editor.remeasureFonts());
    },
    setOptions(next: EditorOptions) {
      options = { ...next };
      for (const record of models.values()) record.model.updateOptions({ tabSize: next.tabSize });
      for (const [view, large] of [...instances, ...comparisons]) view.updateOptions({ fontSize: next.fontSize, tabSize: next.tabSize, wordWrap: !large && next.wordWrap ? 'on' : 'off', renderWhitespace: next.renderWhitespace ? 'all' : 'selection' });
    },
  };
}
