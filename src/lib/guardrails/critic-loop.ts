import { z } from "zod";

import {
  ArtifactLanguageSchema,
  ArtifactTypeSchema,
  IdentifierSchema,
  LIMITS,
  RevisionSchema,
} from "@/lib/schemas";

import { type ArtifactInspection, isBlocking } from "./artifact-guardrails";

/**
 * Critic fallback: when an artifact is rejected (it does not compile, or trips a
 * guardrail), describe exactly what is wrong and ask the agent for a corrected revision.
 * Automatic repairs are bounded per chain: a repair whose result fails again counts
 * against the same budget, even when the agent answers with a new artifact id.
 */

export const MAX_REPAIR_ATTEMPTS = LIMITS.repairAttempts;
/** Defects quoted in one repair request; the most severe come first. */
export const MAX_REPORTED_DEFECTS = 10;

export const CriticDefectSchema = z.strictObject({
  rule: z.string().min(1),
  severity: z.enum(["critical", "high", "medium"]),
  line: z.int().min(1),
  column: z.int().min(1),
  message: z.string().min(1),
  excerpt: z.string(),
});
export type CriticDefect = z.infer<typeof CriticDefectSchema>;

export const CriticFeedbackSchema = z.strictObject({
  artifactId: IdentifierSchema,
  revision: RevisionSchema,
  title: z.string().min(1),
  artifactType: ArtifactTypeSchema,
  language: ArtifactLanguageSchema,
  /** 1-based attempt number within the current repair chain. */
  attempt: z.int().min(1).max(MAX_REPAIR_ATTEMPTS),
  maxAttempts: z.literal(MAX_REPAIR_ATTEMPTS),
  defects: z.array(CriticDefectSchema).min(1).max(MAX_REPORTED_DEFECTS),
});
export type CriticFeedback = z.infer<typeof CriticFeedbackSchema>;

export interface CriticSubject {
  id: string;
  revision: number;
  title: string;
  type: CriticFeedback["artifactType"];
  language: string;
}

/**
 * Typed repair payload for a failed inspection, or null when nothing in it is worth a
 * repair (no defect of medium severity or above, or the inspection passed).
 */
export function buildCriticFeedback(
  artifact: CriticSubject,
  inspection: ArtifactInspection,
  attempt: number,
): CriticFeedback | null {
  if (inspection.passed) return null;
  const defects = inspection.defects
    .filter((defect) => defect.severity !== "low")
    .slice(0, MAX_REPORTED_DEFECTS)
    .map(({ rule, severity, line, column, message, excerpt }) => ({
      rule,
      severity: severity as CriticDefect["severity"],
      line,
      column,
      message,
      excerpt,
    }));
  if (defects.length === 0 || !inspection.defects.some(isBlocking)) return null;
  return CriticFeedbackSchema.parse({
    artifactId: artifact.id,
    revision: artifact.revision,
    title: artifact.title,
    artifactType: artifact.type,
    language: artifact.language,
    attempt,
    maxAttempts: MAX_REPAIR_ATTEMPTS,
    defects,
  });
}

/** Marker that opens every automatic repair request (also used to recognise them). */
export const REPAIR_MARKER = "[Artifact repair request";

/** The message sent to the agent. Pure: the same feedback always yields the same text. */
export function formatRepairMessage(feedback: CriticFeedback): string {
  const { artifactId, revision, title, artifactType, attempt, maxAttempts, defects } = feedback;
  const issues = defects.map((defect, index) => {
    const head = `${index + 1}. Line ${defect.line}, column ${defect.column} [${defect.severity}] ${defect.rule}: ${defect.message}`;
    return defect.excerpt === "" ? head : `${head}\n   > ${defect.excerpt}`;
  });
  return [
    `${REPAIR_MARKER} ${attempt}/${maxAttempts}]`,
    `The ${artifactType} artifact "${title}" (id ${artifactId}, revision ${revision}) was blocked before it could run:`,
    "",
    ...issues,
    "",
    `Please fix these issues and send the complete corrected artifact as revision ${revision + 1} of ${artifactId}.`,
    "Keep all existing functionality, layout and behaviour; change only what is needed to resolve the issues above.",
  ].join("\n");
}

export interface RepairLedger {
  /** Automatic repair requests sent since the user last wrote a message themselves. */
  readonly attempts: number;
  /** `id@revision` of every artifact revision a repair was already requested for. */
  readonly requested: readonly string[];
}

export const EMPTY_REPAIR_LEDGER: RepairLedger = { attempts: 0, requested: [] };

export type RepairDecision =
  | { action: "repair"; feedback: CriticFeedback; message: string; ledger: RepairLedger }
  | { action: "skip"; reason: "already-requested" | "nothing-to-repair"; ledger: RepairLedger }
  | { action: "give-up"; reason: "budget-exhausted"; ledger: RepairLedger };

/**
 * Decide whether to ask for a repair. Idempotent per artifact revision: planning twice for
 * the same revision never sends a second request or spends budget twice.
 */
export function planRepair(
  ledger: RepairLedger,
  artifact: CriticSubject,
  inspection: ArtifactInspection,
): RepairDecision {
  const key = `${artifact.id}@${artifact.revision}`;
  if (ledger.requested.includes(key))
    return { action: "skip", reason: "already-requested", ledger };
  if (ledger.attempts >= MAX_REPAIR_ATTEMPTS) {
    return { action: "give-up", reason: "budget-exhausted", ledger };
  }
  const feedback = buildCriticFeedback(artifact, inspection, ledger.attempts + 1);
  if (feedback === null) return { action: "skip", reason: "nothing-to-repair", ledger };
  return {
    action: "repair",
    feedback,
    message: formatRepairMessage(feedback),
    ledger: { attempts: ledger.attempts + 1, requested: [...ledger.requested, key] },
  };
}
