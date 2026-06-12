// VelocityFlatlineDetector — Tier 2 streaming completion signal.
//
// Tracks the character-output rate of an active stream.  Declares the stream
// complete when:
//   currentRate < FLATLINE_RATIO * peakRate   AND
//   that sub-threshold state has persisted for MIN_QUIET_MS
//
// This is purely mathematical — no DOM selectors, no provider coupling.
// The stop-button watcher (Tier 1.5) and SSE interceptor (Tier 1) are faster;
// this fires when neither is available (e.g. XHR-polled providers, unknown UIs).

const WINDOW_MS = 500;     // rolling window for rate measurement
const MIN_QUIET_MS = 800;  // must stay flatlined this long before we fire
const FLATLINE_RATIO = 0.05; // currentRate < 5 % of peak → flatlined

type DetectorState = 'idle' | 'streaming' | 'flatlined' | 'done';

interface Sample {
  chars: number;
  ts: number;
}

export class VelocityFlatlineDetector {
  private readonly minQuietMs: number;
  private readonly flatlineRatio: number;
  readonly onComplete: () => void;

  private state: DetectorState = 'idle';
  private samples: Sample[] = [];
  private peakRate = 0;          // chars / ms
  private flatlineStart: number | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    onComplete: () => void,
    opts?: { flatline_ratio?: number; min_quiet_ms?: number },
  ) {
    this.onComplete = onComplete;
    this.flatlineRatio = opts?.flatline_ratio ?? FLATLINE_RATIO;
    this.minQuietMs = opts?.min_quiet_ms ?? MIN_QUIET_MS;
  }

  /**
   * Call this from StreamWatcher.onActivity with the number of characters added
   * and the current timestamp (performance.now()).
   */
  onMutation(charsAdded: number, ts: number): void {
    if (this.state === 'done') return;
    this.state = 'streaming';

    this.samples.push({ chars: charsAdded, ts });
    this._evict(ts);

    const rate = this._currentRate(ts);
    if (rate > this.peakRate) this.peakRate = rate;

    this._evaluate(ts);
  }

  dispose(): void {
    if (this.checkTimer !== null) clearTimeout(this.checkTimer);
    this.state = 'done';
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _evict(now: number): void {
    const cutoff = now - WINDOW_MS;
    this.samples = this.samples.filter((s) => s.ts >= cutoff);
  }

  private _currentRate(now: number): number {
    if (this.samples.length === 0) return 0;
    const totalChars = this.samples.reduce((sum, s) => sum + s.chars, 0);
    const windowSpan = Math.max(now - this.samples[0].ts, 1);
    return totalChars / windowSpan; // chars / ms
  }

  private _evaluate(now: number): void {
    if (this.state === 'done') return;

    const rate = this._currentRate(now);
    const threshold = this.peakRate * this.flatlineRatio;
    const isFlatlined = this.peakRate > 0 && rate < threshold;

    if (isFlatlined) {
      if (this.flatlineStart === null) {
        this.state = 'flatlined';
        this.flatlineStart = now;
        // Re-evaluate after minQuietMs to see if we're still flat.
        if (this.checkTimer !== null) clearTimeout(this.checkTimer);
        this.checkTimer = setTimeout(() => {
          const checkNow = performance.now();
          this._evict(checkNow);
          this._evaluate(checkNow);
        }, this.minQuietMs);
      } else if (now - this.flatlineStart >= this.minQuietMs) {
        this._fire();
      }
    } else {
      // Rate recovered — reset flatline window.
      this.flatlineStart = null;
      this.state = 'streaming';
      if (this.checkTimer !== null) { clearTimeout(this.checkTimer); this.checkTimer = null; }
    }
  }

  private _fire(): void {
    if (this.state === 'done') return;
    this.state = 'done';
    if (this.checkTimer !== null) { clearTimeout(this.checkTimer); this.checkTimer = null; }
    this.onComplete();
  }
}
