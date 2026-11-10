# bx

AI coding agents spend most of a browser task on turns and tokens the browser tool forces on them: long docs, a snapshot after every action, one call per step.
`bx` is a browser CLI that does a whole task in one command line: steps chained with `+`, targets addressed by name, every step checked before the next one runs.
It talks to a running Chrome over CDP, with no daemon, no setup and no dependencies (one Node 24 file).
The goal is to enter [browser-tools-bench](https://github.com/YuukiFST/browser-tools-bench) as its 6th tool and beat every measured tool under that benchmark's pre-registered rule.
The gates, the design and the phases are in [PLAN.md](PLAN.md).

## License

MIT, see [LICENSE](LICENSE).
