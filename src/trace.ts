// Trace events for one stage call. Collected in memory and written with the stage result in one
// transaction. Every stage call must produce events; a result without them is rejected by the store.
import type { TraceEventInput } from "./store/db.js";

export interface TraceEvent extends TraceEventInput {
  seq: number;
  at: string;
}

export class TraceCollector {
  readonly events: TraceEvent[] = [];

  add(kind: string, content: unknown): TraceEvent {
    const e: TraceEvent = { seq: this.events.length + 1, kind, content, at: new Date().toISOString() };
    this.events.push(e);
    return e;
  }

  ofKind(kind: string): TraceEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }

  /** Events in the shape the store accepts. */
  toInputs(): TraceEventInput[] {
    return this.events.map(({ kind, content }) => ({ kind, content }));
  }
}
