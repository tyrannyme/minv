import { register, registerTokensProviderFactory, setLanguageConfiguration } from '@codeoss/editor/standalone/browser/standaloneLanguages.js';
import { Registry, INITIAL, parseRawGrammar } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';

type Language = { id: string; extensions?: string[]; filenames?: string[]; aliases?: string[]; firstLine?: string; configuration?: string };
type Grammar = { scopeName: string; language?: string; file: string; injectTo?: string[] };
type Manifest = { languages: Language[]; grammars: Grammar[] };
let ready: Promise<void> | undefined;

async function localText(path: string): Promise<string> {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error(`Cannot load bundled syntax asset: ${path}`);
  return response.text();
}

function regexp(value: unknown): RegExp | undefined {
  if (typeof value === 'string') return new RegExp(value);
  if (value && typeof value === 'object' && 'pattern' in value) {
    return new RegExp(String(value.pattern), 'flags' in value ? String(value.flags) : undefined);
  }
  return undefined;
}

function convertConfiguration(configuration: any) {
  const result = { ...configuration };
  if (configuration.wordPattern) result.wordPattern = regexp(configuration.wordPattern);
  if (configuration.indentationRules) {
    result.indentationRules = Object.fromEntries(Object.entries(configuration.indentationRules).map(([key, value]) => [key, regexp(value)]));
  }
  if (configuration.folding?.markers) result.folding = { ...configuration.folding, markers: {
    start: regexp(configuration.folding.markers.start), end: regexp(configuration.folding.markers.end),
  } };
  if (configuration.onEnterRules) result.onEnterRules = configuration.onEnterRules.map((rule: any) => {
    const copy = { ...rule, action: { ...rule.action } };
    for (const key of ['beforeText', 'afterText', 'previousLineText']) if (rule[key]) copy[key] = regexp(rule[key]);
    const indent = { none: 0, indent: 1, indentOutdent: 2, outdent: 3 };
    if (typeof copy.action.indent === 'string') copy.action.indent = indent[copy.action.indent as keyof typeof indent] ?? 0;
    return copy;
  });
  return result;
}

export function initializeLanguages(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const manifest: Manifest = JSON.parse(await localText('./syntax/manifest.json'));
    const wasm = await fetch(new URL('./onig.wasm', import.meta.url));
    if (!wasm.ok) throw new Error('Cannot load local syntax engine.');
    await loadWASM(await wasm.arrayBuffer());
    const scopes = new Map(manifest.grammars.map(grammar => [grammar.scopeName, grammar]));
    const registry = new Registry({
      onigLib: Promise.resolve({ createOnigScanner: (sources: string[]) => new OnigScanner(sources), createOnigString: (value: string) => new OnigString(value) }),
      loadGrammar: async scope => {
        const grammar = scopes.get(scope);
        return grammar ? parseRawGrammar(await localText(`./syntax/${grammar.file}`), grammar.file) : null;
      },
      getInjections: scope => manifest.grammars.filter(grammar => grammar.injectTo?.includes(scope)).map(grammar => grammar.scopeName),
    });
    for (const language of manifest.languages) {
      const { configuration, ...metadata } = language;
      register(metadata);
      const grammar = manifest.grammars.find(grammar => grammar.language === language.id);
      if (grammar) registerTokensProviderFactory(language.id, { create: async () => {
        if (configuration) setLanguageConfiguration(language.id, convertConfiguration(JSON.parse(await localText(`./syntax/${configuration}`))));
        const loaded = await registry.loadGrammar(grammar.scopeName);
        if (!loaded) throw new Error(`No bundled grammar for ${language.id}`);
        return {
          getInitialState: () => INITIAL,
          tokenize(line: string, state: typeof INITIAL) {
            const result = loaded.tokenizeLine(line, state, 100);
            return { endState: result.ruleStack, tokens: result.tokens.map(token => ({ startIndex: token.startIndex, scopes: token.scopes.at(-1) || '' })) };
          },
        };
      } });
    }
  })();
  return ready;
}
