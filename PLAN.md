# bx: plan

A browser CLI for AI coding agents, designed from the measurements of `browser-tools-bench`.
Written on 2026-11-10.
This file is the brief for the agent that builds it.

## 1. Goal

Build `bx` and enter it as the 6th tool of the benchmark at `C:\Users\Desenvolvimento\Desktop\browser-tools-bench`.
It has to beat every measured tool on the benchmark's agent phase, under the benchmark's own pre-registered rule.

| metric (agent phase, mean per run) | best measured | bx gate |
|---|---|---|
| turns | 6.8 (surf-cli) | at most 4 |
| cost per run | US$ 0.073 (playwright-mcp) | at most US$ 0.035 |
| agent wall time | 27.1 s (surf-cli) | at most 15 s (an estimate, the least certain gate) |
| failed agent runs | 0 / 30 (playwright-mcp) | 0 / 30 |
| scripted battery checks | 35 / 35 (agent-browser, surf-cli, chrome-devtools-axi) | 35 / 35 |
| warm trivial call, median | 239 ms (agent-browser) | under 200 ms |
| cold start, median | 534 ms (surf-cli, new session) | under 300 ms |

The source of every "best measured" number is `results/v2/analysis.md` in the benchmark repo.

"100% accuracy" cannot be guaranteed by a tool, because a model still decides what to type and what to report.
What the tool can do is remove each measured cause of error (section 3) and pass every check of the benchmark.
The report must say this in these terms and must not claim a guarantee.

## 2. Why the gates are reachable: the cost model

The prices implied by the v2 data are US$ 0.1 per million cache-read tokens, 4 per million cache-write tokens and 10 per million output tokens.
Check on one playwright-mcp run (block 5): 149,791 read, 10,822 written, 1,654 output gives 0.0150 + 0.0433 + 0.0165 = US$ 0.0748, the reported cost.

So cost is driven by new tokens entering the context (docs, tool output, the model's own output), not by the number of turns.
Cache writes are 58% of the playwright-mcp cost and 73% of the surf-cli cost.
Time is driven by turns: 13 to 15 s of API time plus 12 to 14 s of tool and start-up time for the three fastest tools.

| tool | why it is where it is |
|---|---|
| playwright-mcp | reads no docs, returns small outputs (10.8k new tokens), but makes one call per turn: 12.8 turns |
| surf-cli | chains commands in one Bash call (6.8 turns), but reads 8.3k characters of docs and writes 15.4k new tokens |
| agent-browser | 14.7k characters of docs and a 20k-character first snapshot |
| chrome-devtools-axi | 12 turns, large snapshots, 528 ms per warm call |
| browser-harness | the agent writes Python and CDP by hand: 17.5 turns, 286k tokens |

A budget for one bx run of the benchmark task:

- unavoidable first turn (system prompt cached, task prompt written): about 1,650 written tokens;
- docs: at most 400 tokens;
- tool output: at most 600 tokens (7 table rows, one line per action);
- model output: about 700 tokens, of which the final JSON answer is about 430;
- 3 to 4 turns of cache reads at about 7k tokens each.

That gives about US$ 0.011 written + 0.003 read + 0.007 output, near US$ 0.02 to 0.03 per run.

## 3. Measured causes of error, and the feature that removes each

| measured failure | cause | bx feature |
|---|---|---|
| surf-cli, 3 of 30 agent runs: every unit cut short | `page.text` runs table cells together and the agent split them wrong | `table` prints one row per line, one cell per tab, header first |
| browser-harness 5 of 5 and playwright-mcp 1 of 5 battery reads | the page was read before its data rendered | every action waits for the page to settle before it returns |
| browser-harness and chrome-devtools-axi: typed text lost, success reported | input sent to a background tab | bring the tab to front, emulate focus, read the value back after `fill` |
| chrome-devtools-axi: `resize 390 844` gave 500 px (agent's note in v1) | window resize has a minimum width | viewport through device-metrics emulation, and `shot` prints the PNG size |
| agent-browser, chrome-devtools-axi: large outputs | a snapshot after every action | an action prints one line; the page is read only on request |

## 4. Design

### Principles

1. One invocation can do the whole task: steps are chained in one command line.
2. Targets are named, not referenced: the agent can act on a page it has never seen.
3. Nothing succeeds silently: every step checks its own post-condition and a failed step stops the chain with a non-zero exit code.
4. Output is the minimum the agent needs to take the next decision.
5. No daemon and no setup: each invocation connects to Chrome over CDP, works and exits.

### Command surface (target; adjust names only with a reason written in the commit)

```
bx <step> [+ <step> ...]

open <url>                 navigate, wait until settled, print: url, title
click <target>             click, wait until settled
fill <target> <text>       focus, replace the value, read it back; mismatch is an error
press <key>                key press on the focused element
wait <text>                wait until the text is visible (default timeout 15 s)
text [selector]            innerText of <main> (or of the selector), blank lines collapsed
table [n|selector]         the table as TSV, header first; several tables and no argument is an error that lists them
snap                       compact list of interactive elements: role, name, ref; the fallback when names are not enough
viewport <w>x<h>           device-metrics emulation, kept across invocations (see state)
shot <file>                PNG screenshot; prints the file and its width x height
eval <js>                  evaluate, print the JSON result
console                    console messages seen in this invocation or recorded in the page
url                        current URL
```

A `<target>` is, in this order: `@ref` from `snap`, `css=<selector>`, or a name.
A name matches the accessible name, label, placeholder or visible text of an interactive element, case-insensitive, exact match before prefix match.
No match, or more than one match at the same level, is an error that lists up to 5 candidates with their roles; bx never picks one by guessing.

The benchmark task in one call, as the agent should be able to write it after reading the docs:

```
bx open http://localhost:3100/inscricoes + fill "Buscar" "<QUERY>" + click "Pesquisar" + wait "Cód. empresa" + table \
   + viewport 390x844 + open http://localhost:3100/guias + shot C:\path\shot.png + viewport 1366x768
```

### Settle rule

After `open`, `click`, `fill` and `press`: no network request in flight and no DOM mutation for 150 ms, with a cap (default 10 s).
Hitting the cap is reported on the output line and makes the step fail unless `--no-settle` was given.
Start with these numbers, then tune them on the benchmark app with measurements, and record the measurements in the commit.

### State

There is no daemon, so nothing survives an invocation inside bx.
A small state file per session (`BX_SESSION`, default `default`, in the OS temp directory) keeps the target id of the tab in use and the viewport.
On every attach, bx re-applies the stored viewport, because device-metrics emulation is expected to end when the CDP session detaches.
Verify that expectation in phase 1 before building on it.
Console messages across invocations need a recorder installed in the page; inside one chain, `Runtime.consoleAPICalled` is enough.
If a requirement cannot be met without a daemon, stop and report it; do not add a daemon silently.

### Configuration

`BX_CDP_URL` (default `http://127.0.0.1:9222`), `BX_SESSION`, `BX_TIMEOUT_MS`.
No config file.

### Docs

`docs/bx.md`, at most 1,500 characters, is the whole documentation an agent reads.
`bx --help` prints the same text.
A test fails when the file passes 1,500 characters.

### Language and dependencies

Node 24 (installed: v24.20.0), one file, zero dependencies, using the built-in `WebSocket` and `fetch` the way `harness/cdp.mjs` does.
Measured on this machine: `node -e 0` takes 61 ms; an npm shim adds about 140 ms (`agent-browser --version` through its shim: 207 ms), so the benchmark calls `node <path>/bx.mjs` or a direct launcher, not an npm shim.
If the warm trivial call stays at or above 200 ms after that, stop and ask about a Rust port; cargo 1.98.1 is installed, but a port needs new crates, and a new dependency is the user's decision.

## 5. Phases

Each phase ends in a state that can be checked, and the check runs before the next phase starts.
Commit after each phase.

### Phase 0: repository

- `git init` in `C:\Users\Desenvolvimento\Desktop\bx`, remote `https://github.com/YuukiFST/bx` (the user creates it empty).
- README with the goal in 5 lines, `PLAN.md` kept as is, license MIT.
- Check: `git status` clean, the remote answers.

### Phase 1: core

- CDP connection, tab selection, state file, `open`, `url`, `eval`, `text`, the settle rule, chaining with `+`, exit codes.
- A local fixture: a static page served by a Node script, with a form, a table, content that renders 1 s late, and a second table.
- Tests with `node --test`, each one running the `bx` command line against a headless Chrome started by the suite on its own port (end to end only, one command, no manual step).
  The source of each test is a row of section 3 or a line of the command surface in section 4, both approved by the user with this plan; quote it in the commit that adds the test.
- Check: tests pass; a chain that reads the late content returns it without any explicit wait; the emulation expectation of section 4 is confirmed or the design is corrected.

### Phase 2: interaction and reading

- Name resolution, `click`, `fill` with read-back, `press`, `wait`, `table`, `snap`, `viewport`, `shot`, `console`.
- Check: tests cover every row of the table in section 3 on the fixture, including the ambiguous-name error and a `fill` into a background tab.

### Phase 3: benchmark integration (free phases)

Work in the benchmark repo on a branch `feat/bx-tool`.

- Add `bx` to `lib.sh` (`ALL_TOOLS`, `stop_tool`, `start_tool`, `trivial_call`, `tool_version`), `bench.sh` (the 7 tasks, same wait rules as the other tools), `latency.sh`, `coverage.sh`, `score-coverage.mjs` and `agents.sh` (same prompt shape: "Before the first use, read `agent-docs\bx.md`").
- Copy `docs/bx.md` to `harness/agent-docs/bx.md`.
- The benchmark needs its Chrome on port 9444 and the app on `http://localhost:3100`, logged in.
  If either is not running, ask the user; do not start or reconfigure them by guessing.
- Run the battery (5 iterations), latency and coverage for bx.
- Check: battery 35 / 35, warm median under 200 ms, cold under 300 ms, coverage at least equal to the best tool on each route.
  Iterate on bx until the checks pass.
  The dashboard coverage ceiling today is 97.5%: the same 9 cells are missing from both `innerText` reads (8 currency values and one dated line).
  Find out whether that is ground-truth noise before treating it as a bx defect.

### Phase 4: freeze, then pre-register

1. Tag bx `v0.1.0`. From here on, bx changes only for a defect found in the pilot, and the report lists every such change.
2. Only after the tag, the user (or another session, not the one that built bx) writes one held-out agent task for the benchmark app.
   The builder must not see the task before the tag, so bx cannot be shaped to it.
3. Commit an addendum to `ranking-rule.md` before any paid run. It states:
   - Only bx runs; the 5 measured tools keep their v2 rows (`results/v2/agents.jsonl`) and are not rerun. This is the user's decision.
   - bx rows go to `results/v3/agents.jsonl`, with a new baseline in `results/v3/baseline.jsonl` taken in the same session.
   - The v2 rule pairs tools per block, and bx shares no block with the others. For every pair that includes bx, the paired difference is replaced by the difference of means of two independent samples, with a percentile bootstrap that resamples each tool's runs separately (10,000 resamples, seed 20261110). The separation test, the failure tier and the 8-run minimum are unchanged. Pairs among the 5 old tools keep their v2 result.
   - Cost above baseline uses each data set's own baseline (v2 for the old tools, v3 for bx).
   - The held-out task is reported in its own table, for bx only: it checks accuracy and cost, it does not rank.
   - The benchmark author also wrote bx.

### Phase 5: paid runs (ask first)

Every `claude -p` run costs money: stop and get the user's go-ahead, with the estimate, before the first one.

- Only bx runs: baseline 3 runs, pilot 1 run (not ranked), 30 ranked runs (the same count as playwright-mcp and surf-cli), held-out task 10 runs.
  Estimate at US$ 0.03 per run: about US$ 1.5.
  Proposed cap: US$ 3.
- `agents.sh` stops every tool process and resets the tabs before each run, as in v2, so every bx run starts cold.
- Record on every row what v2 recorded (timestamp, Claude Code version, model id, tool version); if the Claude Code version or the model differs from v2 (`2.1.317`, `claude-sonnet-5-5`), stop and report before the ranked runs.
- Check after the pilot: the bx row has every field, `ok` is true, turns at most 4.
  If the pilot misses a gate of section 1, stop and report before spending more.

### Phase 6: report

- Extend `analyze-v2.mjs` (or add `analyze-v3.mjs`) to read the v2 rows plus the v3 bx rows and apply the addendum, then update `README.md`, `methodology.md` (a v3 section) and the HTML report in the benchmark repo.
- Publish the result the rule gives, including when bx loses or ties.
- Pull request per repo, written with the `pr-writing` skill.

## 6. Risks

- **Overfitting.** bx is designed by someone who knows the benchmark task. The freeze before the held-out task (phase 4) limits this; the report states the conflict of interest.
- **Names fail on apps with poor labels.** `snap` and `css=` are the fallback, at a higher token cost. The held-out task will show how often the fallback is needed.
- **Settle rule on apps that poll.** A page that never goes idle hits the cap; `--no-settle` and `wait <text>` are the way out, and the cap must be visible in the output.
- **Daemonless state.** Viewport and console need the state file and the in-page recorder; if either proves unreliable, the decision about a daemon goes to the user.
- **bx is not measured beside the others.** Its runs happen in another session, back to back, with no other tool between them.
  The prompt cache then favors bx: each run reads the prefix the previous bx run wrote, while in v2 the tools alternated.
  Machine load, app state and API latency can also differ from the v2 day (v1 saw a 45% time drift between two days).
  The v3 baseline absorbs part of the cache effect on cost; nothing corrects time.
  The report states this limit next to the ranking, and gives the first-turn cache read and write of bx against the v2 tools so a reader can size it.
- **Time gate.** 15 s is derived from turn counts, not measured. Missing it while meeting the others is reported, not hidden.

## 7. Stop and ask

- Before any paid run, and before raising the cap.
- Before adding a dependency, a daemon or a second language.
- Before pushing to `main` of either repo, and before any force-push.
- When the same error appears twice.
- When a gate of section 1 cannot be met: report the measurement and the cause, do not relax the gate.
