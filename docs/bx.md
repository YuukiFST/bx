# bx

Drives the open Chrome tab. Do a whole task in ONE call: steps joined by ` + `.
A failed step stops the chain, exits 1 and says why; nothing fails silently.

```
bx open <url> + fill "Email" "a@b.c" + click "Sign in" + wait "Welcome" + table
```

Steps
- `open <url>` navigate
- `click <target>`
- `fill <target> <text>` replaces the value, checks it (select: option label)
- `press <key>` Enter, Tab, Escape, ArrowDown, a, Control+a
- `wait <text>` until the text shows (15 s)
- `text [css]` text of `<main>`
- `table [n|css]` TSV, header first; with several tables, lists them
- `snap` interactive elements as `@ref role "name"`
- `viewport <w>x<h>|reset` stays set until changed
- `shot <file>` PNG; prints its size
- `eval <js>` prints the JSON result
- `console` console messages of the page
- `url`

Target: the visible name, label or placeholder (case-insensitive, exact before prefix), `@ref` from `snap` or from an error, or `css=<selector>`.
Ambiguous or missing names fail and list the candidates.

Actions print one line and return after the page settles (no request in flight, DOM quiet), so no sleep is needed.
Only content drawn by a timer needs `wait`.
A page that never settles: `bx --no-settle ...`.
Quote file paths.
