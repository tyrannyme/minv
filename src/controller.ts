import { EventEmitter } from 'node:events';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { discoverRepositories, loadCatalog, readBranch, saveCatalog } from './core/catalog';
import { readStatus } from './core/status';
import { Branch, GitRunner, Observation, Repository, RepositoryStatus } from './core/types';

export interface Row {
  repository: Repository;
  monitoringError?: string;
  branch: Observation<Branch>;
  status: Observation<RepositoryStatus>;
}

/** Keeps independent observations and rejects results from superseded refreshes. */
export class RepositoryController extends EventEmitter {
  rows: Row[] = [];
  selectedId?: string;
  private disposed = false;
  private discovery = 0;
  private serial = 0;
  private active = new Map<string, Promise<void>>();
  private pending = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly git: GitRunner, private readonly cacheFile: string, private readonly allowContent: () => boolean = () => true) { super(); }

  async open(roots: string[], selectedId?: string): Promise<void> {
    const epoch = ++this.discovery;
    // A cache from a previously opened workspace must never escape the current roots.
    const [cached, canonicalRoots] = await Promise.all([loadCatalog(this.cacheFile), Promise.all(roots.map(root => realpath(root).catch(() => path.resolve(root))))]);
    if (this.disposed || epoch !== this.discovery) return;
    this.rows = cached.filter(repo => canonicalRoots.some(root => repo.root === root || repo.root.startsWith(`${root}${path.sep}`) || root.startsWith(`${repo.root}${path.sep}`)))
      .map(repository => this.newRow(repository, 'cached'));
    this.selectedId = selectedId ?? this.rows[0]?.repository.id;
    this.emit('change');
    const cachedSelection = this.rows.find(row => row.repository.id === this.selectedId);
    if (cachedSelection) void this.observe(cachedSelection, 'branch');
    const cachedQueue = this.rows.filter(row => row !== cachedSelection);
    void Promise.all(Array.from({ length: Math.min(4, cachedQueue.length) }, async () => {
      let row: Row | undefined;
      while (!this.disposed && epoch === this.discovery && (row = cachedQueue.shift())) await this.observe(row, 'branch');
    }));
    const discovered = await discoverRepositories(roots, this.git, repository => {
      if (this.disposed || epoch !== this.discovery) return;
      let row = this.rows.find(item => item.repository.id === repository.id);
      if (row) row.repository = repository;
      else { row = this.newRow(repository, 'unknown'); this.rows.push(row); }
      this.selectedId ??= repository.id;
      this.emit('change');
      void this.observe(row, 'branch');
      if (row.repository.id === this.selectedId) void this.observe(row, 'status');
    });
    if (this.disposed || epoch !== this.discovery) return;
    const byId = new Map(discovered.map(repo => [repo.id, repo]));
    const previous = this.rows;
    this.rows = previous.map(row => {
      row.repository = byId.get(row.repository.id) ?? { ...row.repository, available: false, error: 'Previously known checkout was not found during discovery.' };
      byId.delete(row.repository.id);
      return row;
    });
    for (const repository of byId.values()) this.rows.push(this.newRow(repository, 'unknown'));
    if (!this.rows.some(row => row.repository.id === this.selectedId)) this.selectedId = this.rows[0]?.repository.id;
    this.emit('change');
    await saveCatalog(this.cacheFile, this.rows.map(row => row.repository)).catch(error => this.emit('problem', error));
    if (this.disposed) return;
    const selected = this.rows.find(row => row.repository.id === this.selectedId);
    if (selected) {
      void this.observe(selected, 'branch');
      void this.observe(selected, 'status');
    }
    // Bound requests at the controller as well as at the subprocess scheduler.
    const queue = this.rows.filter(row => row !== selected);
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      let row: Row | undefined;
      while (!this.disposed && epoch === this.discovery && (row = queue.shift())) await this.observe(row, 'branch');
    }));
  }

  get(id: string): Row {
    const row = this.rows.find(item => item.repository.id === id);
    if (!row) throw new Error('This repository is no longer in the workspace.');
    return row;
  }

  select(id: string): void {
    const row = this.get(id);
    this.selectedId = id;
    this.emit('change');
    void this.observe(row, 'branch');
    void this.observe(row, 'status');
  }

  async refresh(all = false): Promise<void> {
    const rows = all ? [...this.rows] : this.rows.filter(row => row.repository.id === this.selectedId);
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
      let row: Row | undefined;
      while (!this.disposed && (row = rows.shift())) {
        if (!row.repository.available) {
          const inspected = await discoverRepositories([row.repository.root], this.git);
          const recovered = inspected.find(repo => repo.id === row!.repository.id);
          if (recovered) row.repository = { ...recovered, parentId: row.repository.parentId };
        }
        await Promise.all([this.observe(row, 'branch'), this.observe(row, 'status')]);
      }
    }));
  }

  invalidate(id: string): void {
    const row = this.rows.find(item => item.repository.id === id);
    if (!row || this.disposed) return;
    for (const field of ['branch', 'status'] as const) {
      Object.assign(row[field], { state: 'stale', generation: ++this.serial });
      const key = `${id}:${field}`;
      if (this.active.has(key)) this.pending.add(key);
    }
    this.emit('change');
    // Throttle, rather than indefinitely debounce, sustained external writes.
    if (this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      void this.observe(row, 'branch');
      if (id === this.selectedId) void this.observe(row, 'status');
    }, 150));
  }

  dispose(): void {
    this.disposed = true;
    this.discovery++;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.removeAllListeners();
  }

  private newRow(repository: Repository, state: 'cached' | 'unknown'): Row {
    return { repository, branch: { state, generation: ++this.serial }, status: { state: 'unknown', generation: ++this.serial } };
  }

  private observe(row: Row, field: 'branch' | 'status'): Promise<void> {
    if (this.disposed || !this.rows.includes(row)) return Promise.resolve();
    const key = `${row.repository.id}:${field}`;
    const existing = this.active.get(key);
    if (existing) return existing;
    const generation = ++this.serial;
    Object.assign(row[field], { state: 'refreshing', generation });
    this.emit('change');
    const request = Promise.resolve().then(async () => {
      try {
        if (field === 'status' && !this.allowContent()) throw new Error('Trust this workspace to inspect file changes. Branch inspection is available in restricted mode.');
        if (!row.repository.available) throw new Error(row.repository.error || 'Checkout is unavailable.');
        const value = field === 'branch' ? await readBranch(row.repository, this.git) : await readStatus(row.repository, this.git);
        if (this.disposed || row[field].generation !== generation || !this.rows.includes(row)) return;
        const observation = { value, state: 'observed' as const, observedAt: Date.now(), generation };
        if (field === 'branch') row.branch = observation as Observation<Branch>;
        else row.status = observation as Observation<RepositoryStatus>;
      } catch (error) {
        if (!this.disposed && row[field].generation === generation) Object.assign(row[field], { state: 'error', error: error instanceof Error ? error.message : String(error), generation });
      } finally {
        this.active.delete(key);
        if (!this.disposed) {
          this.emit('change');
          if (this.pending.delete(key)) void this.observe(row, field);
        }
      }
    });
    this.active.set(key, request);
    return request;
  }
}
