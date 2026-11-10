# bx

Drives the open Chrome tab. Do a whole task in ONE call: steps joined by ` + `.
A failed step stops the chain, exits 1 and says why; nothing fails silently.

```
bx open <url> + fill "Email" "a@b.c" + click "Sign in" + wait "Welcome" + table
```

Start with `open`: the tab may be empty.
Act first, look only after a failure: a wrong name fails and lists the names the page has, so `snap` before acting is a wasted call.

Steps
- `open <url>` navigate
- `click <target>` goes on in the new tab when one opens
- `hover <target>`
- `fill <target> <text>` replaces the value, checks it (select: option label)
- `upload <target> <file>`
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

Actions print one line and return after the page settles (no request in flight, DOM quiet), so no sleep is needed.
Only content drawn by a timer needs `wait`.
A page that never settles: `bx --no-settle ...`.
Quote file paths.
