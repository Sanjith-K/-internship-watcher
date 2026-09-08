# Internship Watcher

This repository monitors internship postings and routes matching jobs to a
per-run email digest and a single Notion database. It is designed to run
from GitHub Actions or locally. GitHub's schedule is best effort, so the
`*/10` cron is a request to GitHub rather than a delivery guarantee; runs
can be delayed for hours.

## Architecture

Each watcher run:

1. Fetches the 178 company boards listed in `config.json` using the
   Greenhouse, Lever, and Ashby public APIs. It also reads the enabled
   SimplifyJobs and Jobright feeds.
2. Applies the title, location, and season filters to every source. The
   top-level `terms` list applies to all sources; `simplify.terms` remains a
   backward-compatible fallback only when top-level `terms` is absent.
   `keep_unknown_terms` controls whether a posting with no recognizable
   season term is retained and defaults to keeping unknown terms.
3. Tags each match with a category — `quant`, `general`, or both — based on
   title keywords in `config.json`'s `category_terms.quant` /
   `category_terms.general` lists. A job matching neither defaults to
   `general` so nothing is left ungrouped. The category is stored on the job
   record (`categories`), so downstream delivery never re-derives it.
4. Identifies postings by ATS identity or canonical URL. Known campaign
   parameters are removed, while other URL query parameters are preserved
   because they may identify the job. Exact identities remain known
   indefinitely. Cross-source fuzzy fingerprints are retained for
   `dedup_days` (30 days by default). Legacy `norm:` entries in state are
   ignored for matching and are not removed.
5. Places each new job into `delivery_state.json` with its individual
   destinations (`email` and/or `notion`, depending on which credentials are
   configured). Undelivered destinations remain queued for a later run.
6. Delivers a single email digest per run — grouped into Quant and General
   sections — and upserts each job into the Notion master log.

The watcher checkpoints intent before external delivery and uses atomic JSON
writes.

The repository also contains the `internship-pinger` Cloudflare Worker. It
triggers the `watch.yml` workflow and monitors completed main-branch runs,
writing an hourly health status to a Notion callout. See
[`internship-pinger/README.md`](internship-pinger/README.md) for its setup.

## Notion: the master log is the tracker

The Notion database **All Internship Postings** is both the master log and
the personal tracker — there's only one user, so there's no separate
per-person database. Every new posting is upserted with `Status = Saved` and
a `Category` (Quant/General, multi-select so a job matching both keeps both
tags).

Promote a row by hand in Notion: change `Status` to `Applied`, `OA`,
`Interview`, `Offer`, or `Rejected` as your pipeline for that job moves. This
replaces the old Discord 📌-reaction save flow — since every job is already
logged with `Status = Saved`, there's no separate "save" action needed at
all.

When you flip a row's `Status` to `Applied` in Notion, the *next* watcher run
notices it has no `Applied On` date yet and back-fills `Applied On` (today)
and `Follow-up` (today + `follow_up_days`) automatically. This reconciliation
sweep replaces the old Discord applied-link channel — no message parsing, no
bot, just a periodic Notion query.

**Logging an application the watcher never surfaced** (you applied on a
company's site directly, or via LinkedIn): run

```bash
python notion_sync.py --applied "https://boards.greenhouse.io/acme/jobs/123"
```

This reuses the exact same ATS-API + HTML-metadata parser the old
applied-link channel used, resolving company/role/location from the URL, and
upserts an `Applied` row (with dates already filled in) into the same
database. It needs `NOTION_TOKEN`/`NOTION_PARENT_PAGE_ID` set in your
environment, same as a normal run.

Applied tracker rows have `Status`, `Applied On`, and `Follow-up` properties.
The default follow-up interval is 14 days (`follow_up_days`); `0` disables
the due date. The Notion 📊 stats callout on the parent page includes
pipeline status counts and due follow-ups. Existing rows are scanned by
canonical job identity before an upsert, including rows created by the
legacy schema, so history from before this change is preserved. URLs that
were already stripped by an older version cannot be repaired automatically.

Once a day, a dead-posting sweep flips `Saved` rows whose posting has
disappeared from its ATS to `Closed`, so you don't draft an application for a
dead link. `Applied`+ rows are left alone.

## Setup

Install dependencies with:

```bash
pip install -r requirements.txt
```

### Notion

Create an internal integration at [notion.so/my-integrations](https://www.notion.so/my-integrations), share the parent page with it, and set:

| Variable | Use |
| --- | --- |
| `NOTION_TOKEN` | Notion API access |
| `NOTION_PARENT_PAGE_ID` | Parent page for the master log/tracker database |

### Email

Set `SMTP_USER`, `SMTP_PASS`, and optionally `ALERT_EMAIL`; `SMTP_HOST` and
`SMTP_PORT` can be configured in `config.json` or the environment. Email is
the primary glance-and-go surface: one digest per run, grouped into Quant and
General sections, listing every new posting found that run. There's no
digest batching across runs — if a run finds nothing new, no email is sent.

### Dry runs and credentials

With no delivery credentials, or with `python watcher.py --dry-run`, the
watcher fetches and previews matching boards and feeds but does not write
state or call email or Notion. Fetching public boards is the only external
activity in this mode. A normal run requires at least one configured
delivery destination.

## Configuration

`config.json` contains the 178 `companies` entries plus explicit defaults
for `terms`, `keep_unknown_terms`, `dedup_days` (30), `follow_up_days` (14),
and `category_terms` (the `quant`/`general` keyword lists used for category
tagging). It also contains the SimplifyJobs and Jobright feed settings. Add
a board only after verifying its slug with `verify_boards.py`; unsupported
or stale slugs can return 404. The configured `exclude_locations` list uses
word-boundary matching and keeps locations that clearly contain a US state
or USA. Empty or unknown locations are retained.

`category_terms` looks like:

```json
{
  "category_terms": {
    "quant": ["quantitative", "quant developer", "quant researcher", "quant trading", "trading", "algo trading"],
    "general": ["software", "swe", "backend", "machine learning", "..."]
  }
}
```

A posting is tagged `quant` if its title matches any `quant` keyword,
`general` if it matches any `general` keyword, both if it matches both, and
defaults to `general` if it matches neither (so every job lands in a
digest section).

## Durable state

These files are runtime state. GitHub Actions persists them after each run;
local runs write them beside the scripts.

| File | Contents |
| --- | --- |
| `seen.json` | Previously observed source posting IDs |
| `delivery_state.json` | Known identities, 30-day fingerprints, legacy `norm:` entries ignored but retained, and pending per-destination queues |
| `notion_state.json` | Notion master database id, dead-posting sweep timestamp, stats callout block id |
| `health.json` | Last completed scan, source successes/failures, matching and new counts, pending deliveries, and sync errors |

`health.json` is also the run's operational summary: a source failure,
pending delivery, or Notion sync error is reported explicitly and retried
through durable state.

`message_map.json` is a leftover from the Discord-based delivery this
project used before; nothing reads or writes it anymore, and it can be
deleted whenever you like.

## Local run

```bash
python watcher.py --dry-run
python watcher.py
```

Run the tests with `python3 -m unittest discover -s tests -v` and
`node --test internship-pinger/worker.test.js`. The workflow always uploads
the state files as a recovery artifact with seven-day retention. Its
persistence step always runs, makes up to three rebase/push attempts, and
preserves the artifact if a rebase conflict prevents pushing. Do not assume
the scheduled workflow runs exactly every ten minutes.

## Troubleshooting

- A 404 for a board usually means its ATS slug changed. Verify it before editing `config.json`.
- A nonzero pending count in `health.json` means a destination will be retried on a later run.
- Deleting state files causes history to be reconsidered. Preserve `seen.json`, `delivery_state.json`, and `notion_state.json` unless you intentionally want to reprocess work.
- Old Notion rows and saved history remain valid. Rows whose URL was previously damaged by an older version are not automatically reconstructed.
- If a row's `Status` is `Applied` but `Applied On`/`Follow-up` look empty, wait for the next run — the reconciliation sweep only runs as part of a normal watcher invocation (or `notion_sync.py` run directly).
