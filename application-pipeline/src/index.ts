import { postDailyDigest } from "./digest";
import {
  InteractionResponseType,
  InteractionType,
  parseCustomId,
  verifyDiscordRequest,
} from "./discord";
import { pollAndStartWorkflows } from "./poller";
import type { ApprovalEvent, Env, PendingApproval } from "./types";
import { ApplyWorkflow } from "./workflow";

// Cloudflare Workflows requires the class to be exported from the Worker's
// main module (this file), not just from workflow.ts, for the [[workflows]]
// class_name binding in wrangler.toml to resolve.
export { ApplyWorkflow };

const POLL_CRON = "*/10 * * * *";
const DIGEST_CRON = "0 13 * * *";

async function handleInteraction(request: Request, env: Env): Promise<Response> {
  const { valid, body } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
  if (!valid) {
    return new Response("invalid request signature", { status: 401 });
  }
  const interaction = JSON.parse(body);

  if (interaction.type === InteractionType.PING) {
    return Response.json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const parsed = parseCustomId(interaction.data?.custom_id ?? "");
    if (!parsed) {
      return Response.json({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: { content: "⚠️ Unrecognized button — nothing changed.", components: [] },
      });
    }
    const raw = await env.PENDING_APPROVALS.get(parsed.token);
    if (!raw) {
      return Response.json({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: { content: "⚠️ This approval request has expired or was already handled.", components: [] },
      });
    }
    const pending: PendingApproval = JSON.parse(raw);
    const decision: ApprovalEvent["decision"] =
      parsed.action === "approve" ? "approved" : parsed.action === "reject" ? "rejected" : "edit";

    const instance = await env.APPLY_WORKFLOW.get(pending.workflow_instance_id);
    await instance.sendEvent({ type: "discord-approval", payload: { decision } satisfies ApprovalEvent });
    await env.PENDING_APPROVALS.delete(parsed.token);

    const labels: Record<ApprovalEvent["decision"], string> = {
      approved: "✅ Approved",
      rejected: "❌ Rejected",
      edit: "✏️ Marked for edit (treated as rejected for now — re-approve isn't wired up yet)",
    };
    return Response.json({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content: labels[decision], components: [] },
    });
  }

  return new Response("unhandled interaction type", { status: 400 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("expected a Discord Interactions POST", { status: 405 });
    }
    return handleInteraction(request, env);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === DIGEST_CRON) {
      ctx.waitUntil(postDailyDigest(env));
      return;
    }
    if (event.cron === POLL_CRON) {
      ctx.waitUntil(pollAndStartWorkflows(env).then((r) => console.log(`poller: started ${r.started}, skipped ${r.skipped}`)));
      return;
    }
    console.log(`scheduled() fired for unrecognized cron: ${event.cron}`);
  },
};
