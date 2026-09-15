import { postToChannel } from "./discord";
import { pageCompany, pagePipelineUpdated, pageStatus, pageTitle, PIPELINE_STATUSES, queryByStatus } from "./notion";
import type { Env } from "./types";

function timeSince(date: Date | null): string {
  if (!date) return "unknown time";
  const hours = Math.floor((Date.now() - date.getTime()) / 3600_000);
  if (hours < 1) return "less than an hour";
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** A plain Notion query + one Discord message — deliberately independent of
 * any individual ApplyWorkflow instance's waitForEvent. Needs Review rows
 * stay in this digest for as long as they remain Needs Review (there's no
 * "already alerted, suppress next time" bookkeeping anywhere — every run
 * re-queries current Notion state, same pattern the rest of this repo
 * already uses), so a missed digest never means a silently-dropped failure. */
export async function postDailyDigest(env: Env): Promise<void> {
  const pages = await queryByStatus(env, [PIPELINE_STATUSES.DRAFTING, PIPELINE_STATUSES.NEEDS_REVIEW]);
  if (pages.length === 0) {
    await postToChannel(env.DISCORD_BOT_TOKEN, env.DISCORD_CHANNEL_ID, {
      content: "🩺 Pipeline digest: nothing stuck in Drafting, nothing in Needs Review.",
    });
    return;
  }

  const drafting = pages.filter((p) => pageStatus(p) === PIPELINE_STATUSES.DRAFTING);
  const needsReview = pages.filter((p) => pageStatus(p) === PIPELINE_STATUSES.NEEDS_REVIEW);

  const lines: string[] = ["🩺 **Pipeline digest**"];
  if (drafting.length) {
    lines.push(`\n**Stuck in Drafting (${drafting.length})** — normally a transient state; this long suggests something's stuck:`);
    for (const p of drafting) {
      lines.push(`• ${pageCompany(p)} — ${pageTitle(p)} — posted ${timeSince(pagePipelineUpdated(p))} ago`);
    }
  }
  if (needsReview.length) {
    lines.push(`\n**Needs Review (${needsReview.length})** — timed out waiting for approval:`);
    for (const p of needsReview) {
      lines.push(`• ${pageCompany(p)} — ${pageTitle(p)} — timed out ${timeSince(pagePipelineUpdated(p))} ago`);
    }
  }
  await postToChannel(env.DISCORD_BOT_TOKEN, env.DISCORD_CHANNEL_ID, { content: lines.join("\n").slice(0, 2000) });
}
