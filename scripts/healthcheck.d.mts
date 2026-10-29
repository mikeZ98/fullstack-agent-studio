export declare const DEFAULT_TIMEOUT_MS: number;

export declare function healthUrl(env?: Readonly<Record<string, string | undefined>>): string;

export declare function probe(options: {
  url: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}): Promise<boolean>;
