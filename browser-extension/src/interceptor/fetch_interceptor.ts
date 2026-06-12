// fetch_interceptor.ts — injected into the MAIN world via chrome.scripting.executeScript.
//
// Wraps window.fetch and XMLHttpRequest to observe SSE stream completion without
// touching page data.  Posts a window.postMessage when any streaming response
// from a known AI endpoint drains its ReadableStream.
//
// IMPORTANT: This file is compiled as a separate IIFE bundle (no imports/exports)
// and injected via the service worker.  Do NOT import from other source files.
//
// Security: messages are validated in StreamInterceptorBridge (content-script side)
// using evt.source === window before being acted on.

(function () {
  const MSG_TYPE = 'ML_STREAM_COMPLETE';

  // Patterns that identify streaming AI inference endpoints.
  // Using string .includes() — no regex to keep the injected script tiny.
  const STREAM_URL_PATTERNS = [
    '/backend-api/conversation',      // ChatGPT
    '/api/append_message',            // Claude.ai (legacy)
    '/api/organizations/',            // Claude.ai (modern, SSE)
    '/streaming/message',             // Gemini
    'streamGenerateContent',          // Gemini (newer)
    '/chat/completions',              // OpenAI-compat (DeepSeek, Mistral, etc.)
    '/v1/messages',                   // Claude API
    '/v1beta/models/',                // Gemini API
    '/grok-api/responses',            // Grok
    '/api/chat',                      // generic (Meta AI, Bing Copilot)
  ];

  function isStreamingUrl(url: string): boolean {
    for (const p of STREAM_URL_PATTERNS) {
      if (url.includes(p)) return true;
    }
    return false;
  }

  function postComplete(url: string): void {
    window.postMessage({ type: MSG_TYPE, url, ts: performance.now() }, '*');
  }

  // ── Fetch wrapper ─────────────────────────────────────────────────────────────

  const _originalFetch = window.fetch.bind(window);

  (window as Window & { fetch: typeof fetch }).fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

    const response = await _originalFetch(input, init);

    if (!isStreamingUrl(url)) return response;
    if (!response.body) return response;

    // Tee the stream: one branch goes to the page (original), one we drain to
    // detect when the SSE body is fully consumed.
    const [pageStream, observerStream] = response.body.tee();

    // Drain the observer branch silently.
    const reader = observerStream.getReader();
    (async () => {
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
        postComplete(url);
      } catch {
        // Stream aborted or network error — not a clean completion, skip signal.
      } finally {
        reader.releaseLock();
      }
    })();

    // Return a new Response backed by the page's stream branch.
    return new Response(pageStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  // ── XHR wrapper ───────────────────────────────────────────────────────────────
  // Some providers still use XHR with readyState 3 (LOADING) chunked responses.

  const _originalOpen = XMLHttpRequest.prototype.open;
  const _originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    (this as XMLHttpRequest & { _mlUrl?: string })._mlUrl = url.toString();
    return (_originalOpen as Function).call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
    const self = this as XMLHttpRequest & { _mlUrl?: string };
    const url = self._mlUrl ?? '';

    if (isStreamingUrl(url)) {
      self.addEventListener('loadend', () => {
        if (self.readyState === 4) postComplete(url);
      });
    }

    return _originalSend.call(this, body);
  };
})();
