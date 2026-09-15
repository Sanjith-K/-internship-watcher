# Internship pinger

This Cloudflare Worker dispatches the repository's `watch.yml` workflow every
10 minutes and checks the completed runs for failures and stale successes. It
uses the workflow-specific GitHub endpoint:

`/actions/workflows/watch.yml/runs?status=completed&per_page=10`

Every hourly reminder tick writes a status line to a persistent 🩺 callout
block on the Notion parent page (the same page the watcher's master log and
📊 stats callout live on) — whether the watcher is healthy or not, so the
block always reflects the last check. The worker keeps no state of its own:
it finds the callout by its icon on the page each time (creating it once if
missing) rather than remembering a block id, matching the watcher's own
"re-query Notion, don't trust local state" pattern.

Alerts use `event.scheduledTime`: only the first normal scheduled tick in
each UTC hour (minutes 00–09) writes the callout. A platform redelivery of
the same event can duplicate a write, but since it's an idempotent PATCH to
the same block (not a new message), that's harmless.

## Deploy

Install and authenticate Wrangler, then run these commands from this directory:

```sh
wrangler login
wrangler secret put GH_PAT
wrangler secret put NOTION_TOKEN
wrangler secret put NOTION_PARENT_PAGE_ID
wrangler deploy
```

`GH_PAT` needs permission to dispatch workflows and read Actions runs.
`NOTION_TOKEN`/`NOTION_PARENT_PAGE_ID` are optional — the same integration
token and parent page id used by the main watcher; without them, monitoring
still runs and logs that alert delivery was skipped. The repository defaults
to `avyukthNarra/-internship-watcher`. To point the worker at another
repository, set the optional `REPO` environment value (for example with
`wrangler secret put REPO`). No HTTP route is required; the cron trigger in
`wrangler.toml` runs it every ten minutes.

Run the local tests with:

```sh
npm test
```
