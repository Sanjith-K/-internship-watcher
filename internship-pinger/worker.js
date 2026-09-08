const DEFAULT_REPO = "avyukthNarra/-internship-watcher";
const WORKFLOW = "watch.yml";
const RUNS_PER_REQUEST = 10;
const STALE_AFTER_MS = 30 * 60 * 1000;
const NOTION_API = "https://api.notion.com/v1";
const HEALTH_ICON = "🩺";

function githubHeaders(env) {
  return {
    ...(env.GH_PAT ? { Authorization: `Bearer ${env.GH_PAT}` } : {}),
    Accept: "application/vnd.github+json",
    "User-Agent": "internship-watcher-pinger",
  };
}

function isHourlyReminder(scheduledTime) {
  const date = new Date(scheduledTime);
  return !Number.isNaN(date.valueOf()) && date.getUTCMinutes() < 10;
}

function scheduledTimestamp(scheduledTime) {
  const timestamp = new Date(scheduledTime).getTime();
  return Number.isNaN(timestamp) ? Date.now() : timestamp;
}

function timeoutSignal() {
  return globalThis.AbortSignal?.timeout?.(20_000);
}

function runAge(run, now) {
  const timestamp = run.completed_at || run.updated_at || run.created_at;
  const parsed = Date.parse(timestamp || "");
  return Number.isNaN(parsed) ? null : Math.max(0, now - parsed);
}

function failureStreak(runs) {
  let count = 0;
  for (const run of runs) {
    if (run.conclusion === "success") break;
    count += 1;
  }
  return count;
}

async function requestRuns(env, headers) {
  const repo = env.REPO || DEFAULT_REPO;
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs?status=completed&branch=main&per_page=${RUNS_PER_REQUEST}`;
  let response;
  try {
    response = await fetch(url, { headers, signal: timeoutSignal() });
  } catch (error) {
    return { error: `could not read workflow runs (${errorMessage(error)})` };
  }
  if (!response.ok) {
    return { error: `workflow run lookup failed (HTTP ${response.status})` };
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { error: `workflow run lookup returned invalid JSON (${errorMessage(error)})` };
  }
  if (!Array.isArray(payload.workflow_runs)) {
    return { error: "workflow run lookup returned no workflow_runs array" };
  }
  return { runs: payload.workflow_runs };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function dispatchWorkflow(env, headers) {
  const repo = env.REPO || DEFAULT_REPO;
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
      signal: timeoutSignal(),
    });
    if (!response.ok) {
      return `workflow dispatch failed (HTTP ${response.status})`;
    }
    return null;
  } catch (error) {
    return `workflow dispatch failed (${errorMessage(error)})`;
  }
}

function notionHeaders(env) {
  return {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };
}

// Finds the persistent health callout by its icon rather than storing a
// block id anywhere — the worker keeps no state between invocations.
async function findHealthBlock(env) {
  let cursor;
  for (let page = 0; page < 5; page += 1) {
    const url = `${NOTION_API}/blocks/${env.NOTION_PARENT_PAGE_ID}/children?page_size=100` +
      (cursor ? `&start_cursor=${cursor}` : "");
    let response;
    try {
      response = await fetch(url, { headers: notionHeaders(env), signal: timeoutSignal() });
    } catch (error) {
      return null;
    }
    if (!response.ok) return null;
    const payload = await response.json();
    const found = (payload.results || []).find(
      (b) => b.type === "callout" && b.callout?.icon?.emoji === HEALTH_ICON,
    );
    if (found) return found.id;
    if (!payload.has_more) return null;
    cursor = payload.next_cursor;
  }
  return null;
}

async function deliverAlert(env, content) {
  if (!env.NOTION_TOKEN || !env.NOTION_PARENT_PAGE_ID) {
    console.log("alert delivery skipped: NOTION_TOKEN/NOTION_PARENT_PAGE_ID is not configured");
    return false;
  }
  const rich = [{ type: "text", text: { content: content.slice(0, 1900) } }];
  try {
    const blockId = await findHealthBlock(env);
    const url = blockId
      ? `${NOTION_API}/blocks/${blockId}`
      : `${NOTION_API}/blocks/${env.NOTION_PARENT_PAGE_ID}/children`;
    const body = blockId
      ? { callout: { rich_text: rich } }
      : {
          children: [{
            object: "block", type: "callout",
            callout: { rich_text: rich, icon: { type: "emoji", emoji: HEALTH_ICON } },
          }],
        };
    const response = await fetch(url, {
      method: "PATCH",
      headers: notionHeaders(env),
      body: JSON.stringify(body),
      signal: timeoutSignal(),
    });
    if (!response.ok) {
      console.log("alert delivery failed:", response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.log("alert delivery failed:", errorMessage(error));
    return false;
  }
}

export async function runScheduled(event, env = {}) {
  const headers = githubHeaders(env);
  const reminder = isHourlyReminder(event?.scheduledTime ?? new Date().toISOString());
  const problems = [];

  const dispatchProblem = await dispatchWorkflow(env, headers);
  if (dispatchProblem) problems.push(`⚠️ **internship-pinger**: ${dispatchProblem}.`);

  const result = await requestRuns(env, headers);
  if (result.error) {
    problems.push(`⚠️ **internship-pinger**: ${result.error}.`);
  } else if (result.runs.length === 0) {
    problems.push("⚠️ **internship-watcher**: no completed watch.yml runs were found.");
  } else {
    const [latest] = result.runs;
    const streak = failureStreak(result.runs);
    if (streak > 0) {
      problems.push(`⚠️ **internship-watcher**: ${streak} consecutive completed run(s) ` +
        `are not successful — ${latest.conclusion} — ${latest.html_url || "(no URL)"}.`);
    } else {
      const age = runAge(latest, scheduledTimestamp(event?.scheduledTime ?? Date.now()));
      if (age !== null && age > STALE_AFTER_MS) {
        problems.push(`⚠️ **internship-watcher**: latest successful run is ` +
          `${Math.round(age / 60000)} minutes old — ${latest.html_url || "(no URL)"}.`);
      }
    }
  }

  if (reminder) {
    const text = `${HEALTH_ICON} Watcher health\n` +
      (problems.length ? problems.join("\n") : "✅ All systems normal.");
    await deliverAlert(env, text);
  }
  return { reminder, problems };
}

export { DEFAULT_REPO, WORKFLOW, STALE_AFTER_MS, HEALTH_ICON, isHourlyReminder, failureStreak };

export default {
  async scheduled(event, env, ctx) {
    const work = runScheduled(event, env);
    if (ctx?.waitUntil) ctx.waitUntil(work);
    else await work;
  },
};
