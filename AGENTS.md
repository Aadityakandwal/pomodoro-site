# Project: Pomodoro d'Oro
Static single-page focus timer on Cloudflare Pages (Git-connected, auto-deploy on push to main).

## Structure
- index.html — entire frontend (HTML+CSS+JS inline, vanilla ES6, no dependencies, no build step).
  Zen layout: corner buttons, drawers (music / tasks / study coach), settings popover.
- _worker.js — Cloudflare Pages Worker: serves statics via env.ASSETS; proxies AI at
  POST /api/chat using env.NVIDIA_API_KEY (NEVER hardcode keys); GET /api/models lists live models.
- og.png, robots.txt, sitemap.xml, _headers — static/SEO assets.

## Deploy
- Push to main → auto-deploys to https://pomodoro-doro.pages.dev (no build command, output = root).
- Secrets live in Cloudflare Pages settings (NVIDIA_API_KEY, optional NVIDIA_MODEL). Never commit keys.

## Conventions
- Keep the single-file frontend; do not add frameworks/bundlers.
- AI fallback chain = FALLBACK_MODELS in _worker.js; refresh it from /api/models when models retire (404/410).
- Client storage keys: pdoro.cfg, pdoro.tasks, pdoro.stats, pdoro.ai, pdoro.bg; IndexedDB: pdoro-music.
- Keep OG/canonical URLs pointing at pomodoro-doro.pages.dev.

## After editing, verify
- No console errors on load; start/pause/resume works.
- GET /api/models returns 200; coach replies without reasoning traces.