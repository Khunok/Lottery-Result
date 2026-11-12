# Myanmar Dream Dictionary data (v1)

Used by A Thousand Dreams (Android v30 bundles a copy; iOS downloads and caches these files).

- `my.json`, `en.json`, `th.json` — one file per language; show only the app language.
- Shape: `{v, lang, letters:[{c,t}], entries:[{id,l,d,m}], kosala:[{n,t,b}], guide:{section:{key:text}}}`
  - `letters`: Myanmar letter code `c` and its label `t` in this language
  - `entries`: 440 dreams — `id`, letter `l`, dream `d`, meaning `m`
  - `kosala`: index 0 = introduction, then the 16 dreams (`t` title, `b` text)
  - `guide`: UI titles (`title.*`, incl. search hint, home link, disclaimer) and the "about dreams" sections
- No numbers. Rewritten in our own words from traditional sources (owner-approved 11 Nov 2026).
- Built by `tools/dreamdict/build.py` in the Android project from the `.psv` sources.

URL: `https://raw.githubusercontent.com/Khunok/Lottery-Result/main/dreamdict/<lang>.json`
(or GitHub Pages: `https://khunok.github.io/Lottery-Result/dreamdict/<lang>.json`)
