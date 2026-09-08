import test from "node:test";
import assert from "node:assert/strict";
import { failureStreak, isHourlyReminder, runScheduled } from "./worker.js";

const originalFetch = globalThis.fetch;
const NOTION_ENV = { GH_PAT: "token", NOTION_TOKEN: "notion-token", NOTION_PARENT_PAGE_ID: "page-1" };

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("uses workflow-specific runs endpoint and detects a failure streak", async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.includes("/blocks/page-1/children") && options?.method !== "PATCH") {
      return Response.json({ results: [], has_more: false });
    }
    if (options?.method === "PATCH") return new Response(null, { status: 200 });
    return Response.json({ workflow_runs: [
      { conclusion: "failure", html_url: "https://github.com/run/2" },
      { conclusion: "cancelled", html_url: "https://github.com/run/1" },
      { conclusion: "success" },
    ] });
  };
  const result = await runScheduled(
    { scheduledTime: "2026-09-06T12:00:00.000Z" },
    NOTION_ENV,
  );
  assert.equal(result.problems.length, 1);
  assert.match(requests[1].url, /actions\/workflows\/watch\.yml\/runs\?status=completed&branch=main/);
  assert.equal(requests[1].options.method, undefined);
  assert.equal(requests.at(-1).options.method, "PATCH");
});

test("handles GitHub network errors and failed alert delivery", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    if (url.includes("dispatches")) throw new Error("offline");
    if (url.includes("/runs?")) return new Response("bad gateway", { status: 502 });
    if (url.includes("api.notion.com")) return new Response("no", { status: 503 });
    return new Response("no", { status: 503 });
  };
  const result = await runScheduled(
    { scheduledTime: "2026-09-06T12:07:00.000Z" },
    NOTION_ENV,
  );
  assert.equal(result.reminder, true);
  assert.equal(result.problems.length, 2);
  assert.equal(calls.length, 4); // dispatch, runs, find-block, write
});

test("detects a stale successful run and writes it to the Notion callout", async () => {
  const patches = [];
  globalThis.fetch = async (url, options) => {
    if (url.includes("/blocks/page-1/children") && options?.method !== "PATCH") {
      return Response.json({ results: [], has_more: false });
    }
    if (options?.method === "PATCH") {
      patches.push(JSON.parse(options.body));
      return new Response(null, { status: 200 });
    }
    return Response.json({ workflow_runs: [{
      conclusion: "success",
      completed_at: "2026-09-06T10:00:00Z",
      html_url: "https://github.com/run/old",
    }] });
  };
  await runScheduled(
    { scheduledTime: Date.parse("2026-09-06T12:00:00.000Z") },
    NOTION_ENV,
  );
  const content = patches.at(-1).children[0].callout.rich_text[0].text.content;
  assert.match(content, /latest successful run is 120 minutes old/);
});

test("reuses an existing health callout block instead of creating a new one", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options?.method });
    if (url.includes("/blocks/page-1/children") && !options?.method) {
      return Response.json({
        results: [{ id: "block-9", type: "callout", callout: { icon: { emoji: "🩺" } } }],
        has_more: false,
      });
    }
    if (options?.method === "PATCH" && url.endsWith("/blocks/block-9")) {
      return new Response(null, { status: 200 });
    }
    return Response.json({ workflow_runs: [{ conclusion: "failure", html_url: "u" }] });
  };
  await runScheduled({ scheduledTime: "2026-09-06T12:00:00.000Z" }, NOTION_ENV);
  assert.ok(calls.some((c) => c.url.endsWith("/blocks/block-9") && c.method === "PATCH"));
});

test("does not deliver non-hourly failure alerts", async () => {
  let alertCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (url.includes("api.notion.com")) alertCalls += 1;
    if (options?.method === "POST") throw new Error("offline");
    return new Response("bad gateway", { status: 502 });
  };
  const result = await runScheduled(
    { scheduledTime: "2026-09-06T12:10:00.000Z" },
    NOTION_ENV,
  );
  assert.equal(result.reminder, false);
  assert.equal(result.problems.length, 2);
  assert.equal(alertCalls, 0);
});

test("skips alert delivery without Notion credentials configured", async () => {
  let notionCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes("api.notion.com")) notionCalls += 1;
    return Response.json({ workflow_runs: [{ conclusion: "success", completed_at: new Date().toISOString() }] });
  };
  const result = await runScheduled(
    { scheduledTime: "2026-09-06T12:00:00.000Z" },
    { GH_PAT: "token" },
  );
  assert.equal(result.reminder, true);
  assert.equal(notionCalls, 0);
});

test("hourly gating uses the scheduled event time and is stateless", () => {
  assert.equal(isHourlyReminder("2026-09-06T12:00:00Z"), true);
  assert.equal(isHourlyReminder("2026-09-06T12:09:00Z"), true);
  assert.equal(isHourlyReminder("2026-09-06T12:10:00Z"), false);
  assert.deepEqual(failureStreak([
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { conclusion: "success" },
  ]), 2);
});
