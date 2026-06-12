import type { StreamMeta, ProviderHints } from './types';
import { TurnExtractor } from './TurnExtractor';
import { VelocityFlatlineDetector } from './VelocityFlatlineDetector';

// Selectors for the "Stop generating" button across known AI providers.
// When this button disappears, streaming is definitively complete.
// Ordered most-specific first so querySelector short-circuits early.
const STOP_BTN_SELECTOR = [
  'button[data-testid="stop-button"]',          // Grok, Meta AI
  'button[aria-label="Stop generating"]',        // ChatGPT, Gemini
  'button[aria-label="Stop streaming"]',         // some Anthropic Claude variants
  'button[aria-label*="stop" i]',               // broad fallback (case-insensitive)
].join(',');

// Explicit state machine: prevents the double-fire race where debounce, flatline,
// stop-button, and SSE interceptor paths could call complete() concurrently.
type WatcherState = 'idle' | 'streaming' | 'completing' | 'done';

export class StreamWatcher {
  private readonly candidate: Element;
  private readonly debounceMs: number;
  private readonly confidence: number;
  private readonly detectedBy: string[];
  private readonly onComplete: (text: string, meta: StreamMeta) => void;

  private startedAt: number;
  private lastActivity: number;
  private chunkCount = 0;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;
  private stopObserver: MutationObserver | null = null;
  private flatline: VelocityFlatlineDetector | null = null;

  private state: WatcherState = 'idle';

  constructor(
    candidate: Element,
    debounceMs: number,
    confidence: number,
    detectedBy: string[],
    onComplete: (text: string, meta: StreamMeta) => void,
    hints?: Pick<ProviderHints, 'disable_flatline' | 'flatline_ratio' | 'min_quiet_ms'>,
  ) {
    this.candidate = candidate;
    this.debounceMs = debounceMs;
    this.confidence = confidence;
    this.detectedBy = detectedBy;
    this.onComplete = onComplete;
    this.startedAt = performance.now();
    this.lastActivity = this.startedAt;

    this.observer = new MutationObserver((mutations) => this.onActivity(mutations));
    this.observer.observe(candidate, {
      characterData: true,
      childList: true,
      subtree: true,
      attributes: false, // CRITICAL: prevent mutation loop
    });

    // Tier 2: Velocity Flatline Detector (unless disabled for this provider).
    if (!hints?.disable_flatline) {
      this.flatline = new VelocityFlatlineDetector(
        () => this.complete('flatline'),
        { flatline_ratio: hints?.flatline_ratio, min_quiet_ms: hints?.min_quiet_ms },
      );
    }

    // Hard safety net: debounce fires if no other Tier has fired first.
    this.scheduleCompletion();

    // Tier 1.5: Stop-button watcher — fires faster than debounce for providers
    // whose stop button is visible, and acts as a fallback when SSE URL patterns
    // don't match (provider variations, custom deployments).
    this._attachStopButtonWatcher();
  }

  dispose(): void {
    if (this.completionTimer !== null) clearTimeout(this.completionTimer);
    this.observer?.disconnect();
    this.observer = null;
    this.stopObserver?.disconnect();
    this.stopObserver = null;
    this.flatline?.dispose();
    this.flatline = null;
  }

  /**
   * Tier 1 (SSE Interceptor): called by StreamInterceptorBridge when the fetch
   * interceptor in the MAIN world detects a streaming response has drained.
   * Arms a short 300 ms settle window to let final DOM tokens render, then
   * calls complete() — which is a no-op if the state machine already reached done.
   */
  signalSseComplete(): void {
    if (this.state === 'done') return;
    this.state = 'completing';
    if (this.completionTimer !== null) clearTimeout(this.completionTimer);
    this.completionTimer = setTimeout(() => this.complete('sse_interceptor'), 300);
  }

  private onActivity(mutations: MutationRecord[]): void {
    if (this.state === 'done') return;
    this.state = 'streaming';
    this.lastActivity = performance.now();

    // Count chars added across all mutations for the velocity detector.
    let charsAdded = 0;
    for (const m of mutations) {
      if (m.type === 'characterData') {
        charsAdded += (m.target.textContent?.length ?? 0);
      } else {
        for (let i = 0; i < m.addedNodes.length; i++) {
          charsAdded += (m.addedNodes[i].textContent?.length ?? 0);
        }
      }
    }

    this.chunkCount += mutations.length;
    this.flatline?.onMutation(Math.max(charsAdded, 1), this.lastActivity);

    this.scheduleCompletion();
  }

  private scheduleCompletion(): void {
    if (this.completionTimer !== null) clearTimeout(this.completionTimer);
    this.completionTimer = setTimeout(() => this.complete('debounce'), this.debounceMs);
  }

  private complete(source: 'debounce' | 'stop_button' | 'flatline' | 'sse_interceptor'): void {
    // State machine guard — whichever Tier wins first, the others are no-ops.
    if (this.state === 'done') return;
    this.state = 'done';

    const text = TurnExtractor.extract(this.candidate);
    const meta: StreamMeta = {
      durationMs: this.lastActivity - this.startedAt,
      chunkCount: this.chunkCount,
      finalCharCount: text.length,
      detectedBy: [...this.detectedBy, source],
      confidence: this.confidence,
    };

    this.observer?.disconnect();
    this.observer = null;
    this.stopObserver?.disconnect();
    this.stopObserver = null;
    this.flatline?.dispose();
    this.flatline = null;

    // Sanity filter: discard streaming-indicator-only payloads (e.g. "▋" blinking
    // cursor, "⏺" stop-record glyph).  isStreamingArtifact() uses a targeted
    // blocklist — emoji-only and all non-streaming responses still pass.
    if (!TurnExtractor.isStreamingArtifact(text)) {
      this.onComplete(text, meta);
    }
  }

  /**
   * Tier 1.5: Attach a secondary MutationObserver that watches for the "Stop
   * generating" button to disappear.  When it does, streaming is definitively
   * over and we can complete with a short 300 ms settle window instead of
   * waiting the full debounce period.  Acts as a reliable fallback for providers
   * whose SSE URL patterns don't match the interceptor, and fires earlier than
   * both the flatline detector and the full debounce for providers with visible
   * stop buttons.  Falls back gracefully if document access throws.
   */
  private _attachStopButtonWatcher(): void {
    try {
      const doc = this.candidate.ownerDocument;
      const docEl = doc?.documentElement;
      if (!docEl) return;
      if (!docEl.querySelector(STOP_BTN_SELECTOR)) return; // not currently streaming

      this.stopObserver = new MutationObserver(() => {
        if (this.state === 'done') {
          this.stopObserver?.disconnect();
          return;
        }
        if (docEl.querySelector(STOP_BTN_SELECTOR)) return; // still streaming

        // Stop button is gone — transition to completing and arm a short settle.
        this.state = 'completing';
        this.stopObserver?.disconnect();
        this.stopObserver = null;

        // Replace the debounce with a short settle period so final DOM tokens
        // can render before we extract text.
        if (this.completionTimer !== null) clearTimeout(this.completionTimer);
        this.completionTimer = setTimeout(() => this.complete('stop_button'), 300);
      });

      this.stopObserver.observe(docEl, {
        childList: true,
        subtree: true,
        attributes: false,
      });
    } catch {
      // Best-effort — stop-button path should never crash the main observer.
    }
  }
}
