// Known streaming-indicator code points injected by AI chat UIs before or
// during token streaming.  We only block a targeted set so that legitimate
// responses (emoji-only, punctuation-only, non-Latin scripts) always pass.
//
// Keep this list small and specific — add entries only when a real provider
// injects a glyph that triggers false-positive turn recording.
const STREAMING_ARTIFACT_CODEPOINTS = new Set<number>([
  0x258B, // ▋ left seven-eighths block  (blinking cursor — ChatGPT, Claude)
  0x2588, // █ full block
  0x2589, // ▉ left seven-eighths block
  0x258A, // ▊ left three-quarters block
  0x258C, // ▌ left half block
  0x258D, // ▍ left three-eighths block
  0x258E, // ▎ left one-quarter block
  0x258F, // ▏ left one-eighth block
  0x23FA, // ⏺ black circle for record  (stop/record glyph — Gemini, Claude)
  0x23F5, // ⏵ black medium right-pointing triangle button
  0x25CF, // ● black circle             (spinner variant — Grok)
  0x2026, // … horizontal ellipsis      (loading placeholder — several providers)
]);

export class TurnExtractor {
  static extract(node: Element): string {
    const text = (node as HTMLElement).innerText || node.textContent || '';
    return TurnExtractor.clean(text);
  }

  /**
   * Returns true when *text* is a streaming artifact that should be discarded —
   * empty, whitespace-only, or composed entirely of known indicator glyphs.
   *
   * Deliberately does NOT reject emoji-only or non-Latin text.  A legitimate
   * response of "👍" or "はい" passes because those code points are not in the
   * blocklist.  Only the ~12 specific glyphs that AI UIs inject before actual
   * content renders are rejected.
   */
  static isStreamingArtifact(text: string): boolean {
    if (!text || !text.trim()) return true;
    for (const char of text) {
      const cp = char.codePointAt(0);
      if (cp === undefined) continue;
      if (cp <= 0x20) continue; // whitespace / control characters
      if (!STREAMING_ARTIFACT_CODEPOINTS.has(cp)) return false; // real content
    }
    return true; // every non-whitespace codepoint was a known artifact
  }

  private static clean(text: string): string {
    return text
      .replace(/ /g, ' ')          // non-breaking spaces → regular spaces
      .replace(/[\r\t]+/g, ' ')         // carriage returns and tabs → spaces
      .replace(/\n{3,}/g, '\n\n')       // 3+ newlines → double newline
      .trim();
  }
}
