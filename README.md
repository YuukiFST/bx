# bx

AI coding agents spend most of a browser task on turns and tokens the browser tool forces on them: long docs, a snapshot after every action, one call per step.
`bx` is a browser CLI that does a whole task in one command line: steps chained with `+`, targets addressed by name, every step checked before the next one runs.
It talks to a running Chrome over CDP, with no daemon, no setup and no dependencies (one Node 24 file).
The goal is to enter [browser-tools-bench](https://github.com/YuukiFST/browser-tools-bench) as its 6th tool and beat every measured tool under that benchmark's pre-registered rule.
The gates, the design and the phases are in [PLAN.md](PLAN.md).

## Use

```
node bx.mjs open <url> + fill "Email" "a@b.c" + click "Sign in" + wait "Welcome" + table
```

Chrome must be running with `--remote-debugging-port` (default `http://127.0.0.1:9222`, or `BX_CDP_URL`).
[docs/bx.md](docs/bx.md) is the whole documentation, written for the agent that drives it; `bx --help` prints it.
`npm test` runs the end-to-end suite against a headless Chrome it starts itself.

## License

MIT, see [LICENSE](LICENSE).
