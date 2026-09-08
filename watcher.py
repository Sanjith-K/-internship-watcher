#!/usr/bin/env python3
"""
Internship Watcher
------------------
Polls public job-board APIs (Greenhouse, Lever, Ashby) for the companies in
config.json, plus the SimplifyJobs aggregated internship feed, filters for
internship roles matching your keywords, tags each match with its category
(quant/general), dedupes against seen.json, and delivers a per-run email
digest plus a Notion master log.

Designed to run on a schedule (GitHub Actions cron, or local cron). Each run
checkpoints delivery, deduplication, and tracker state for safe retries.
"""

import argparse
import os
import re
import smtplib
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.mime.text import MIMEText
from pathlib import Path

import requests

from job_utils import (load_json, save_json, canonical_url, job_identity,
                       fingerprint, term_matches, categorize)

ROOT = Path(__file__).parent
CONFIG_PATH = ROOT / "config.json"
SEEN_PATH = ROOT / "seen.json"

SIMPLIFY_URL = (
    "https://raw.githubusercontent.com/SimplifyJobs/"
    "Summer2026-Internships/dev/.github/scripts/listings.json"
)

HEADERS = {"User-Agent": "internship-watcher/1.0 (personal job alert script)"}
TIMEOUT = 20


# ---------------------------------------------------------------- utilities

def matches(title: str, include_kw, exclude_kw) -> bool:
    t = title.lower()
    if not any(k.lower() in t for k in include_kw):
        return False
    if any(k.lower() in t for k in exclude_kw):
        return False
    return True


SOURCE_HEALTH = {}


def fetch(url, as_text=False):
    previous = SOURCE_HEALTH.get(url, {})
    for attempt in range(3):
        try:
            r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
            if r.status_code == 200:
                result = r.text if as_text else r.json()
                SOURCE_HEALTH[url] = {"ok": True, "last_success": time.time()}
                return result
            error = f"HTTP {r.status_code}"
            if r.status_code != 429 and r.status_code < 500:
                break
        except (requests.RequestException, ValueError) as exc:
            error = type(exc).__name__
        if attempt < 2:
            time.sleep(2 ** attempt)
    SOURCE_HEALTH[url] = {**previous, "ok": False, "error": error}
    print(f"  [warn] {url} -> {error}")
    return None


def get(url):
    return fetch(url)


def get_text(url):
    return fetch(url, as_text=True)


def norm_key(job) -> str:
    """Company+title fingerprint for deduping the same job across sources."""
    return "norm:" + re.sub(r"[^a-z0-9]+", "", (job["company"] + job["title"]).lower())


def company_matches(company: str, keywords) -> bool:
    """Word-boundary keyword match, so "unity" hits "Unity" but not
    "Ivy Tech Community College", and "arm" not "Farmers"."""
    c = company.lower()
    return any(re.search(rf"\b{re.escape(k)}\b", c) for k in keywords)


# "City, ST" with a US state code (no overlap with Canadian provinces), or an
# explicit USA mention. The (?=\W|$) stops ", IN" from matching ", India".
_US_HINT = re.compile(
    r"\b(?:usa|u\.s\.|united states)\b|,\s*(?:"
    r"AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|"
    r"MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|"
    r"WA|WV|WI|WY|DC)(?=\W|$)", re.IGNORECASE)


def location_excluded(location: str, patterns) -> bool:
    """True if the location names an excluded country/city. Word-boundary
    match so "india" doesn't hit "Indianapolis, IN", and anything carrying
    a US state code or USA survives ("Dublin, OH" vs "Dublin"). Unknown/
    empty locations are kept — better a stray ping than a missed posting."""
    loc = (location or "").lower()
    if not any(re.search(rf"\b{re.escape(p)}\b", loc) for p in patterns):
        return False
    return not _US_HINT.search(location or "")


# ------------------------------------------------------------- ATS fetchers

def source_items(url, key=None):
    previous_success = SOURCE_HEALTH.get(url, {}).get("last_success")
    data = get(url)
    if data is None:
        return []
    items = data.get(key) if key and isinstance(data, dict) else data if not key else None
    if not isinstance(items, list) or not all(isinstance(j, dict) and j.get("id") is not None for j in items):
        SOURCE_HEALTH[url] = {"ok": False, "error": "Unexpected feed schema"}
        if previous_success is not None:
            SOURCE_HEALTH[url]["last_success"] = previous_success
        return []
    return items


def fetch_greenhouse(board: str):
    """Greenhouse public board API."""
    data = source_items(f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs", "jobs")
    return [
        {
            "id": f"greenhouse:{board}:{j['id']}",
            "title": j.get("title", ""),
            "location": (j.get("location") or {}).get("name", ""),
            "url": j.get("absolute_url", ""),
        }
        for j in data
    ]


def fetch_lever(org: str):
    """Lever public postings API."""
    data = source_items(f"https://api.lever.co/v0/postings/{org}?mode=json")
    return [
        {
            "id": f"lever:{org}:{j.get('id')}",
            "title": j.get("text", ""),
            "location": (j.get("categories") or {}).get("location", ""),
            "url": j.get("hostedUrl", ""),
        }
        for j in data
    ]


def fetch_ashby(org: str):
    """Ashby public job-board API."""
    data = source_items(f"https://api.ashbyhq.com/posting-api/job-board/{org}", "jobs")
    return [
        {
            "id": f"ashby:{org}:{j.get('id')}",
            "title": j.get("title", ""),
            "location": j.get("location", ""),
            "url": j.get("jobUrl") or j.get("applyUrl", ""),
        }
        for j in data
    ]


ATS_FETCHERS = {
    "greenhouse": fetch_greenhouse,
    "lever": fetch_lever,
    "ashby": fetch_ashby,
}


def fetch_simplify(cfg):
    """SimplifyJobs aggregated internship list (covers Workday/etc. companies)."""
    data = source_items(cfg.get("simplify", {}).get("url", SIMPLIFY_URL))
    sim = cfg.get("simplify", {})
    company_filter = [c.lower() for c in sim.get("company_keywords", [])]
    min_age_days = sim.get("max_age_days", 14)
    cutoff = time.time() - min_age_days * 86400

    out = []
    for j in data:
        if not j.get("active") or not j.get("is_visible", True):
            continue
        if j.get("date_posted", 0) < cutoff:
            continue
        company = j.get("company_name", "")
        if company_filter and not company_matches(company, company_filter):
            continue
        out.append(
            {
                "id": f"simplify:{j.get('id')}",
                "terms": j.get("terms", []),
                "company": company,
                "title": j.get("title", ""),
                "location": ", ".join(j.get("locations", [])[:3]),
                "url": j.get("url", ""),
            }
        )
    return out


JOBRIGHT_ROW = re.compile(
    r"^\|\s*(?:\*\*\[(?P<company>.+?)\]\(.*?\)\*\*|↳)\s*"
    r"\|\s*\*\*\[(?P<title>.+?)\]\((?P<url>https://jobright\.ai/jobs/info/(?P<jid>[0-9a-f]+)\S*?)\)\*\*\s*"
    r"\|\s*(?P<location>.*?)\s*\|.*?\|\s*(?P<date>\w{3} \d{2})\s*\|"
)


def fetch_jobright(cfg):
    """Jobright/intern-list.com listings, published to their GitHub repos as
    markdown tables (one repo per category, rolling window of recent posts)."""
    jr = cfg.get("jobright", {})
    max_age_days = jr.get("max_age_days", 7)
    now = datetime.now(timezone.utc)

    out = []
    for repo in jr.get("repos", []):
        url = f"https://raw.githubusercontent.com/jobright-ai/{repo}/master/README.md"
        text = get_text(url)
        if not text:
            continue
        company = None
        parsed_rows = 0
        for line in text.splitlines():
            m = JOBRIGHT_ROW.match(line)
            if not m:
                continue
            parsed_rows += 1
            company = m["company"] or company  # ↳ rows inherit the company
            if not company:
                continue
            # "Jun 09" has no year: assume the most recent past occurrence
            try:
                posted = datetime.strptime(m["date"] + f" {now.year}", "%b %d %Y").replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            if posted > now:
                posted = posted.replace(year=now.year - 1)
            if (now - posted).days > max_age_days:
                continue
            out.append(
                {
                    "id": f"jobright:{m['jid']}",
                    "company": company,
                    "title": m["title"],
                    "location": m["location"],
                    "url": canonical_url(m["url"]),
                }
            )
        if not parsed_rows:
            SOURCE_HEALTH[url] = {**SOURCE_HEALTH.get(url, {}), "ok": False,
                                  "error": "No parseable Jobright rows"}
    return out


# ------------------------------------------------------------ notifications

CATEGORY_LABELS = {"quant": "Quant", "general": "General"}


def _digest_body(jobs):
    """Group jobs by category so the digest reads as Quant / General
    sections; a job tagged both appears in both sections."""
    sections = []
    for key, label in CATEGORY_LABELS.items():
        in_section = [j for j in jobs if key in (j.get("categories") or ["general"])]
        if not in_section:
            continue
        lines = [f"=== {label} ({len(in_section)}) ==="]
        for j in in_section:
            lines.append(f"{j['company']} — {j['title']}")
            if j.get("location"):
                lines.append(f"  {j['location']}")
            lines.append(f"  {j['url']}")
        sections.append("\n".join(lines))
    return "\n\n".join(sections)


def notify_email(cfg, jobs):
    """One digest per call, grouped by category. Caller batches every job
    still pending email delivery into a single per-run send."""
    host = os.environ.get("SMTP_HOST", cfg.get("smtp_host", "smtp.gmail.com"))
    port = int(os.environ.get("SMTP_PORT", cfg.get("smtp_port", 587)))
    user = os.environ["SMTP_USER"]
    password = os.environ["SMTP_PASS"]
    to_addr = os.environ.get("ALERT_EMAIL", user)

    msg = MIMEText(_digest_body(jobs))
    msg["Subject"] = f"[Internship Watcher] {len(jobs)} new posting(s)"
    msg["From"] = user
    msg["To"] = to_addr

    with smtplib.SMTP(host, port, timeout=30) as s:
        s.starttls()
        s.login(user, password)
        s.sendmail(user, [to_addr], msg.as_string())


# -------------------------------------------------------------------- main

def discover(cfg):
    jobs = []
    include = cfg.get("include_keywords", ["intern"])
    exclude = cfg.get("exclude_keywords", [])

    def company_jobs(c):
        try:
            fetcher = ATS_FETCHERS[c["ats"]]
            return c, fetcher(c["board"])
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            SOURCE_HEALTH["board:" + c.get("board", "unknown")] = {
                "ok": False, "error": type(exc).__name__}
            return c, []

    print(f"Checking {len(cfg.get('companies', []))} company boards...")
    with ThreadPoolExecutor(max_workers=16) as executor:
        for company, found in executor.map(company_jobs, cfg.get("companies", [])):
            jobs.extend({**j, "company": company["name"]} for j in found)
    for name, fetcher in (("simplify", fetch_simplify), ("jobright", fetch_jobright)):
        if cfg.get(name, {}).get("enabled", name == "simplify"):
            try:
                jobs.extend({**j, "agg": True} for j in fetcher(cfg))
            except (KeyError, TypeError, ValueError, AttributeError) as exc:
                SOURCE_HEALTH[name] = {"ok": False, "error": type(exc).__name__}
    terms = cfg.get("terms", cfg.get("simplify", {}).get("terms", []))
    category_terms = cfg.get("category_terms", {})
    matched = [j for j in jobs if matches(j["title"], include, exclude)
               and not location_excluded(j.get("location", ""), cfg.get("exclude_locations", []))
               and term_matches(j, terms, cfg.get("keep_unknown_terms", True))]
    for j in matched:
        j["categories"] = categorize(j, category_terms)
    return matched


def select_new(jobs, seen, ledger, now, ttl_days=30):
    """Exact identities persist; fuzzy cross-source fingerprints expire."""
    identities = ledger.setdefault("identities", {})
    prints = ledger.setdefault("fingerprints", {})
    cutoff = now - ttl_days * 86400
    prints = ledger["fingerprints"] = {k: v for k, v in prints.items() if v >= cutoff}
    new = []
    # Existing IDs seed current fingerprints without resurrecting old alerts.
    for j in jobs:
        if j["id"] in seen:
            identities[job_identity(j)] = j["id"]
            prints.setdefault(fingerprint(j), now)
    for j in jobs:
        identity, fp = job_identity(j), fingerprint(j)
        if j["id"] not in seen and identity not in identities:
            if not (j.get("agg") and fp in prints):
                new.append(j)
        seen.add(j["id"])
        identities[identity] = j["id"]
        prints.setdefault(fp, now)
    return new


def destinations(job, cfg):
    result = []
    if os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASS"):
        result.append("email")
    if os.environ.get("NOTION_TOKEN") and os.environ.get("NOTION_PARENT_PAGE_ID"):
        result.append("notion")
    return result


def deliver(ledger, cfg, checkpoint):
    pending = ledger.setdefault("pending", {})
    # Notion stays per-job so one failure doesn't block the rest of the batch.
    for entry in list(pending.values()):
        if "notion" not in entry["destinations"]:
            continue
        try:
            import notion_sync
            if notion_sync.log_master(entry["job"]):
                entry["destinations"].remove("notion")
                entry.pop("error", None)
            else:
                entry["attempts"] = entry.get("attempts", 0) + 1
        except (requests.RequestException, OSError, ValueError, KeyError) as exc:
            entry["error"] = type(exc).__name__
        checkpoint()
    # Email is a single per-run digest grouped by category, not one send per job.
    email_entries = [e for e in pending.values() if "email" in e["destinations"]]
    if email_entries:
        try:
            notify_email(cfg, [e["job"] for e in email_entries])
            for e in email_entries:
                e["destinations"].remove("email")
                e.pop("error", None)
        except (smtplib.SMTPException, OSError, ValueError, KeyError) as exc:
            for e in email_entries:
                e["error"] = type(exc).__name__
                e["attempts"] = e.get("attempts", 0) + 1
        checkpoint()
    ledger["pending"] = {k: v for k, v in pending.items() if v["destinations"]}
    checkpoint()


def validate_config(cfg):
    if not isinstance(cfg, dict) or not isinstance(cfg.get("companies"), list):
        raise ValueError("config.json must contain a companies list")
    for company in cfg["companies"]:
        if not isinstance(company, dict) or not all(isinstance(company.get(k), str) and company[k]
                                                   for k in ("name", "ats", "board")):
            raise ValueError("Every company needs name, ats, and board strings")
        if company["ats"] not in ATS_FETCHERS:
            raise ValueError("Unsupported ATS: " + company["ats"])
    for key in ("dedup_days", "follow_up_days"):
        if key in cfg and (type(cfg[key]) is not int or cfg[key] < 0):
            raise ValueError(key + " must be a non-negative integer")
    for key in ("terms", "include_keywords", "exclude_keywords", "exclude_locations"):
        if key in cfg and (not isinstance(cfg[key], list) or not all(isinstance(v, str) for v in cfg[key])):
            raise ValueError(key + " must be a list of strings")
    category_terms = cfg.get("category_terms", {})
    if not isinstance(category_terms, dict):
        raise ValueError("category_terms must be an object")
    for key in ("quant", "general"):
        if key in category_terms and (not isinstance(category_terms[key], list)
                                      or not all(isinstance(v, str) for v in category_terms[key])):
            raise ValueError("category_terms." + key + " must be a list of strings")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Fetch and preview without writes or notifications")
    args = parser.parse_args(argv)
    cfg = load_json(CONFIG_PATH, {})
    validate_config(cfg)
    enabled = bool(os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASS"))
    enabled |= bool(os.environ.get("NOTION_TOKEN") and os.environ.get("NOTION_PARENT_PAGE_ID"))
    dry_run = args.dry_run or not enabled
    ledger_path = ROOT / "delivery_state.json"
    health_path = ROOT / "health.json"
    ledger = load_json(ledger_path, {})
    # One-time migration: drop queued Discord destinations from a pre-upgrade
    # ledger. Those webhooks are gone, so the entries could never deliver.
    for entry in ledger.get("pending", {}).values():
        entry["destinations"] = [d for d in entry["destinations"] if not d.startswith("discord:")]
    # Ledger IDs are authoritative after a crash between the two state writes.
    seen = set(load_json(SEEN_PATH, [])) | set(ledger.get("known_ids", []))
    previous_health = load_json(health_path, {})
    SOURCE_HEALTH.clear()
    SOURCE_HEALTH.update(previous_health.get("sources", {}))
    old_sources = dict(SOURCE_HEALTH)
    all_jobs = discover(cfg)
    # Retain only sources actually fetched this run.
    current_sources = {k: v for k, v in SOURCE_HEALTH.items() if v is not old_sources.get(k)}
    now = time.time()
    new_jobs = select_new(all_jobs, seen, ledger, now, cfg.get("dedup_days", 30))
    print(f"Found {len(all_jobs)} matching postings, {len(new_jobs)} new.")
    for j in new_jobs:
        print(f"  NEW: {j['company']} — {j['title']} ({j['url']})")
    if dry_run:
        print("Dry run: no state changes, notifications, or Notion calls.")
        return 0

    pending = ledger.setdefault("pending", {})
    for j in new_jobs:
        targets = destinations(j, cfg)
        if targets:
            pending.setdefault(j["id"], {"job": j, "destinations": targets, "created": now})
    ledger["known_ids"] = sorted(seen)
    checkpoint = lambda: save_json(ledger_path, ledger)
    checkpoint()  # persist intent before any external side effect
    save_json(SEEN_PATH, sorted(seen))
    sync_error = None
    try:
        deliver(ledger, cfg, checkpoint)
        if os.environ.get("NOTION_TOKEN") and os.environ.get("NOTION_PARENT_PAGE_ID"):
            import notion_sync
            notion_sync.run([], cfg=cfg)
    except Exception as exc:
        sync_error = type(exc).__name__
        print(f"[error] Sync failed: {sync_error}; checkpointed work will retry.")
    failures = sum(not v.get("ok") for v in current_sources.values())
    health = {"last_completed_scan": now, "sources": current_sources,
              "successful_sources": len(current_sources) - failures, "failed_sources": failures,
              "matching_jobs": len(all_jobs), "new_jobs": len(new_jobs),
              "pending_deliveries": sum(len(v["destinations"]) for v in ledger["pending"].values()),
              "sync_error": sync_error}
    save_json(health_path, health)
    summary = (f"Sources: {health['successful_sources']} OK, {failures} failed; "
               f"pending deliveries: {health['pending_deliveries']}; sync: {sync_error or 'OK'}")
    print(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
            stream.write(summary + "\n")
    return int(bool(failures or sync_error or health["pending_deliveries"]))


if __name__ == "__main__":
    sys.exit(main())
