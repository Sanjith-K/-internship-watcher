# CLAUDE.md — project context for future sessions

## What this is

A personal internship alert and application-tracking system. The main
watcher reads 178 configured company boards plus SimplifyJobs and Jobright
feeds, filters every source, tags each match with a category (quant/
general), and routes new postings to a per-run email digest and a single
Notion database. It can run from GitHub Actions or locally. The GitHub
`*/10` schedule is best effort and must not be documented as a ten-minute
guarantee.

The `internship-pinger` Cloudflare Worker is now in this repository. It
triggers `watch.yml`, monitors completed main-branch runs, and writes an
hourly health status to a Notion callout. Keep worker changes and watcher
changes conceptually separate; its README and Node test are part of the
repository.

## Architecture facts

- `watcher.py` fetches the configured Greenhouse, Lever, and Ashby boards and the enabled aggregate feeds.
- Filtering applies to all sources. Top-level `terms` is the season filter for every source; `simplify.terms` is only a backward-compatible fallback when top-level `terms` is absent. Unknown season terms are retained by default and can be controlled with `keep_unknown_terms`.
- Category tagging is per-*match*, not per-company: `job_utils.categorize()` checks a job's title against `config.json`'s `category_terms.quant`/`category_terms.general` keyword lists. A job can be tagged `quant`, `general`, or both; matching neither defaults to `general`. `watcher.discover()` attaches `job["categories"]` before dedup, so it's stored in state and never re-derived downstream. The same company can produce both quant and general jobs depending on which posting matched.
- `job_utils.py` canonicalizes URLs while preserving meaningful query parameters. Exact job identities persist. Cross-source fuzzy fingerprints expire after `dedup_days` (default 30). Legacy `norm:` entries in state are ignored for matching, not removed.
- `delivery_state.json` is the durable per-destination queue for `email` and `notion`. Notion delivery is per-job (one failure doesn't block the batch); email is a single per-run digest grouped by category, sent once for every job still pending email delivery in that run, not one send per job.
- `health.json` records the last completed scan, source health, pending deliveries, and sync errors. A failed run leaves checkpointed work for retry.
- There is no Discord integration anywhere in this project (watcher, notion_sync, workflows, or the pinger Worker). If you see `DISCORD_*` env vars, webhook URLs, `message_map.json` usage, or `profiles`/`webhook_env` config referenced in old context, they're stale — do not reintroduce them.
- `notion_sync.py` maintains **one** Notion database ("All Internship Postings") that serves as both the master log and the personal tracker — there's only one user, so there's no per-person database, no 📌-reaction save flow, and no Discord applied-link channel. Every new posting is upserted with `Status = Saved` and a `Category` multi-select. Promote a row (Applied/OA/Interview/Offer/Rejected) by editing `Status` directly in Notion.
- A periodic reconciliation sweep (`_reconcile_applied_status`) backfills `Applied On`/`Follow-up` whenever it finds a row at `Status = Applied` with no `Applied On` yet — this is what replaces the Discord applied-link parsing. `follow_up_days` defaults to 14 (single top-level config value now, since there are no more per-Discord-user profile overrides); `0` disables the follow-up date.
- For an application to a job the watcher never surfaced, `python notion_sync.py --applied <url>` reuses the ATS-API/HTML-metadata parser (`_parse_job_from_url`, `_ats_api`, and friends — kept verbatim from the old applied-channel implementation) to resolve company/role/location and upsert an `Applied` row.
- Notion upserts query existing rows by canonical job identity, including legacy rows, so existing history does not need a reseed migration. Previously stripped URLs are not automatically repairable.
- Config defaults include explicit `terms`, `keep_unknown_terms`, `dedup_days` 30, `follow_up_days` 14, and `category_terms` (quant/general keyword lists). There is no `profiles` config anymore — it existed only to route different people's Discord webhooks, which no longer applies to this single-user tool.

## Deployment facts

- Live repo: `github.com/avyukthNarra/-internship-watcher` (public, including the leading `-`; account `avyukthNarra`). Check `git remote -v` before assuming. This checkout may contain work in progress; do not imply a live rollout unless it has been verified.
- The original `github.com/avyTamuGit/internship-watcher` deployment was disabled during the account migration. Do not re-enable it while the new deployment is the active path.
- `gh` CLI is not installed on this machine. The old macOS keychain credential belongs to `avyTamuGit`; pushing to the new repo uses SSH.
- Existing Notion history and state were carried across during migration. Do not reseed or delete state casually.
- Secrets: `NOTION_TOKEN`, `NOTION_PARENT_PAGE_ID` (watcher and, optionally, the pinger Worker for its health callout); SMTP secrets (`SMTP_USER`, `SMTP_PASS`, optional `ALERT_EMAIL`) are optional but are now the primary delivery surface, not a fallback.

## Working rules

- Verify every new ATS board slug with `verify_boards.py` before adding it. Wrong slugs can 404 silently. Not every quant/prop-trading firm is on Greenhouse/Lever/Ashby — Citadel, Citadel Securities, Bridgewater Associates, DE Shaw, and Trading Technology Group (TGS) were checked and failed verification under every slug guess tried; they'd need custom-domain scraping or manual tracking, which is out of scope for the ATS fetchers.
- Preserve `seen.json`, `delivery_state.json`, and `notion_state.json`. Deleting them can requeue or re-alert historical jobs. `message_map.json` is vestigial (Discord message-id map, unused since Discord was removed) — it's left on disk untouched rather than actively migrated, since nothing reads or writes it anymore; safe to delete manually if you want to clean up.
- A one-time migration in `watcher.main()` strips any `discord:*` entries from `delivery_state.json`'s pending destinations on load, since those queued deliveries can never complete after Discord removal and the new `destinations()`/`deliver()` don't know how to handle that prefix.
- The workflow always uploads state artifacts with seven-day retention. Persistence runs even after watcher failures and retries rebase/push up to three times; a rebase conflict leaves the artifact available for recovery.
- Do not add a new feed merely because it sounds useful; inspect whether it duplicates SimplifyJobs or Jobright.
- Run `python3 -m unittest discover -s tests -v` and `node --test internship-pinger/worker.test.js`. Keep setup and secret documentation useful for both GitHub Actions and local dry runs.
