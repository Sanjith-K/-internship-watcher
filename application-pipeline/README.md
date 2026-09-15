# Application Pipeline

A Cloudflare Workers + Workflows pipeline that drafts job applications from
new Notion rows and waits for your approval via Discord before doing
anything with them. Entirely on Cloudflare — no Temporal, no separate
always-on server, no Gateway bot connection.

This is a separate, decoupled piece from the Python watcher and from
`internship-pinger/`. It only ever reads/writes the same Notion database
the watcher already owns — it never imports or calls into the Python code,
and the watcher never knows this exists.

## Important: there is no automated application submission here, by design

I looked into whether Greenhouse's and Lever's terms of service permit
automated/bot-submitted applications and could not get a confident answer
either way from primary sources (Greenhouse's terms page 404'd; Lever's
published terms are a B2B customer agreement, not applicant-facing terms).
Both platforms' public APIs are explicitly for *reading* job listings —
neither publishes a documented API for *submitting* an application, and
actually doing so programmatically would mean reverse-engineering an
undocumented endpoint or driving a browser through anti-bot defenses these
platforms commonly deploy on their application flows specifically to deter
this kind of automation.

So: **there is no code anywhere in this project that POSTs an application
to an ATS.** On approval, a Workflow instance marks the Notion row
`Status = "Ready to Submit"` and sends a Discord message with a direct link
to the real application — you click submit yourself, on the real site. The
approval gate is a hard requirement per the original spec; this makes it
stricter than asked, not weaker.

## Architecture

```
Notion (shared with the Python watcher)
   ▲                                   │
   │ writes Status/Category/etc.       │ reads Status=Saved rows
   │                                   ▼
src/poller.ts  ──(cron, */10 * * * *)──►  env.APPLY_WORKFLOW.create({ id, params })
                                              │
                                              ▼
                                    src/workflow.ts: ApplyWorkflow
                                    ┌─────────────────────────────┐
                                    │ load job from notion         │
                                    │ mark drafting                │
                                    │ fetch form (ats-forms.ts)    │
                                    │ draft answers (draft.ts, AI) │
                                    │ post to discord              │
                                    │ waitForEvent("approval",     │
                                    │   timeout: 48 hours) ────────┼──┐
                                    └─────────────────────────────┘  │
                                                                      │
                              approved → Ready to Submit + link       │
                              rejected → Skipped                      │
                              timed out → Needs Review                │
                                                                      │
src/index.ts fetch() ── Discord Interactions endpoint ────────────────┘
  (button click → env.APPLY_WORKFLOW.get(id).sendEvent(...))

src/digest.ts ──(cron, daily at 13:00 UTC)── plain Notion query,
  independent of any workflow instance — posts everything currently
  Status=Drafting or Status=Needs Review to Discord. Needs Review rows
  stay in this digest indefinitely, until you change their Status by hand.
```

The Notion `Status` select property (already used by the watcher for
Saved/Applied/OA/Interview/Offer/Rejected/Closed) is extended with pipeline
states — `Drafting`, `Pending Approval`, `Ready to Submit`, `Needs Review`,
`Skipped` — rather than adding a separate tracker. `ensureSchema()` adds
these options (and a `Pipeline Updated` date property used to compute
time-since in the digest) idempotently on first poll.

## Setup

### 1. Discord app

1. Create an application at the [Discord Developer
   Portal](https://discord.com/developers/applications).
2. Under **Bot**, create a bot, copy its token (`DISCORD_BOT_TOKEN`), and
   invite it to your server with the `Send Messages` and `Embed Links`
   permissions. You'll also need the channel ID you want it posting to
   (`DISCORD_CHANNEL_ID`) and the application's `Public Key`
   (`DISCORD_PUBLIC_KEY`), on the application's **General Information**
   page. (The Application ID on that same page isn't needed anywhere in
   this codebase — there's nothing here that calls Discord's application-
   command API.)
3. **There are no slash commands to register.** Every interaction here is a
   button on a message the bot posts itself (Approve/Reject/Edit) — Discord
   doesn't require any registration step for message components, only for
   `/`-style application commands, and this project has none. The only
   Developer Portal step is setting **Interactions Endpoint URL** (under
   General Information) to `https://<your-worker>.<your-subdomain>.workers.dev/`
   once deployed — Discord will send a PING there immediately to verify it,
   which `src/index.ts` answers.

### 2. Notion

Reuses the same integration and parent page as the Python watcher —
`NOTION_TOKEN` and `NOTION_PARENT_PAGE_ID` should be the same values you
already use there. The master database must already exist (run the Python
watcher at least once first); this project finds it by looking for a child
database under the parent page and extends its schema, it never creates
the database itself.

### 3. Your profile

Edit `src/profile.ts` before deploying — it's your name/email/resume
link/etc. used to fill deterministic form fields. Nothing in it is a
credential, but move any field you don't want committed into a Wrangler var
and read it from `env` instead.

### 4. Deploy

```bash
npm install
wrangler kv namespace create PENDING_APPROVALS   # paste the resulting id into wrangler.toml
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_CHANNEL_ID
wrangler secret put NOTION_TOKEN
wrangler secret put NOTION_PARENT_PAGE_ID
npm run deploy
```

`env.AI` (Workers AI, used to draft free-text answers) needs no secret —
it's billed through your Cloudflare account directly. Verify the model id
in `src/draft.ts` (`DRAFT_MODEL`) is still current in your account's
Workers AI catalog before relying on it; that catalog changes over time.

### Cron schedule

Two triggers share one `scheduled()` handler, distinguished by
`event.cron`:

| Cron | Does |
| --- | --- |
| `*/10 * * * *` | Poll Notion for `Status = Saved`, start a Workflow instance per row |
| `0 13 * * *` | Post the daily digest (Drafting + Needs Review rows) |

## Testing

```bash
npm test
```

Covers the happy path (approved → Ready to Submit), the reject path
(rejected → Skipped), and the timeout path (48h elapses → Needs Review),
using Cloudflare's own Workflows testing conventions
(`introspectWorkflowInstance`, `mockStepResult`, `mockEvent`,
`forceEventTimeout` from `cloudflare:test`) rather than a hand-rolled mock
of the step object — these exercise the real Workflows engine's branching,
not just the plain JS logic. Every network-touching step is mocked, so
tests never call real Notion/Discord/Workers AI. You may see a benign
`WorkflowTimeoutError` printed to the console during the timeout test —
that's the real 48-hour timer that `forceEventTimeout` short-circuits still
unwinding in the background; it doesn't fail the test.

## Known limitations, stated plainly

- `src/ats-forms.ts`'s form-field extraction is a best-effort HTML regex
  parse. Greenhouse's and Lever's modern apply forms are largely
  client-rendered, so a plain `fetch()` often sees an empty shell rather
  than real `<input>` elements — when that happens it falls back to a
  generic field guess (flagged in the Discord message) rather than failing.
  Treat this as a starting point to refine per-ATS, not a finished scraper.
- The "Edit" button is currently treated the same as "Reject" (the
  Workflow instance ends, row goes to `Skipped`) — there's no re-drafting
  loop yet. Re-running the pipeline for that job means manually setting its
  Notion row back to `Status = Saved`.
