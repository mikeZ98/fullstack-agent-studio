import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

import { CodeView } from "./code-view";

/**
 * Markdown from the model or an artifact. Raw HTML is never rendered (react-markdown
 * escapes it), and unsafe link protocols are stripped by its default URL transform.
 */
const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-600 underline underline-offset-2 dark:text-blue-400"
    />
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ node: _node, className, children, ...props }) => {
    const language = /language-([\w+#.-]+)/.exec(className ?? "")?.[1];
    const text = String(children ?? "");
    // Fenced blocks carry a language class or span lines; everything else is inline code.
    if (language !== undefined || text.includes("\n")) {
      return (
        <CodeView
          code={text.replace(/\n$/, "")}
          language={language ?? "plain"}
          lineNumbers={false}
          className="my-3 rounded-md border bg-muted/40 p-3"
        />
      );
    }
    return (
      <code {...props} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
        {children}
      </code>
    );
  },
};

export interface MarkdownProps {
  source: string;
  className?: string;
}

export function Markdown({ source, className }: MarkdownProps) {
  return (
    <div
      className={cn(
        "max-w-none text-sm leading-relaxed break-words",
        "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold",
        "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold",
        "[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:font-semibold",
        "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
        "[&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        "[&_table]:my-3 [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
