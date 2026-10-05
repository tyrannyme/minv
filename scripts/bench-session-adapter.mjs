import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);

/** Exercises the real desktop session through its public host API, with no Electron renderer. */
export async function sessionAdapter(git, dataDirectory, roots, errors) {
  const { WorkspaceSession } = require('../dist/desktop/main/workspace.js');
  const { StateStore } = require('../dist/desktop/main/state.js');
  const state = new StateStore(dataDirectory);
  await state.load();
  state.trust(roots); // This is an explicitly disposable, generated workload.
  const updates = new EventEmitter();
  const watches = new EventEmitter();
  const rows = new Map();
  let selectedId;
  const session = new WorkspaceSession({ state, git, dataDirectory, confirm: async () => false, choose: async () => undefined,
    emit(event, payload) {
      if (event === 'workspace' && payload) {
        rows.clear();
        for (const row of payload.rows) rows.set(row.id, row);
        selectedId = payload.selectedId;
        updates.emit('change');
      } else if (event === 'rows') {
        for (const row of payload.rows) rows.set(row.id, row);
        updates.emit('change');
      }
    },
    onWatchEvent(event) { watches.emit('invalidation', event); },
  });
  const converted = row => {
    let repository;
    try { repository = session.repository(row.id); } catch { repository = row; }
    return { repository, branch: row.branch, status: row.status };
  };
  return {
    session,
    controller: {
      get rows() { return [...rows.values()].map(converted); },
      get selectedId() { return selectedId; },
      async open(inputs) { await session.open(inputs); await session.ready; await session.settled(); },
      get(id) { const row = rows.get(id); if (!row) throw new Error(`Unknown session row ${id}`); return converted(row); },
      select(id) { return session.handlers['repo.select']({ id }); },
      invalidate() { /* WorkspaceSession applies its own watcher invalidations. */ },
      on(name, listener) { return updates.on(name, listener); },
      off(name, listener) { return updates.off(name, listener); },
      async dispose() { await session.close(); },
    },
    watcher: {
      snapshot: () => session.diagnostics(),
      setRepositories() { /* Managed by the actual session. */ },
      watchRoots() { /* Managed by the actual session. */ },
      on: (name, listener) => watches.on(name, listener),
      dispose() { /* Session close owns teardown. */ },
    },
  };
}
