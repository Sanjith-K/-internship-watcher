import { jobIdentity, workflowInstanceId } from "./job-identity";
import { ensureSchema, pageLink, queryByStatus } from "./notion";
import type { ApplyWorkflowParams, Env } from "./types";

/** Every 10 minutes: find Status=Saved rows and start a new ApplyWorkflow
 * instance for each one that doesn't already have one. Deliberately
 * decoupled from watcher.py — this only ever reads/writes Notion, never
 * imports or calls into the Python watcher, so the two stay independent
 * and communicate purely through the shared database. */
export async function pollAndStartWorkflows(env: Env): Promise<{ started: number; skipped: number }> {
  await ensureSchema(env);
  const saved = await queryByStatus(env, ["Saved"]);
  let started = 0;
  let skipped = 0;
  for (const page of saved) {
    const link = pageLink(page);
    if (!link) {
      skipped++;
      continue;
    }
    const identity = jobIdentity(link, page.id);
    const instanceId = await workflowInstanceId(identity);
    const params: ApplyWorkflowParams = { job_id: identity, notion_page_id: page.id };
    try {
      await env.APPLY_WORKFLOW.create({ id: instanceId, params });
      started++;
    } catch (err) {
      // Cloudflare Workflows rejects create() with a duplicate id when an
      // instance already exists — that's the expected/common case here
      // (a row we've already picked up on a prior poll), not an error.
      if (!/already exists/i.test((err as Error).message ?? "")) throw err;
      skipped++;
    }
  }
  return { started, skipped };
}
