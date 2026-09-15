import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { fetchFormSchema } from "./ats-forms";
import { buildDraftMessage, postToChannel } from "./discord";
import { draftApplication } from "./draft";
import { getPage, pageCompany, pageLink, pageTitle, PIPELINE_STATUSES, setPipelineStatus } from "./notion";
import type { ApplyWorkflowParams, ApprovalEvent, Env, PendingApproval } from "./types";

const APPROVAL_TIMEOUT = "48 hours";

export class ApplyWorkflow extends WorkflowEntrypoint<Env, ApplyWorkflowParams> {
  async run(event: WorkflowEvent<ApplyWorkflowParams>, step: WorkflowStep) {
    const { job_id, notion_page_id } = event.payload;
    const env = this.env;

    const job = await step.do("load job from notion", async () => {
      const page = await getPage(env, notion_page_id);
      return { company: pageCompany(page), title: pageTitle(page), url: pageLink(page) };
    });

    await step.do("mark drafting", async () => {
      await setPipelineStatus(env, notion_page_id, PIPELINE_STATUSES.DRAFTING);
    });

    const schema = await step.do("fetch form", async () => fetchFormSchema(job.url));

    const draft = await step.do("draft answers", async () => draftApplication(env, job.company, job.title, schema));

    await step.do("post to discord", async () => {
      const approvalToken = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
      const pending: PendingApproval = {
        job_identity: job_id,
        workflow_instance_id: event.instanceId,
        notion_page_id,
      };
      await env.PENDING_APPROVALS.put(approvalToken, JSON.stringify(pending), {
        // A little past the waitForEvent timeout so a late click still resolves cleanly.
        expirationTtl: 60 * 60 * 60,
      });
      await postToChannel(
        env.DISCORD_BOT_TOKEN,
        env.DISCORD_CHANNEL_ID,
        buildDraftMessage({ company: job.company, title: job.title, url: job.url, draftSummary: draft.summary }, approvalToken),
      );
      await setPipelineStatus(env, notion_page_id, PIPELINE_STATUSES.PENDING_APPROVAL);
      return approvalToken;
    });

    let decision: ApprovalEvent["decision"] | "timed_out";
    try {
      const approval = await step.waitForEvent<ApprovalEvent>("approval", {
        type: "discord-approval",
        timeout: APPROVAL_TIMEOUT,
      });
      decision = approval.payload.decision;
    } catch {
      decision = "timed_out";
    }

    if (decision === "approved") {
      await step.do("update notion: ready to submit", async () => {
        // No automated submission exists anywhere in this codebase, by design
        // (see README: Greenhouse/Lever ToS for automated submission could
        // not be confirmed safe). Approval hands off to a human clicking the
        // real apply link — this step never POSTs to an ATS.
        await setPipelineStatus(env, notion_page_id, PIPELINE_STATUSES.READY_TO_SUBMIT);
        await postToChannel(env.DISCORD_BOT_TOKEN, env.DISCORD_CHANNEL_ID, {
          content: `✅ Approved — **${job.company} — ${job.title}**. Submit it yourself here: ${job.url}`,
        });
      });
    } else if (decision === "timed_out") {
      await step.do("update notion: needs review", async () => {
        await setPipelineStatus(env, notion_page_id, PIPELINE_STATUSES.NEEDS_REVIEW);
      });
    } else {
      await step.do("update notion: skipped", async () => {
        await setPipelineStatus(env, notion_page_id, PIPELINE_STATUSES.SKIPPED);
      });
    }

    return { job_id, decision };
  }
}
