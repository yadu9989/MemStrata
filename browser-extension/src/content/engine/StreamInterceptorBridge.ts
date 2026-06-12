// StreamInterceptorBridge — content-script side of the SSE Interceptor (Tier 1).
//
// Responsibilities:
//   1. Asks the service worker to inject fetch_interceptor.js into the MAIN world
//      (content scripts cannot call chrome.scripting directly).
//   2. Listens for ML_STREAM_COMPLETE postMessages from the injected script.
//   3. Notifies the most-recently-registered StreamWatcher callback so it can
//      arm a short settle timer instead of waiting for the full debounce.
//
// Origin validation: only messages from window itself (evt.source === window)
// with the correct type string are processed, preventing spoofing from iframes
// or malicious page scripts.

export class StreamInterceptorBridge {
  private readonly _listener: (evt: MessageEvent) => void;
  private _onStreamComplete: (() => void) | null = null;
  private _injected = false;

  constructor() {
    this._listener = (evt: MessageEvent) => {
      if (evt.source !== window) return;
      if (!evt.data || evt.data.type !== 'ML_STREAM_COMPLETE') return;
      this._onStreamComplete?.();
    };
    window.addEventListener('message', this._listener);
  }

  /**
   * Register the currently active StreamWatcher's completion callback.
   * Called by universal_content_script when a node is promoted to streaming.
   * Pass null to deregister (e.g., after the watcher fires or is disposed).
   */
  setActiveWatcher(cb: (() => void) | null): void {
    this._onStreamComplete = cb;
  }

  /**
   * Inject fetch_interceptor.js into the MAIN world via the service worker.
   * Idempotent — subsequent calls are no-ops once injection has succeeded.
   */
  async inject(): Promise<void> {
    if (this._injected) return;
    try {
      await chrome.runtime.sendMessage({ type: 'INJECT_FETCH_INTERCEPTOR' });
      this._injected = true;
    } catch {
      // Service worker offline or scripting permission missing — bridge stays
      // functional without Tier 1; Tier 2 (flatline) and Tier 1.5 (stop-button)
      // handle completion independently.
    }
  }

  dispose(): void {
    window.removeEventListener('message', this._listener);
    this._onStreamComplete = null;
  }
}
