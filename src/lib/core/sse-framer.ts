import { LIMITS } from "@/lib/schemas";

export type FramerOutput = { kind: "frame"; text: string } | { kind: "overflow" };

export interface SseFramer {
  /** Feed decoded text; returns every frame completed by it, in order. */
  push(chunk: string): FramerOutput[];
  /**
   * Signal end of input. Per the SSE spec an event without its terminating blank line is
   * not dispatched; `discardedTail` reports whether one was dropped.
   */
  finish(): { outputs: FramerOutput[]; discardedTail: boolean };
}

/**
 * Incremental splitter of an SSE text stream into frames (blocks separated by a blank line).
 *
 * Handles CRLF / CR / LF line endings, including a CRLF split across two chunks, and keeps
 * memory bounded: a frame growing past `maxFrameChars` without terminating is reported once
 * as an overflow and skipped up to its terminating blank line.
 */
export function createSseFramer(maxFrameChars: number = LIMITS.frameBytes): SseFramer {
  let buffer = "";
  let scanFrom = 0;
  let pendingCR = false;
  let skipping = false;

  function normalize(chunk: string): string {
    let text = pendingCR ? `\r${chunk}` : chunk;
    // A trailing CR may be the first half of a CRLF; decide once the next chunk arrives.
    pendingCR = text.endsWith("\r");
    if (pendingCR) text = text.slice(0, -1);
    return text.replace(/\r\n?/g, "\n");
  }

  function drain(): FramerOutput[] {
    const outputs: FramerOutput[] = [];
    for (let end = buffer.indexOf("\n\n", scanFrom); end !== -1; end = buffer.indexOf("\n\n")) {
      const text = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      scanFrom = 0;
      if (skipping) skipping = false;
      else if (text.length > maxFrameChars) outputs.push({ kind: "overflow" });
      else if (text !== "") outputs.push({ kind: "frame", text });
    }
    if (skipping) {
      // Only a lone "\n" can still be the first half of the terminating blank line.
      buffer = buffer.endsWith("\n") ? "\n" : "";
    } else if (buffer.length > maxFrameChars) {
      outputs.push({ kind: "overflow" });
      skipping = true;
      buffer = buffer.endsWith("\n") ? "\n" : "";
    }
    // Resume the next search where a delimiter could start, not from the beginning.
    scanFrom = Math.max(0, buffer.length - 1);
    return outputs;
  }

  return {
    push(chunk) {
      buffer += normalize(chunk);
      return drain();
    },
    finish() {
      if (pendingCR) {
        pendingCR = false;
        buffer += "\n";
      }
      const outputs = drain();
      const discardedTail = !skipping && buffer.trim() !== "";
      buffer = "";
      scanFrom = 0;
      skipping = false;
      return { outputs, discardedTail };
    },
  };
}
