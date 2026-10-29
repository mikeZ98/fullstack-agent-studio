import {
  type AppErrorCode,
  type ArtifactCloseEvent,
  type ArtifactDeltaEvent,
  type ArtifactEntry,
  type ArtifactLanguage,
  type ArtifactOpenEvent,
  type ArtifactState,
  type ArtifactType,
  createProblem,
  type ErrorEvent,
  type Identifier,
  LIMITS,
  type ProblemDetails,
  type StreamEvent,
} from "@/lib/schemas";

/** One sealed (complete) revision, kept for time travel and diffing. */
export interface ArtifactSnapshot {
  readonly revision: number;
  readonly messageId: Identifier;
  readonly title: string;
  readonly type: ArtifactType;
  readonly language: ArtifactLanguage;
  readonly content: string;
  readonly hash: string;
}

export interface PendingDelta {
  readonly seq: number;
  readonly delta: string;
}

/** Live state of one artifact; the working fields describe its latest revision. */
export interface ArtifactRecord {
  readonly id: Identifier;
  readonly messageId: Identifier;
  readonly revision: number;
  readonly title: string;
  readonly type: ArtifactType;
  readonly language: ArtifactLanguage;
  readonly state: ArtifactState;
  readonly content: string;
  /** Next delta `seq` that can be appended. */
  readonly nextSeq: number;
  /** Deltas that arrived ahead of `nextSeq`, sorted by `seq`. */
  readonly pending: readonly PendingDelta[];
  /** Content was cut at LIMITS.artifactContentChars. */
  readonly truncated: boolean;
  readonly error?: ProblemDetails;
  /** The sealed revision failed security inspection; it may never be reopened. */
  readonly quarantined?: true;
  /** Sealed revisions, oldest first, at most LIMITS.artifactHistory. */
  readonly history: readonly ArtifactSnapshot[];
}

export type ArtifactDiagnosticCode =
  | "unknown-artifact"
  | "duplicate-open"
  | "revision-in-progress"
  | "unexpected-revision"
  | "not-streaming"
  | "duplicate-delta"
  | "reorder-overflow"
  | "content-truncated"
  | "missing-deltas"
  | "integrity-mismatch"
  | "interrupted"
  | "quarantined";

/** Why an event was rejected or an artifact failed; bounded to LIMITS.diagnostics. */
export interface ArtifactDiagnostic {
  readonly code: ArtifactDiagnosticCode;
  readonly artifactId: Identifier;
  readonly revision: number;
  readonly message: string;
}

export interface ArtifactStoreState {
  /** Keyed by artifact id; look up with `selectArtifact`, never by bare indexing. */
  readonly artifacts: Readonly<Record<Identifier, ArtifactRecord>>;
  /** Artifact ids in the order they were first opened. */
  readonly order: readonly Identifier[];
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

/** Synthetic action: the transport ended before the message finished. */
export interface StreamAbortedAction {
  type: "stream-aborted";
  /** Limit to artifacts of this message; all streaming artifacts when absent. */
  messageId?: Identifier;
}

/**
 * Synthetic action: a sealed revision failed security inspection. It must never run, so
 * it moves to `error` and its snapshot is dropped from the history.
 */
export interface ArtifactQuarantinedAction {
  type: "artifact-quarantined";
  artifactId: Identifier;
  revision: number;
  problem: ProblemDetails;
}

export type ArtifactStoreAction = StreamEvent | StreamAbortedAction | ArtifactQuarantinedAction;

export const INITIAL_ARTIFACT_STORE: ArtifactStoreState = {
  artifacts: {},
  order: [],
  diagnostics: [],
};

/**
 * 32-bit FNV-1a over UTF-16 code units, as 8 hex digits. A fast, synchronous fingerprint
 * for change detection and diffing; not a cryptographic integrity guarantee.
 */
export function contentHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function selectArtifact(
  state: ArtifactStoreState,
  id: Identifier,
): ArtifactRecord | undefined {
  // Own-property check: "constructor" or "toString" are valid ids, not inherited members.
  return Object.hasOwn(state.artifacts, id) ? state.artifacts[id] : undefined;
}

export function selectArtifacts(state: ArtifactStoreState): ArtifactRecord[] {
  return state.order.flatMap((id) => selectArtifact(state, id) ?? []);
}

export function selectSnapshot(
  state: ArtifactStoreState,
  id: Identifier,
  revision: number,
): ArtifactSnapshot | undefined {
  return selectArtifact(state, id)?.history.find((snapshot) => snapshot.revision === revision);
}

/** The Phase 2 wire/UI contract view of a record. */
export function toArtifactEntry(record: ArtifactRecord): ArtifactEntry {
  const { id, revision, title, type, language, content, state, error } = record;
  const artifact = { id, revision, title, type, language, content };
  return error === undefined ? { artifact, state } : { artifact, state, error };
}

// --- internals ---------------------------------------------------------------------------

function diagnose(
  state: ArtifactStoreState,
  code: ArtifactDiagnosticCode,
  artifactId: Identifier,
  revision: number,
  message: string,
): ArtifactStoreState {
  const diagnostics = [...state.diagnostics, { code, artifactId, revision, message }];
  return { ...state, diagnostics: diagnostics.slice(-LIMITS.diagnostics) };
}

function put(state: ArtifactStoreState, record: ArtifactRecord): ArtifactStoreState {
  const isNew = !Object.hasOwn(state.artifacts, record.id);
  return {
    ...state,
    artifacts: { ...state.artifacts, [record.id]: record },
    order: isNew ? [...state.order, record.id] : state.order,
  };
}

function fail(
  state: ArtifactStoreState,
  record: ArtifactRecord,
  code: ArtifactDiagnosticCode,
  errorCode: AppErrorCode,
  detail: string,
  overrides: Partial<ArtifactRecord> = {},
): ArtifactStoreState {
  const error = createProblem(errorCode, { detail });
  const failed: ArtifactRecord = { ...record, ...overrides, state: "error", pending: [], error };
  return diagnose(put(state, failed), code, record.id, record.revision, detail);
}

/** Drop a dangling high surrogate so truncation never leaves half a character. */
function cutAt(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function onOpen(state: ArtifactStoreState, event: ArtifactOpenEvent): ArtifactStoreState {
  const { artifactId: id, revision, messageId, title, artifactType: type, language } = event;
  const existing = selectArtifact(state, id);
  const expected = existing === undefined ? 1 : existing.revision + 1;

  // A revision that broke off mid-stream may be sent again from the start (a retried or
  // regenerated response). Anything else, including a quarantined revision, is a replay.
  const restart =
    existing?.revision === revision && existing.state === "error" && existing.quarantined !== true;
  if (existing?.revision === revision && !restart) {
    return diagnose(state, "duplicate-open", id, revision, `Revision ${revision} is already open`);
  }
  if (existing?.state === "streaming") {
    const message = `Revision ${existing.revision} is still streaming`;
    return diagnose(state, "revision-in-progress", id, revision, message);
  }
  if (revision !== expected && !restart) {
    const message = `Expected revision ${expected}, got ${revision}`;
    return diagnose(state, "unexpected-revision", id, revision, message);
  }
  return put(state, {
    id,
    messageId,
    revision,
    title,
    type,
    language,
    state: "streaming",
    content: "",
    nextSeq: 0,
    pending: [],
    truncated: false,
    history: existing?.history ?? [],
  });
}

/** Look up the record an event targets, or explain why it cannot apply. */
function target(
  state: ArtifactStoreState,
  event: ArtifactDeltaEvent | ArtifactCloseEvent,
): { record: ArtifactRecord } | { rejected: ArtifactStoreState } {
  const { artifactId: id, revision } = event;
  const record = selectArtifact(state, id);
  if (record === undefined) {
    return {
      rejected: diagnose(state, "unknown-artifact", id, revision, "Artifact was never opened"),
    };
  }
  if (record.revision !== revision) {
    const message = `Event for revision ${revision}, current is ${record.revision}`;
    return { rejected: diagnose(state, "unexpected-revision", id, revision, message) };
  }
  if (record.state !== "streaming") {
    const message = `Revision ${revision} is ${record.state}; ${event.type} ignored`;
    return { rejected: diagnose(state, "not-streaming", id, revision, message) };
  }
  return { record };
}

function onDelta(state: ArtifactStoreState, event: ArtifactDeltaEvent): ArtifactStoreState {
  const found = target(state, event);
  if ("rejected" in found) return found.rejected;
  const { record } = found;
  const { seq, delta } = event;

  if (seq < record.nextSeq || record.pending.some((p) => p.seq === seq)) {
    const message = `Delta ${seq} was already received`;
    return diagnose(state, "duplicate-delta", record.id, record.revision, message);
  }
  if (seq - record.nextSeq > LIMITS.reorderWindow) {
    const detail = `Delta ${seq} is too far ahead of ${record.nextSeq}; deltas were lost`;
    return fail(state, record, "reorder-overflow", "stream_interrupted", detail);
  }
  if (seq > record.nextSeq) {
    // Buffered deltas count toward the size limit too, so a gap cannot grow memory unbounded.
    const buffered = record.pending.reduce((sum, p) => sum + p.delta.length, delta.length);
    if (record.content.length + buffered > LIMITS.artifactContentChars) {
      const detail = `Buffered deltas exceed ${LIMITS.artifactContentChars} characters`;
      return fail(state, record, "reorder-overflow", "validation_failed", detail);
    }
    const pending = [...record.pending, { seq, delta }].sort((a, b) => a.seq - b.seq);
    return put(state, { ...record, pending });
  }

  // In order: append, then drain every buffered delta that is now contiguous.
  let content = record.content + delta;
  let nextSeq = seq + 1;
  let pending = record.pending;
  for (let head = pending[0]; head?.seq === nextSeq; head = pending[0]) {
    content += head.delta;
    nextSeq++;
    pending = pending.slice(1);
  }

  if (content.length > LIMITS.artifactContentChars) {
    const detail = `Artifact exceeds ${LIMITS.artifactContentChars} characters; content truncated`;
    return fail(state, record, "content-truncated", "validation_failed", detail, {
      content: cutAt(content, LIMITS.artifactContentChars),
      nextSeq,
      truncated: true,
    });
  }
  return put(state, { ...record, content, nextSeq, pending });
}

function onClose(state: ArtifactStoreState, event: ArtifactCloseEvent): ArtifactStoreState {
  const found = target(state, event);
  if ("rejected" in found) return found.rejected;
  const { record } = found;

  const [firstPending] = record.pending;
  if (firstPending !== undefined) {
    const detail = `Deltas ${record.nextSeq}-${firstPending.seq - 1} never arrived`;
    return fail(state, record, "missing-deltas", "stream_interrupted", detail);
  }
  if (event.contentLength !== undefined && event.contentLength !== record.content.length) {
    const detail = `Expected ${event.contentLength} characters, assembled ${record.content.length}`;
    return fail(state, record, "integrity-mismatch", "stream_interrupted", detail);
  }

  const { revision, messageId, title, type, language, content } = record;
  const snapshot = {
    revision,
    messageId,
    title,
    type,
    language,
    content,
    hash: contentHash(content),
  };
  const history = [...record.history, snapshot].slice(-LIMITS.artifactHistory);
  return put(state, { ...record, state: "complete", history });
}

/** Fail every streaming artifact matching `messageId` (all when undefined). */
function interrupt(
  state: ArtifactStoreState,
  messageId: Identifier | undefined,
  build: () => ProblemDetails,
): ArtifactStoreState {
  let next = state;
  for (const record of selectArtifacts(state)) {
    if (record.state !== "streaming") continue;
    if (messageId !== undefined && record.messageId !== messageId) continue;
    const error = build();
    next = put(next, { ...record, state: "error", pending: [], error });
    next = diagnose(next, "interrupted", record.id, record.revision, error.detail ?? error.title);
  }
  return next;
}

function onError(state: ArtifactStoreState, event: ErrorEvent): ArtifactStoreState {
  return interrupt(state, event.messageId, () => event.error);
}

function onQuarantine(
  state: ArtifactStoreState,
  action: ArtifactQuarantinedAction,
): ArtifactStoreState {
  const record = selectArtifact(state, action.artifactId);
  // Only the sealed revision that was inspected; a newer revision supersedes the verdict.
  if (record === undefined || record.revision !== action.revision || record.state !== "complete") {
    return state;
  }
  const history = record.history.filter((snapshot) => snapshot.revision !== action.revision);
  const quarantined: ArtifactRecord = {
    ...record,
    state: "error",
    error: action.problem,
    quarantined: true,
    history,
  };
  const message = action.problem.detail ?? action.problem.title;
  return diagnose(put(state, quarantined), "quarantined", record.id, record.revision, message);
}

function interruptedProblem(detail: string) {
  return () => createProblem("stream_interrupted", { detail });
}

/**
 * Pure artifact lifecycle reducer. Unrelated events return the same state object, so
 * consumers can rely on referential equality to skip work.
 */
export function artifactReducer(
  state: ArtifactStoreState,
  action: ArtifactStoreAction,
): ArtifactStoreState {
  switch (action.type) {
    case "artifact-open":
      return onOpen(state, action);
    case "artifact-delta":
      return onDelta(state, action);
    case "artifact-close":
      return onClose(state, action);
    case "error":
      return onError(state, action);
    case "finish-message":
      return interrupt(
        state,
        action.messageId,
        interruptedProblem("The message finished before the artifact was closed"),
      );
    case "stream-aborted":
      return interrupt(
        state,
        action.messageId,
        interruptedProblem("The stream ended before the artifact was closed"),
      );
    case "artifact-quarantined":
      return onQuarantine(state, action);
    default:
      return state;
  }
}
