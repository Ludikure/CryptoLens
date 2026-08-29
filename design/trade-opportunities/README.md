# Trade Opportunities — design canvas

Mockups for the scanner screen (spec §22 + §38) that replaces the symbol-first Now tab.
Published at https://claude.ai/code/artifact/960dc494-aa9a-4001-ada1-116a52b1f88a

Three artboards: the quiet day (the primary state — most days nothing qualifies),
a good day, and the colour law behind both.

## Rebuilding

`trade-opportunities.html` is gitignored: it is 2.4 MB because the canvas editor is baked
into the published page. Rebuild it from the sources here:

```sh
./assemble.sh Main 402 980 && ./assemble.sh Quiet 402 680 && ./assemble.sh Law 402 1180
node <design-skill>/seed-canvas.mjs \
  --template <design-skill>/payload.template.html \
  --out trade-opportunities.html --title "Trade Opportunities" \
  --artboard Main.dc.html --artboard Quiet.dc.html --artboard Law.dc.html \
  --canvas canvas.json
```

`body/*.html` are the artboard bodies, `_shared.css` the tokens, `canvas.json` the layout.
The `*.dc.html` files are assembled output, kept so the directory reads without a build.

## Where the design came from

Tokens are lifted from `CryptoLens/Utils/Theme.swift`, not invented — six semantic roles,
14px card radius and padding, 3px accent stripe, 0.14-alpha pills, system fonts only.

`COPY.md` holds the two rules that make it readable: every machine reason string is
translated before display, and R always carries its money (1R = $560 at 2% of $28,000).
