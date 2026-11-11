# Realistic 3D card art

Optional card style for the A Thousand Dreams Android app (v30+).

- `thumb/<key>.webp` — max 240 px, used in lists
- `full/<key>.webp` — max 640 px, used on the card detail screen
- Transparent WebP; keys match the app's bundled classic art (e.g. `nagar_001`).
- Served to the app from GitHub Pages: `https://khunok.github.io/Lottery-Result/cards3d/...` (fallback: raw.githubusercontent.com at a fixed commit). Not via jsDelivr: its /gh/ endpoint refuses repositories over 50 MB.
