/* =========================================================================
   perf.js — a tiny frame profiler.

   Systems report how long a named piece of work took with `perf.add(name, ms)`;
   once per frame `endFrame()` folds those into smoothed per-section averages,
   a per-second worst case, and a count of "hitches" (frames that took long
   enough to be felt). The F3 overlay shows them, and tests/bench.mjs reads
   them to compare builds.

   It allocates nothing per frame: section names are fixed strings and the
   accumulators are plain numbers on pre-existing keys.
   ========================================================================= */

const EMA = 0.1;             // smoothing for the per-section averages
const HITCH_MS = 40;         // a frame slower than this (25 fps) counts as a hitch

export class Perf {
  constructor() {
    this.avg = Object.create(null);     // section -> smoothed ms per frame
    this.worst = Object.create(null);   // section -> worst ms in the current window
    this._acc = Object.create(null);    // section -> ms this frame
    this.frameMs = 0;                   // smoothed whole-frame CPU time
    this.frameWorst = 0;                // worst frame since the last window reset
    this.hitches = 0;                   // frames over HITCH_MS since reset
    this.frames = 0;
    this._window = 0;
    this._samples = [];                 // recent frame times for percentiles (bounded)
    this.draw = { calls: 0, triangles: 0, geometries: 0 };   // last frame's renderer statistics
  }

  now() { return performance.now(); }

  add(name, ms) { this._acc[name] = (this._acc[name] || 0) + ms; }

  // Time a function; for cold paths only (the closure allocates).
  time(name, fn) {
    const t = performance.now();
    try { return fn(); } finally { this.add(name, performance.now() - t); }
  }

  endFrame(frameMs, dtMs) {
    this.frames++;
    this.frameMs += (frameMs - this.frameMs) * EMA;
    if (frameMs > this.frameWorst) this.frameWorst = frameMs;
    if (dtMs > HITCH_MS) this.hitches++;
    for (const k in this._acc) {
      const v = this._acc[k];
      this.avg[k] = (this.avg[k] || 0) + (v - (this.avg[k] || 0)) * EMA;
      if (v > (this.worst[k] || 0)) this.worst[k] = v;
      this._acc[k] = 0;
    }
    const s = this._samples;
    s.push(dtMs);
    if (s.length > 600) s.shift();
  }

  // Percentile (0..1) of the recent wall-clock frame times, in ms.
  percentile(p) {
    if (!this._samples.length) return 0;
    const a = this._samples.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(p * a.length))];
  }

  resetWindow() {
    this.frameWorst = 0;
    this.hitches = 0;
    for (const k in this.worst) this.worst[k] = 0;
    this._samples.length = 0;
  }

  // Human-readable lines for the debug overlay, biggest sections first.
  report(limit = 8) {
    const rows = Object.keys(this.avg).map((k) => [k, this.avg[k], this.worst[k] || 0]);
    rows.sort((a, b) => b[1] - a[1]);
    return rows.slice(0, limit).map(([k, a, w]) => `${k.padEnd(10)} ${a.toFixed(2).padStart(6)} ms  (max ${w.toFixed(1)})`);
  }
}

export default Perf;
