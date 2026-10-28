import {
  type ChatRequest,
  createProblem,
  LIMITS,
  messageText,
  type ProblemDetails,
  type ValidationIssue,
} from "@/lib/schemas";

/**
 * First-line screening of user prompts. These are heuristics: the agent backend owns the
 * real policy. Their job is to normalise what reaches it and to stop the well-known,
 * low-effort injection patterns, including attempts to hide them from naive matching.
 */

export type InputViolation =
  | "empty"
  | "too-long"
  | "control-characters"
  | "invisible-characters"
  | "smuggled-text"
  | "jailbreak"
  | "role-override"
  | "system-prompt-extraction";

/** Violations that stop the message; the rest are repaired in `sanitizedText`. */
export const BLOCKING_VIOLATIONS: ReadonlySet<InputViolation> = new Set([
  "empty",
  "too-long",
  "jailbreak",
  "role-override",
  "system-prompt-extraction",
]);

export const VIOLATION_MESSAGES: Readonly<Record<InputViolation, string>> = {
  empty: "The message is empty.",
  "too-long": `The message exceeds ${LIMITS.messageTextChars} characters.`,
  "control-characters": "Control characters were removed.",
  "invisible-characters": "Invisible or direction-changing characters were removed.",
  "smuggled-text": "Hidden text encoded in invisible tag characters was removed.",
  jailbreak: "The message tries to override the assistant's instructions.",
  "role-override": "The message impersonates a system or assistant turn.",
  "system-prompt-extraction": "The message asks for the assistant's hidden instructions.",
};

export interface InputMatch {
  violation: InputViolation;
  /** Name of the rule that matched, for logs and tests. */
  rule: string;
}

export interface InputAssessment {
  allowed: boolean;
  /** Distinct violations, in a stable order. */
  violations: InputViolation[];
  /** NFKC-normalised text without control, invisible or smuggled characters. */
  sanitizedText: string;
  matches: InputMatch[];
}

// C0 controls except TAB/LF/CR, DEL and C1 controls.
const CONTROL_RE = /(?![\t\n\r])\p{Cc}/gu;
// Zero-width, word-joiner, BOM, soft hyphen, Mongolian vowel separator, bidi embeddings,
// overrides and isolates (Trojan Source), invisible math operators, interlinear
// annotations and supplementary variation selectors.
const INVISIBLE_RE =
  /[\u00AD\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|[\u{E0100}-\u{E01EF}]/gu;
// ZWJ is kept only inside emoji sequences (family, profession emoji...).
const STRAY_ZWJ_RE =
  /(?<!\p{Extended_Pictographic}\uFE0F?)\u200D|\u200D(?!\p{Extended_Pictographic})/gu;
// Unicode "tag" characters mirror ASCII invisibly and are used to smuggle instructions.
const TAG_RE = /[\u{E0000}-\u{E007F}]/gu;

/** Hidden ASCII carried by tag characters, e.g. U+E0069 U+E0067 -> "ig". */
export function decodeTagCharacters(text: string): string {
  return [...text.matchAll(TAG_RE)]
    .map(([char]) => (char.codePointAt(0) ?? 0) - 0xe0000)
    .filter((code) => code >= 0x20 && code < 0x7f)
    .map((code) => String.fromCharCode(code))
    .join("");
}

/** Letters attackers swap in to dodge keyword matching: leetspeak, Cyrillic and Greek. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "i",
  "\u0430": "a",
  "\u0435": "e",
  "\u043E": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0443": "y",
  "\u0445": "x",
  "\u0456": "i",
  "\u0458": "j",
  "\u0455": "s",
  "\u0501": "d",
  "\u0261": "g",
  "\u03BF": "o",
  "\u03B1": "a",
  "\u03B5": "e",
  "\u03B9": "i",
  "\u03BD": "v",
  "\u03C4": "t",
  "\u03BA": "k",
  "\u03C1": "p",
};

/**
 * Matching form of a text: invisibles gone, look-alikes folded, lower-case letters and
 * digits only. "I.g.n.0.r.e  previous" and "ign\u200Bore previous" both become
 * "ignoreprevious".
 */
export function skeleton(text: string): string {
  const folded = [
    ...text
      .normalize("NFKC")
      .replace(INVISIBLE_RE, "")
      .replace(/\u200D/g, "")
      .toLowerCase(),
  ]
    .map((char) => CONFUSABLES[char] ?? char)
    .join("");
  return folded.normalize("NFKD").replace(/[^a-z]/g, "");
}

/** Normalise and strip everything a prompt never legitimately needs. */
export function sanitizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(TAG_RE, "")
    .replace(CONTROL_RE, "")
    .replace(INVISIBLE_RE, "")
    .replace(STRAY_ZWJ_RE, "");
}

interface Rule {
  name: string;
  violation: InputViolation;
  pattern: RegExp;
  /** `skeleton` patterns see letters only; `text` patterns see the sanitised text. */
  on: "skeleton" | "text";
}

const ANY = "(?:all|any|every|the|your|my|of|these|those)*";

const RULES: readonly Rule[] = [
  {
    name: "ignore-previous-instructions",
    violation: "jailbreak",
    on: "skeleton",
    pattern: new RegExp(
      `(?:ignore|disregard|forget|override|bypass|skip)${ANY}(?:previous|prior|above|earlier|preceding|initial|original|system|existing)(?:instruction|rule|direction|prompt|guideline|constraint|order)`,
    ),
  },
  {
    name: "unrestricted-persona",
    violation: "jailbreak",
    on: "skeleton",
    pattern:
      /(?:youarenow|actas|pretendtobe|roleplayas|youwillnowbe|fromnowonyouare)(?:an?)?(?:dan|unrestricted|unfiltered|uncensored|jailbroken|evil|amoral)/,
  },
  {
    name: "special-mode",
    violation: "jailbreak",
    on: "skeleton",
    pattern: /(?:developer|dev|god|jailbreak|dan|sudo)mode(?:enabled|activated|on|unlocked)/,
  },
  {
    name: "answer-without-rules",
    violation: "jailbreak",
    on: "skeleton",
    pattern:
      /(?:respond|answer|reply|operate|behave|actnow)[a-z]{0,24}?(?:without|withno|ignoring)(?:any|all|your)*(?:restriction|filter|safety|guardrail|limitation|rule|censorship|contentpolic)/,
  },
  {
    name: "reveal-system-prompt",
    violation: "system-prompt-extraction",
    on: "skeleton",
    pattern:
      /(?:reveal|show|print|repeat|output|display|leak|dump|tellme|giveme|recite|whatis|whatare|whatwere|share)(?:me|us)?(?:your|the)(?:full|entire|exact|original|hidden|secret|initial|complete)*(?:system|developer|hidden|initial|original|secret|internal)(?:prompt|instruction|message|rule|directive)/,
  },
  {
    name: "repeat-text-above",
    violation: "system-prompt-extraction",
    on: "skeleton",
    pattern:
      /(?:repeat|print|output|copy|reproduce)(?:all|everything|thetext|thewords|whatever|verbatim)+(?:written|stated)?(?:above|beforethis|beforemymessage)/,
  },
  {
    name: "role-marker-line",
    violation: "role-override",
    on: "text",
    pattern:
      /^[ \t]*(?:#{1,6}[ \t]*)?(?:system|assistant|developer)(?:[ \t]+(?:prompt|message))?[ \t]*:/im,
  },
  {
    name: "chat-template-token",
    violation: "role-override",
    on: "text",
    pattern:
      /<\|(?:im_start|im_end|system|user|assistant|endoftext|start_header_id|end_header_id|eot_id)\|>|\[\/?INST\]|<<\/?SYS>>/i,
  },
  {
    name: "new-instructions-header",
    violation: "role-override",
    on: "text",
    pattern:
      /^[ \t]*(?:new|updated|revised|override|real)[ \t]+(?:system[ \t]+)?instructions?[ \t]*:/im,
  },
];

const VIOLATION_ORDER: readonly InputViolation[] = [
  "empty",
  "too-long",
  "control-characters",
  "invisible-characters",
  "smuggled-text",
  "jailbreak",
  "role-override",
  "system-prompt-extraction",
];

function screen(text: string, matches: InputMatch[]): void {
  const compact = skeleton(text);
  for (const rule of RULES) {
    if (rule.pattern.test(rule.on === "skeleton" ? compact : text)) {
      matches.push({ violation: rule.violation, rule: rule.name });
    }
  }
}

export interface AssessOptions {
  maxChars?: number;
}

/** Screen and sanitise one user message. Deterministic and side-effect free. */
export function assessInput(
  text: string | null | undefined,
  options: AssessOptions = {},
): InputAssessment {
  const raw = text ?? "";
  const maxChars = options.maxChars ?? LIMITS.messageTextChars;
  const matches: InputMatch[] = [];
  const found = new Set<InputViolation>();
  const flag = (violation: InputViolation, rule: string) => {
    matches.push({ violation, rule });
  };

  if (raw.length > maxChars) {
    flag("too-long", "max-chars");
    // Do not spend time screening an oversized payload; it is rejected anyway.
    return finish(raw.slice(0, maxChars));
  }

  const smuggled = decodeTagCharacters(raw);
  if (smuggled !== "") flag("smuggled-text", "tag-characters");
  CONTROL_RE.lastIndex = 0;
  if (CONTROL_RE.test(raw)) flag("control-characters", "control-characters");
  INVISIBLE_RE.lastIndex = 0;
  STRAY_ZWJ_RE.lastIndex = 0;
  if (INVISIBLE_RE.test(raw) || STRAY_ZWJ_RE.test(raw))
    flag("invisible-characters", "invisible-characters");

  const sanitized = sanitizeText(raw);
  if (sanitized.trim() === "") flag("empty", "empty");
  screen(sanitized, matches);
  if (smuggled !== "") screen(smuggled, matches);
  return finish(sanitized);

  function finish(sanitizedText: string): InputAssessment {
    for (const match of matches) found.add(match.violation);
    const violations = VIOLATION_ORDER.filter((violation) => found.has(violation));
    const allowed = !violations.some((violation) => BLOCKING_VIOLATIONS.has(violation));
    return { allowed, violations, sanitizedText, matches };
  }
}

export type GuardedChatRequest =
  | { ok: true; request: ChatRequest }
  | { ok: false; problem: ProblemDetails };

/**
 * Server-side gate for /api/chat: sanitise every text part, and reject the request when
 * any user turn (including forged history) trips a blocking rule.
 */
export function guardChatRequest(request: ChatRequest): GuardedChatRequest {
  const errors: ValidationIssue[] = [];
  const messages = request.messages.map((message, index) => {
    if (message.role === "user") {
      const assessment = assessInput(messageText(message));
      for (const violation of assessment.violations) {
        if (BLOCKING_VIOLATIONS.has(violation)) {
          errors.push({ path: `messages[${index}]`, message: VIOLATION_MESSAGES[violation] });
        }
      }
    }
    const parts = message.parts.map((part) =>
      "text" in part ? { ...part, text: sanitizeText(part.text) } : part,
    );
    return { ...message, parts };
  });

  if (errors.length > 0) {
    return {
      ok: false,
      problem: createProblem("input_rejected", {
        detail: errors[0]?.message ?? "The message was rejected.",
        errors: errors.slice(0, LIMITS.problemErrors),
      }),
    };
  }
  return { ok: true, request: { ...request, messages } };
}
