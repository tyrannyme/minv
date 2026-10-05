import { performance } from 'node:perf_hooks';

export interface TraceEvent { kind: string; at: number; durationMs?: number; queueMs?: number; count?: number; status?: string }
/** Bounded local metadata-only trace. No file contents, paths, commands' args or credentials. */
export class Diagnostics {
  private events: TraceEvent[] = [];
  private total = 0;
  record(event: Omit<TraceEvent, 'at'>): void {
    this.events.push({ ...event, at: performance.now() }); this.total++;
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
  }
  snapshot() { return { schema: 1, generatedAt: new Date().toISOString(), totalEvents: this.total, retainedEvents: this.events.length, events: this.events.map(event => ({ ...event })), processMemory: process.memoryUsage() }; }
}
