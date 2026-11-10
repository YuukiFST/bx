# bx

AI coding agents spend most of a browser task on turns and tokens the browser tool forces on them: long docs, a snapshot after every action, one call per step.
`bx` is a browser CLI that does a whole task in one command line: steps chained with `+`, targets addressed by name, every step checked before the next one runs.
It talks to a running Chrome over CDP, with no daemon, no setup and no dependencies (one Node 24 file).
The goal is to enter [browser-tools-bench](https://github.com/YuukiFST/browser-tools-bench) as its 6th tool and beat every measured tool under that benchmark's pre-registered rule.
The gates, the design and the phases are in [PLAN.md](PLAN.md).

## Benchmark

[browser-tools-bench](https://github.com/YuukiFST/browser-tools-bench) gives one task to a real agent (`claude -p`) with each tool: search a web app, list the 7 rows found, take a mobile screenshot.
This run used `claude-haiku-5-5`, a small model, on 2026-11-10: 10 runs per tool, in blocks that shuffle the tool order, with bx 0.2.0.
Lower is better in every column.

| rank | tool | turns | cost above baseline, US$ | agent time, s | failed runs |
|---|---|---|---|---|---|
| 1 | **bx** | 7.7 | 0.0034 | 29.8 | 0 / 10 |
| 2 | surf-cli | 8.9 | 0.0063 | 40.0 | 0 / 10 |
| 3 | playwright-mcp | 15.5 | 0.0067 | 26.2 | 0 / 10 |
| 3 | agent-browser | 9.5 | 0.0081 | 47.9 | 0 / 10 |
| 5 | chrome-devtools-axi | 13.9 | 0.0111 | 57.0 | 0 / 10 |
| 6 | browser-harness | 23.8 | 0.0135 | 133.7 | 0 / 10 |

The rank comes from the benchmark's rule, pre-registered before the runs: failures first, then cost and turns, with a paired bootstrap test that decides whether two tools are separated or tied.
bx is separated from surf-cli on both ranked metrics; time is reported and never ranks, and playwright-mcp is faster there.
Rows, intervals and the rule: [analysis.md](https://github.com/YuukiFST/browser-tools-bench/blob/feat/bx-tool/results/v4-haiku/analysis.md), [ranking-rule.md](https://github.com/YuukiFST/browser-tools-bench/blob/feat/bx-tool/ranking-rule.md).

What this table does not show:

- Every tool got all 60 runs right, so this run does not separate the tools on accuracy.
- It is one task on one app, and bx 0.2.0 was changed with that task in view; a held-out task, written by someone else after the `v0.2.0` tag, is still to run.
- The author of the benchmark also wrote bx.

## Use

```
node bx.mjs open <url> + fill "Email" "a@b.c" + click "Sign in" + wait "Welcome" + table
```

Chrome must be running with `--remote-debugging-port` (default `http://127.0.0.1:9222`, or `BX_CDP_URL`).
[docs/bx.md](docs/bx.md) is the whole documentation, written for the agent that drives it; `bx --help` prints it.
`npm test` runs the end-to-end suite against a headless Chrome it starts itself.

## License

MIT, see [LICENSE](LICENSE).
