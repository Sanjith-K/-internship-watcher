export interface Env {
  NOTION_TOKEN: string;
  NOTION_PARENT_PAGE_ID: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_CHANNEL_ID: string;
  APPLY_WORKFLOW: Workflow;
  PENDING_APPROVALS: KVNamespace;
  AI: Ai;
}

// Params passed to a new ApplyWorkflow instance at creation time.
export interface ApplyWorkflowParams {
  job_id: string; // canonical job identity, per job-identity.ts
  notion_page_id: string;
}

// What a Discord button interaction resolves ApplyWorkflow's waitForEvent
// with. "edit" is treated as a reject-with-a-note for now (see workflow.ts).
export type ApprovalDecision = "approved" | "rejected" | "edit";

export interface ApprovalEvent {
  decision: ApprovalDecision;
  note?: string;
}

// Stored in PENDING_APPROVALS KV, keyed by the short token embedded in each
// Discord button's custom_id (job identities are often too long — Discord
// caps custom_id at 100 chars).
export interface PendingApproval {
  job_identity: string;
  workflow_instance_id: string;
  notion_page_id: string;
}
