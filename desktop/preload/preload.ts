import { contextBridge, ipcRenderer } from 'electron';
import type { HostEvents } from '../renderer/src/contract';

const events = new Set(['workspace', 'workspace.willClose', 'rows', 'file.changed', 'search.progress', 'notice', 'window.state', 'open', 'compare', 'prefs']);
const transport = {
  invoke(method: string, params: unknown): Promise<unknown> {
    return ipcRenderer.invoke('minv:request', method, params);
  },
  on<E extends keyof HostEvents>(event: E, listener: (payload: HostEvents[E]) => void): () => void {
    if (!events.has(event) || typeof listener !== 'function') throw new Error('Unknown Minv event.');
    const callback = (_event: Electron.IpcRendererEvent, name: string, payload: HostEvents[E]) => { if (name === event) listener(payload); };
    ipcRenderer.on('minv:event', callback);
    return () => ipcRenderer.removeListener('minv:event', callback);
  }
};
contextBridge.exposeInMainWorld('minvTransport', Object.freeze(transport));
