# Benchmarks

Engineering benchmarks for the streaming pipeline and the guardrails. They answer one question:
_is any stage between the agent's socket and the canvas expensive enough to matter?_ The answer
below is no; at these sizes the cost of a turn is network latency and browser rendering.

## Reproduce

```bash
pnpm bench                  # runs tests/benchmarks/ under the hermetic test setup
cat .cache/benchmarks.md    # the table below, for your machine
```

The suite ([`tests/benchmarks/pipeline.bench.ts`](../tests/benchmarks/pipeline.bench.ts)) times
each scenario with `performance.now()` over 7 rounds after a warm-up and reports the median. It
has its own config ([`vitest.bench.mts`](../vitest.bench.mts)) without coverage instrumentation,
and it is not part of `pnpm test`. Its assertions only catch order-of-magnitude regressions, so
it stays green on slow machines.

## Results

Node.js 26.3.0, macOS on Apple M4, median of 7 rounds, measured 2026-10-29.

| Scenario            | Workload                                                   | Result                                         | Notes                                             |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| SSE dispatcher      | 10,000 frames, 916 KiB, split at random byte boundaries    | 8.28 ms (≈ 1.2 M events/s)                     | Framing + JSON + schema validation of every event |
| Artifact reducer    | 100,000 chars in 100 in-order deltas                       | 188 µs total; per delta p50 0.3 µs, p95 0.5 µs | Includes sealing and the content hash             |
| Artifact reducer    | Same, all 100 deltas in reverse order                      | 276 µs                                         | Worst case for the reorder buffer                 |
| Route pipeline      | 100,000-char artifact through the real `/api/chat` handler | 2.46 ms (≈ 39 MiB/s of artifact)               | Agent SSE in → UI message stream out, in-process  |
| Artifact inspection | HTML, 100k chars                                           | 2.27 ms                                        | Static scan, no compile                           |
| Artifact inspection | React, 99k chars                                           | 4.74 ms                                        | Static scan, no compile                           |
| Input screening     | 100,000-char benign prompt                                 | 4.02 ms                                        | NFKC, skeleton folding and all rules              |
| Canvas reducer      | 10,000 operations over 40 artifacts, 12-tab cap            | 2.83 ms (0.28 µs/op)                           | Includes LRU eviction                             |

## Reading the numbers

- **The frame budget is safe.** A store update for a streamed delta costs well under a
  microsecond, about 30,000 times less than a 16 ms frame at 60 fps, so streaming never janks
  because of state management. The stress suite asserts p95 < 16 ms per update on any machine.
- **Out-of-order delivery is cheap.** Reassembling a fully reversed stream costs about 1.5 × the
  in-order case, and the reorder buffer is capped at 256 deltas.
- **The server is not the bottleneck.** At ≈ 39 MiB/s of artifact through the full handler, a
  maximum-size 1,000,000-character artifact needs about 25 ms of server work.
- **Guardrails fit on the critical path.** Inspecting a 100k-character artifact takes a few
  milliseconds, so every sealed revision is inspected before it can run, with no sampling.
- **Rendering dominates.** Syntax highlighting is the costly step in the browser. It is skipped
  above 200,000 characters. Very long single lines (for example minified code) re-highlight on
  every delta and are noticeably slower; see the notes in [testing.md](testing.md).

## Throughput under stress

The [stress suite](../tests/stress-concurrency.test.ts) adds behaviour under load (correctness,
not timing): 200 concurrent requests through the route with seeded abort schedules leave zero
open upstream bodies and balanced abort-signal listeners, 500 concurrent dispatcher runs with
random aborts report exact outcomes, and six stop-and-resubmit cycles in the UI leave nothing
streaming.
