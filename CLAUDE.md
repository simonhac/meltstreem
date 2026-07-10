@AGENTS.md

## Operational log

- **2026-07-10 — Meltwater webhook re-pointed to the custom domain.** The feed had been
  silent ~26h. Root cause: during config hardening the Worker was moved from its
  `headwater.simon-8e9.workers.dev` URL to the `feed.moofer.com` custom domain **and the
  workers.dev subdomain was disabled**, which orphaned Meltwater's Generic Webhook (it was
  still aimed at the now-dead workers.dev URL, so deliveries 404'd at Cloudflare's edge and
  never reached the Worker — invisible in `/inspect`). Meltwater's webhook UI can't edit a
  saved URL (it masks it to `feed.moofer.com/***`; delete + re-add only). Fix: created a new
  Generic Webhook connection **`headwater 20260710b`** →
  `https://feed.moofer.com/webhooks/meltwater/<WEBHOOK_SHARED_SECRET>` (token prefix
  `511a960123a…` verified against the deployed secret). **Fixed:** the three Every-Mention alerts weren't
  bound to the webhook — ticking `headwater 20260710b` under Alerts → Delivery method
  restored the feed (verified 2026-07-10: 8 mentions parsed → filtered → posted to Slack).
  See README §c ("What the Generic Webhook UI does *not* give you").
