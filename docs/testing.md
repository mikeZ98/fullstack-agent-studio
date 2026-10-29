# Testing, chaos findings and coverage

The test suite is the specification. It runs in memory: no test opens a socket, resolves a
name, listens on a port or starts a process, and that is enforced rather than assumed.

```bash
pnpm test     # 1,300+ tests with v8 coverage and per-module thresholds
pnpm verify   # lint → typecheck → test → attribution audit (what CI runs)
```

- [Test matrix](#test-matrix)
- [Coverage](#coverage)
- [Hermetic isolation](#hermetic-isolation)
- [Golden workflows](#golden-workflows)
- [Chaos findings](#chaos-findings)
- [Stress and concurrency](#stress-and-concurrency)
- [Specs as code](#specs-as-code)
- [Flakiness policy](#flakiness-policy)

## Test matrix

Counts are from the run that produced this document (Vitest JSON reporter, 2026-10-29):
1,390 tests in 49 files, all passing.

| Area                                      | Location                                                                                                                                            | Tests | Highlights                                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------- |
| Schemas and contracts                     | `src/lib/schemas/`, `tests/contracts.test.ts`                                                                                                       |   399 | Every contract accepts valid data and rejects malformed, oversized and hostile input; types are always inferred from schemas |
| Core reducers and stream engine           | `src/lib/core/`                                                                                                                                     |   221 | Reordering, duplicates, gaps, integrity, revisions, restart after interruption, tab LRU, SSE framing edge cases              |
| Streaming tools and routes                | `src/lib/tools/`, `src/app/`, `src/instrumentation.test.ts`                                                                                         |   135 | Retries, timeouts, backpressure, disconnects, RFC 9457 mapping, health and mock-agent routes, boot validation                |
| Guardrails and runner                     | `src/lib/guardrails/`, `src/lib/runner/`                                                                                                            |   240 | Jailbreak and smuggling screens, sinks and XSS, critic loop bounds, watchdog, CSP and preview documents                      |
| UI components                             | `src/components/`                                                                                                                                   |   124 | Chat, canvas, tabs, revisions, refusals, previews, watchdog UI, keyboard and accessibility contracts                         |
| End to end, chaos and stress              | `tests/e2e-*`, `tests/chaos-*`, `tests/stress-*`                                                                                                    |    48 | Full pipeline through the real handler; faults injected at every layer                                                       |
| Container, CI, docs, config and isolation | `tests/docker.test.ts`, `tests/ci.test.ts`, `tests/docs.test.ts`, `tests/config.test.ts`, `tests/hermetic-isolation.test.ts`, `src/lib/env.test.ts` |   223 | Dockerfile, compose, workflow, documentation links and snippets, repository invariants, the network guard                    |

## Coverage

`pnpm test` fails below 90 % branches, functions, lines or statements, both overall and for
each module separately, so a well-covered module cannot mask a weak one.

| Module               |   Branches |      Lines |
| -------------------- | ---------: | ---------: |
| `src/lib/schemas`    |     99.2 % |      100 % |
| `src/lib/core`       |     96.9 % |      100 % |
| `src/lib/tools`      |     96.8 % |     99.5 % |
| `src/lib/guardrails` |     94.4 % |     99.7 % |
| `src/lib/runner`     |      100 % |      100 % |
| `src/components`     |     98.1 % |     99.7 % |
| **All files**        | **96.8 %** | **99.8 %** |

## Hermetic isolation

[`tests/setup/network-guard.ts`](../tests/setup/network-guard.ts) is the first setup file. It
blocks and records outbound TCP (which covers `fetch`, `http`, `https`, `http2`, `tls`,
WebSocket and jsdom's XHR), listening servers, UDP, every DNS API and subprocesses. A test that
attempts any of these fails, even if the code under test swallowed the error.
[`tests/hermetic-isolation.test.ts`](../tests/hermetic-isolation.test.ts) proves each block,
proves that jsdom never fetches `src`/`href` resources, and statically audits the suite: every
test file runs under the guard, nothing patches network primitives or reads the guard's ledger,
and every agent endpoint in the tests is a non-routable host.

Tests reach the network-shaped code through in-memory doubles: the deterministic mock agent,
scripted agents, and fault injectors that drop sockets, stall, or corrupt bytes
([`tests/fixtures/agent.ts`](../tests/fixtures/agent.ts)).

## Golden workflows

[`tests/e2e-studio-pipeline.test.tsx`](../tests/e2e-studio-pipeline.test.tsx) drives `<Studio>`
through the AI SDK's real `DefaultChatTransport` into the real `/api/chat` handler
([`tests/fixtures/pipeline.ts`](../tests/fixtures/pipeline.ts)).

- **One full round trip**, frozen mid-artifact to check the live state (streaming reply, tool
  results, docked tab with a spinner, live code, no premature preview), then released to check
  the sealed state (sandboxed preview, closed upstream body).
- **Multi-turn**: a React counter, then a Mermaid diagram, then an HTML page; tab order, focus,
  keyboard tab management and the history sent upstream.
- **Revision time travel**: pin v1, keep the pin while v4 streams in, hop to v2, unpin to live.

## Chaos findings

[`tests/chaos-resilience.test.ts`](../tests/chaos-resilience.test.ts) injects faults at the
transport, protocol and content layers and checks each where it lands and where the user sees
it. No scenario may leave an unhandled promise rejection.

| Fault                                          | Result                                                                                                                                                                | Finding                                                                                                                                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Socket dropped mid-delta (undici `terminated`) | Dispatcher ends `failed` with `stream_interrupted`; the bridge ends the UI stream in-band; the artifact becomes an error with the deltas that arrived; Retry recovers | **Bug fixed:** a retried response re-sends the same artifact revision, which the reducer rejected as a duplicate, leaving it "Failed" forever. Interrupted revisions now restart; quarantined ones never do |
| Persistent 429 storm                           | Exponential backoff with jitter inside `[50 %, 100 %]` of the step, capped at 4 s; 50 clients retry at 50 distinct times                                              | `Retry-After` is honoured as a floor; one above 10 s is returned instead of waited for; an abort during backoff stops at once with no timers left                                                           |
| Recovering 429 storm                           | UI shows a retryable "Too many requests"; Retry succeeds once the storm passes                                                                                        | The route forwards `Retry-After`                                                                                                                                                                            |
| Corrupt SSE                                    | Truncated JSON, raw binary, mismatched `event:` names, unknown types and invalid shapes are skipped; all valid events arrive in order                                 | 200 seeded garbage schedules, byte-by-byte splits through multi-byte characters, CR/CRLF endings; ten bad frames in a row end the stream                                                                    |
| Hostile artifacts                              | 13 XSS and exfiltration payloads blocked; in the UI the artifact is quarantined, never mounted, and the critic loop stops after two repairs                           | **Gap fixed:** a bare `location = "…"` assignment slipped past the navigation rule                                                                                                                          |

## Stress and concurrency

[`tests/stress-concurrency.test.ts`](../tests/stress-concurrency.test.ts):

- **Stop and resubmit:** six rounds in the UI, plus `stop()` and `sendMessage()` in the same
  tick, with no open upstream bodies, no artifact left streaming and exact outcomes.
- **Concurrency:** 200 concurrent route requests with seeded abort points release every body;
  agent client and bridge add and remove abort listeners in balance across 200 streams; 500
  concurrent dispatcher runs report exact outcomes.
- **Capacity:** LRU eviction is exact under 5,000 seeded operations and reproducible for a
  given seed; one reply with 15 artifacts docks 12 tabs.
- **Large payloads:** 100,000-character artifacts arrive intact through the route at 1,000- and
  64,000-character deltas; the payload stays out of chat history; p95 store update < 16 ms;
  content is capped at 1,000,000 characters. Timings: [benchmarks.md](benchmarks.md).

## Specs as code

- [`tests/docker.test.ts`](../tests/docker.test.ts): Dockerfile stages, pinned digests, non-root
  user, runner contents, healthcheck, `.dockerignore` coverage of the real build context, and
  compose services, hardening and environment alignment.
- [`tests/ci.test.ts`](../tests/ci.test.ts): workflow triggers, concurrency, permissions, SHA
  pins, step order matching `pnpm verify`, cache keys, and no expression injection.
- [`tests/docs.test.ts`](../tests/docs.test.ts): every link, anchor, path and image in the
  documentation resolves; commands name real scripts; snippets parse; the assets exist and are
  safe; versions quoted in the docs match the repository.

## Flakiness policy

Tests wait for observable state (`waitFor`, explicit gates such as `holdAt` and
`stallUntilAborted`) instead of sleeping, and seed every random schedule. Suites are also run
several times concurrently to shake out timing assumptions. That practice found two problems.
A connection-drop test re-highlighted a single 20,000-character line on every delta and timed
out under load; real browsers have the same cost for long single lines. A watchdog test raced
an 80 ms timer against its own mount; it now uses timeouts that make only the intended trip
possible.

Interface checks that jsdom cannot make (layout) are covered by capturing the real UI:
[`scripts/capture-showcase.mjs`](../scripts/capture-showcase.mjs) drives headless Chromium
over the DevTools protocol. Its first run exposed a real bug: Code view scrambled any source
with blank lines. It is fixed and guarded by a structural test.
