export type Freshness = 'unknown' | 'cached' | 'refreshing' | 'observed' | 'stale' | 'error';
export interface Observation<T> { state: Freshness; value?: T; observedAt?: number; error?: string; generation: number }
export interface Repository { id: string; root: string; name: string; gitDir?: string; commonDir?: string; parentId?: string; available: boolean; error?: string }
export interface Branch { kind: 'branch' | 'detached' | 'unborn'; name?: string; oid?: string; operation?: string }
export interface Change { path: string; originalPath?: string; index: string; workingTree: string; submodule?: string }
export interface RepositoryStatus { changes: Change[]; complete: boolean }
export interface GitOptions { signal?: AbortSignal; lane?: 'metadata' | 'foreground' | 'background'; maxBytes?: number; timeoutMs?: number; write?: boolean; cancelActiveWrite?: boolean; lockKey?: string; input?: string }
export interface GitResult { stdout: string; stderr: string; exitCode: number }
export interface GitRunner { run(cwd: string, args: readonly string[], options?: GitOptions): Promise<GitResult> }
export interface CatalogSnapshot { version: 1; repositories: Repository[] }
