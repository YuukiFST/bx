# bx

Drives the Chrome at BX_CDP_URL. Chain steps with ` + ` in ONE call; a failed step stops the chain (exit 1) and says why.

```
bx open <url> + text
```

Steps:
- `open <url>`: navigate; prints url and title
- `text [selector]`: text of `<main>` (or of the selector)
- `eval <js>`: prints the JSON result
- `url`: current URL

Every step that changes the page returns only after the page settled (no request in flight, DOM quiet), so no sleep is needed.
A page that never goes idle: put `--no-settle` before the first step.
