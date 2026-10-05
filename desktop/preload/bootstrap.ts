// Trusted renderer entrypoint. This is not the context-isolated Electron IPC preload.
// Paths are relative to the packaged app/bootstrap.js, never workspace-controlled.
import { createEditorAdapter, type LocalEditorModule } from './editor-adapter.js';
import type { HostEvents, HostMethods, MinvHost } from '../renderer/src/contract.js';

type Transport = {
  invoke(method: string, params: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error?: { code?: string; message?: string; detail?: string } }>;
  on<E extends keyof HostEvents>(event: E, listener: (payload: HostEvents[E]) => void): () => void;
};

function installHost(): void {
  const transport = (window as Window & { minvTransport?: Transport }).minvTransport;
  if (!transport) throw new Error('The local Minv host transport is unavailable.');
  const host: MinvHost = {
    async invoke<M extends keyof HostMethods>(method: M, params: HostMethods[M][0]): Promise<HostMethods[M][1]> {
      const response = await transport.invoke(method, params);
      if (!response || response.ok !== true) {
        const failure = response && response.ok === false ? response.error : undefined;
        // Construct errors in this world: contextBridge drops isolated-world Error fields.
        const error = new Error(failure?.message || 'Minv request failed.');
        Object.assign(error, { code: failure?.code || 'internal', ...(failure?.detail ? { detail: failure.detail } : {}) });
        throw error;
      }
      return response.value as HostMethods[M][1];
    },
    on: (event, listener) => transport.on(event, listener),
  };
  Object.defineProperty(window, 'minvHost', { value: Object.freeze(host), writable: false, configurable: false });
}

async function bootstrap(): Promise<void> {
  installHost();
  const module: LocalEditorModule = await import(new URL('./editor/editor.js', import.meta.url).href);
  await module.initializeLanguages();
  Object.defineProperty(window, 'minvEditor', { value: createEditorAdapter(module), writable: false, configurable: false });
  await import(new URL('./renderer/dist/main.js', import.meta.url).href);
}

void bootstrap().catch(error => {
  // Keep startup failure legible and accessible without creating an alternate interface.
  const failure = document.createElement('p');
  failure.setAttribute('role', 'alert');
  failure.textContent = `Minv could not load its local interface: ${error instanceof Error ? error.message : String(error)}`;
  document.body.replaceChildren(failure);
  console.error(error);
});
