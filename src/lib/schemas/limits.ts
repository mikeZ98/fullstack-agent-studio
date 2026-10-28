/**
 * Hard upper bounds for every untrusted payload. They cap memory and render cost on the
 * client no matter what the upstream agent sends.
 */
export const LIMITS = {
  /** Identifiers (artifact, message, tool call ids). */
  idLength: 128,
  titleLength: 200,
  languageLength: 32,
  descriptionLength: 500,
  tagLength: 32,
  tags: 16,
  /** Assembled artifact source, in UTF-16 code units. */
  artifactContentChars: 1_000_000,
  /** One streamed text or artifact delta, in UTF-16 code units. */
  deltaChars: 64_000,
  /** One raw SSE frame / JSON event, in UTF-8 bytes. */
  frameBytes: 1_048_576,
  /** Nesting depth of free-form JSON (tool inputs and outputs). */
  jsonDepth: 32,
  toolNameLength: 64,
  modelNameLength: 128,
  canvasTabs: 12,
  problemTitleLength: 200,
  problemDetailLength: 4_000,
  problemErrors: 50,
  uriLength: 2_048,
  issuePathLength: 256,
  issueMessageLength: 500,
  /** Out-of-order artifact deltas buffered while waiting for a gap to fill. */
  reorderWindow: 256,
  /** Sealed revisions kept per artifact for time travel and diffing. */
  artifactHistory: 20,
  /** Rejected-event diagnostics kept by the artifact store. */
  diagnostics: 50,
  /** Malformed frames in a row before the stream is abandoned. */
  consecutiveParseErrors: 10,
  /** Findings reported per sanitized artifact. */
  sanitizerFindings: 100,
  /** Chat API request body, in bytes. */
  requestBodyBytes: 1_048_576,
  /** Messages in one chat request. */
  chatMessages: 200,
  /** Parts in one chat message. */
  messageParts: 500,
  /** Text of one message part. */
  messageTextChars: 100_000,
  /** All text across the conversation history. */
  chatHistoryChars: 400_000,
  /** Upstream error body read to build a problem, in bytes. */
  upstreamErrorBytes: 65_536,
} as const;
