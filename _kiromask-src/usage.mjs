// Per-request usage log (JSONL) plus in-memory session totals.
import fs from 'node:fs';
import path from 'node:path';

export class UsageTracker {
  constructor(dir, enabled = true) {
    this.file = path.join(dir, 'usage.jsonl');
    this.enabled = enabled;
    this.totals = { requests: 0, prompt: 0, completion: 0, byModel: {} };
  }
  record(r) {
    this.totals.requests++;
    this.totals.prompt += r.prompt || 0;
    this.totals.completion += r.completion || 0;
    const m = (this.totals.byModel[r.model] ??= { requests: 0, prompt: 0, completion: 0 });
    m.requests++; m.prompt += r.prompt || 0; m.completion += r.completion || 0;
    if (!this.enabled) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...r }) + '\n');
    } catch { /* ignore */ }
  }
}
