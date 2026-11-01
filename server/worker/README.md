# atd-live — live lottery results (Cloudflare Worker)

Polls the official GLO API every minute on draw days (14:00–18:59 Thailand time), publishes each prize
category as soon as it is complete, serves it at `/lottery.json` (same format as the bot's `lottery.json`)
and sends one Firebase data message per change to the topic `draw_results`. When the result is complete it
asks the GitHub bot to save it to history. The GitHub bot remains the record keeper and the fallback.

* Code: `worker.js` (no dependencies). Tests: `node --test test/` (Node 18+). The fixture is the real GLO
  response of 1 Nov 2026; the test checks the Worker's record equals the bot's `history/2026-11-01.json`.
* Setup (Burmese, step by step): `LIVE_SETUP.md` in the app project.
* Bindings: KV `LOTTO`; secret `FCM_SERVICE_ACCOUNT` (Firebase service-account JSON); optional secret
  `GITHUB_TOKEN` (fine-grained, this repo, Actions read & write); cron `* 7-11 * * *`.
* `GET /status` shows the last thing the minute job did.
* Free tier is enough for a modest audience: 100k requests/day (the app reads `/lottery.json` mainly while
  the Lottery screen is open during the draw; pushes deliver the numbers without a request).
