/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WorkflowInstanceModifier } from "cloudflare:test";

// Every network-touching step is mocked via mockStepResult, so these tests
// never hit real Notion/Discord/Workers AI — they exercise ApplyWorkflow's
// actual branching logic (approve / reject / timeout) through Cloudflare's
// real Workflows engine, using its own testing conventions
// (introspectWorkflowInstance / mockEvent / forceEventTimeout), not a
// hand-rolled mock of the step object.

const BASE_STEP_RESULTS: Array<[string, unknown]> = [
  ["load job from notion", { company: "Acme", title: "SWE Intern", url: "https://boards.greenhouse.io/acme/jobs/1" }],
  ["mark drafting", { mocked: true }],
  ["fetch form", { fields: [], source: "fallback" }],
  ["draft answers", { answers: [], summary: "mock draft summary" }],
  ["post to discord", "mock-approval-token"],
];

async function mockBaseSteps(m: WorkflowInstanceModifier) {
  for (const [name, result] of BASE_STEP_RESULTS) {
    await m.mockStepResult({ name }, result);
  }
}

describe("ApplyWorkflow", () => {
  it("approved: ends at Ready to Submit with decision=approved", async () => {
    const id = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(env.APPLY_WORKFLOW, id);
    await instance.modify(async (m) => {
      await mockBaseSteps(m);
      await m.mockEvent({ type: "discord-approval", payload: { decision: "approved" } });
      await m.mockStepResult({ name: "update notion: ready to submit" }, { mocked: true });
    });

    await env.APPLY_WORKFLOW.create({
      id,
      params: { job_id: "greenhouse:acme:1", notion_page_id: "page-1" },
    });

    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ job_id: "greenhouse:acme:1", decision: "approved" });
  });

  it("rejected: ends at Skipped with decision=rejected", async () => {
    const id = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(env.APPLY_WORKFLOW, id);
    await instance.modify(async (m) => {
      await mockBaseSteps(m);
      await m.mockEvent({ type: "discord-approval", payload: { decision: "rejected" } });
      await m.mockStepResult({ name: "update notion: skipped" }, { mocked: true });
    });

    await env.APPLY_WORKFLOW.create({
      id,
      params: { job_id: "greenhouse:acme:2", notion_page_id: "page-2" },
    });

    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ job_id: "greenhouse:acme:2", decision: "rejected" });
  });

  it("timeout: ends at Needs Review with decision=timed_out, without a real 48-hour wait", async () => {
    const id = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(env.APPLY_WORKFLOW, id);
    await instance.modify(async (m) => {
      await mockBaseSteps(m);
      await m.forceEventTimeout({ name: "approval" });
      await m.mockStepResult({ name: "update notion: needs review" }, { mocked: true });
    });

    await env.APPLY_WORKFLOW.create({
      id,
      params: { job_id: "greenhouse:acme:3", notion_page_id: "page-3" },
    });

    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ job_id: "greenhouse:acme:3", decision: "timed_out" });
  });
});
