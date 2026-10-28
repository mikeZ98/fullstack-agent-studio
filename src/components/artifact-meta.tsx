import {
  Atom,
  CircleAlert,
  CircleCheck,
  CodeXml,
  FileText,
  Globe,
  Image,
  LoaderCircle,
  Workflow,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";

import type { ArtifactState, ArtifactType } from "@/lib/schemas";

import { Badge, type BadgeTone } from "./ui/badge";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export const ARTIFACT_ICONS: Readonly<Record<ArtifactType, Icon>> = {
  html: Globe,
  svg: Image,
  react: Atom,
  markdown: FileText,
  mermaid: Workflow,
  code: CodeXml,
};

export const ARTIFACT_TYPE_LABELS: Readonly<Record<ArtifactType, string>> = {
  html: "HTML",
  svg: "SVG",
  react: "React",
  markdown: "Markdown",
  mermaid: "Diagram",
  code: "Code",
};

const STATUS: Readonly<Record<ArtifactState, { label: string; tone: BadgeTone; icon: Icon }>> = {
  idle: { label: "Waiting", tone: "neutral", icon: LoaderCircle },
  streaming: { label: "Generating", tone: "info", icon: LoaderCircle },
  complete: { label: "Ready", tone: "success", icon: CircleCheck },
  error: { label: "Failed", tone: "danger", icon: CircleAlert },
};

export function ArtifactStatusBadge({ state }: { state: ArtifactState }) {
  const { label, tone, icon: StatusIcon } = STATUS[state];
  return (
    <Badge tone={tone} data-state={state}>
      <StatusIcon
        aria-hidden
        className={state === "streaming" ? "size-3 animate-spin" : "size-3"}
      />
      {label}
    </Badge>
  );
}
