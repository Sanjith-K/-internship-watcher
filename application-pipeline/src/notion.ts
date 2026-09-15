import type { Env } from "./types";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// Extends the same "Status" select property notion_sync.py already owns
// (Saved/Applied/OA/Interview/Offer/Rejected/Closed) with pipeline states.
// Deliberately reusing one property rather than adding new ones, per the
// instruction not to resurrect a separate tracker: the Status column is
// still the single source of truth for where a job stands.
export const PIPELINE_STATUSES = {
  DRAFTING: "Drafting",
  PENDING_APPROVAL: "Pending Approval",
  READY_TO_SUBMIT: "Ready to Submit",
  NEEDS_REVIEW: "Needs Review",
  SKIPPED: "Skipped",
} as const;

const PIPELINE_STATUS_COLORS: Record<string, string> = {
  [PIPELINE_STATUSES.DRAFTING]: "purple",
  [PIPELINE_STATUSES.PENDING_APPROVAL]: "pink",
  [PIPELINE_STATUSES.READY_TO_SUBMIT]: "green",
  [PIPELINE_STATUSES.NEEDS_REVIEW]: "red",
  [PIPELINE_STATUSES.SKIPPED]: "gray",
};

interface NotionPage {
  id: string;
  properties: Record<string, any>;
}

async function notionFetch(
  env: Env,
  method: string,
  path: string,
  payload?: unknown,
): Promise<any> {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

let cachedMasterDb: string | null = null;

/** Finds the "All Internship Postings" database under the parent page.
 * Cached per-invocation (Workers are short-lived, so no cross-request
 * staleness risk worth worrying about). */
export async function findMasterDb(env: Env): Promise<string> {
  if (cachedMasterDb) return cachedMasterDb;
  const res = await notionFetch(env, "GET", `/blocks/${env.NOTION_PARENT_PAGE_ID}/children?page_size=100`);
  const db = (res.results || []).find((b: any) => b.type === "child_database");
  if (!db) {
    throw new Error(
      "No database found under NOTION_PARENT_PAGE_ID — run the Python watcher at least once first so it creates the master database.",
    );
  }
  cachedMasterDb = db.id;
  return db.id;
}

/** Idempotently adds the pipeline Status options and a "Pipeline Updated"
 * date property to the database schema, merging with (never replacing)
 * whatever options already exist. */
export async function ensureSchema(env: Env): Promise<void> {
  const db = await findMasterDb(env);
  const current = await notionFetch(env, "GET", `/databases/${db}`);
  const existingOptions: Array<{ name: string; color: string }> =
    current.properties?.Status?.select?.options ?? [];
  const existingNames = new Set(existingOptions.map((o) => o.name));
  const merged = [...existingOptions];
  for (const name of Object.values(PIPELINE_STATUSES)) {
    if (!existingNames.has(name)) {
      merged.push({ name, color: PIPELINE_STATUS_COLORS[name] ?? "default" });
    }
  }
  const hasTimestampProp = Boolean(current.properties?.["Pipeline Updated"]);
  if (merged.length === existingOptions.length && hasTimestampProp) {
    return; // already up to date
  }
  await notionFetch(env, "PATCH", `/databases/${db}`, {
    properties: {
      Status: { select: { options: merged } },
      "Pipeline Updated": { date: {} },
    },
  });
}

export async function queryByStatus(env: Env, statuses: string[]): Promise<NotionPage[]> {
  const db = await findMasterDb(env);
  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  const filter =
    statuses.length === 1
      ? { property: "Status", select: { equals: statuses[0] } }
      : { or: statuses.map((s) => ({ property: "Status", select: { equals: s } })) };
  for (;;) {
    const res = await notionFetch(env, "POST", `/databases/${db}/query`, {
      filter,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return pages;
}

export async function getPage(env: Env, pageId: string): Promise<NotionPage> {
  return notionFetch(env, "GET", `/pages/${pageId}`);
}

/** Sets Status and stamps "Pipeline Updated" to now in one call — every
 * pipeline-state transition goes through this so the daily digest can
 * always compute an accurate time-since. */
export async function setPipelineStatus(
  env: Env,
  pageId: string,
  status: string,
  extraProperties: Record<string, unknown> = {},
): Promise<void> {
  await notionFetch(env, "PATCH", `/pages/${pageId}`, {
    properties: {
      Status: { select: { name: status } },
      "Pipeline Updated": { date: { start: new Date().toISOString() } },
      ...extraProperties,
    },
  });
}

export function pageTitle(page: NotionPage): string {
  return (page.properties?.Role?.title ?? [])
    .map((t: any) => t.plain_text ?? t.text?.content ?? "")
    .join("");
}

export function pageCompany(page: NotionPage): string {
  return (page.properties?.Company?.rich_text ?? [])
    .map((t: any) => t.plain_text ?? t.text?.content ?? "")
    .join("");
}

export function pageLink(page: NotionPage): string {
  return page.properties?.Link?.url ?? "";
}

export function pagePipelineUpdated(page: NotionPage): Date | null {
  const start = page.properties?.["Pipeline Updated"]?.date?.start;
  return start ? new Date(start) : null;
}

export function pageStatus(page: NotionPage): string | null {
  return page.properties?.Status?.select?.name ?? null;
}
