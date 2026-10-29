"use client";

import { Highlight, Prism, themes } from "prism-react-renderer";

import { cn } from "@/lib/utils";

import { useMediaQuery } from "./hooks/use-media-query";

/** Above this size highlighting is skipped: plain text stays responsive while streaming. */
export const HIGHLIGHT_LIMIT = 200_000;

export function prismLanguage(language: string): string {
  return language in Prism.languages ? language : "plain";
}

export interface CodeViewProps {
  code: string;
  language: string;
  className?: string;
  /** Show a gutter with line numbers. */
  lineNumbers?: boolean;
}

export function CodeView({ code, language, className, lineNumbers = true }: CodeViewProps) {
  const dark = useMediaQuery("(prefers-color-scheme: dark)", false);
  const base = cn("m-0 overflow-auto p-4 font-mono text-[13px] leading-5", className);

  if (code.length > HIGHLIGHT_LIMIT) {
    return (
      <pre className={base} data-highlighted="false">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <Highlight
      code={code}
      language={prismLanguage(language)}
      theme={dark ? themes.oneDark : themes.oneLight}
    >
      {({ className: prismClass, style, tokens, getLineProps, getTokenProps }) => (
        // Theme foreground colour; the pane supplies the background.
        <pre
          className={cn(base, prismClass)}
          style={{ ...style, backgroundColor: "transparent" }}
          data-highlighted="true"
        >
          {/* An explicit table: rows inside an inline <code> would get anonymous table boxes,
              which browsers lay out unpredictably once a line is empty. */}
          <code className="table">
            {tokens.map((line, index) => {
              const { key: _lineKey, ...lineProps } = getLineProps({ line });
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and re-rendered wholesale.
                <span key={index} {...lineProps} className={cn(lineProps.className, "table-row")}>
                  {lineNumbers && (
                    <span
                      aria-hidden
                      className="table-cell pr-4 text-right text-muted-foreground/60 select-none"
                    >
                      {index + 1}
                    </span>
                  )}
                  <span className="table-cell whitespace-pre">
                    {line.map((token, tokenIndex) => {
                      const { key: _tokenKey, ...tokenProps } = getTokenProps({ token });
                      // Prism represents an empty line as a "\n" token; under white-space: pre
                      // that newline would add a second line box. A space keeps the row height.
                      const children = token.empty === true ? " " : tokenProps.children;
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional within a line.
                        <span key={tokenIndex} {...tokenProps}>
                          {children}
                        </span>
                      );
                    })}
                  </span>
                </span>
              );
            })}
          </code>
        </pre>
      )}
    </Highlight>
  );
}
