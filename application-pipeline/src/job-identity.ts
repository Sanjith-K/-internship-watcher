// Faithful TypeScript port of job_utils.py's canonical_url()/job_identity().
// Keep this in exact sync with that file — the whole point is that the
// Python watcher and this Workers pipeline agree on the same identity for
// the same job, since a Notion row's Link is the only thing they share.
// Not guaranteed byte-identical to Python's urlencode() for pathological
// inputs (e.g. unusual reserved characters), but real ATS URLs never
// exercise that edge.

const STRIPPED_QUERY_KEYS = new Set([
  "gh_src",
  "lever-source",
  "lever-origin",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
]);

export function canonicalUrl(rawUrl: string): string {
  if (!rawUrl) return "";
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    const lower = k.toLowerCase();
    if (lower.startsWith("utm_") || STRIPPED_QUERY_KEYS.has(lower)) continue;
    kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(kept).toString();
  return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}${
    query ? "?" + query : ""
  }${u.hash}`;
}

export function jobIdentity(url: string, fallbackId = ""): string {
  const canon = canonicalUrl(url);
  let host = "";
  let parts: string[] = [];
  let query = new URLSearchParams();
  try {
    const u = new URL(canon);
    host = u.hostname.toLowerCase();
    parts = u.pathname.split("/").filter(Boolean);
    query = u.searchParams;
  } catch {
    // canon is empty or unparseable — fall through to the url:/id: cases below
  }
  const ghJid = query.get("gh_jid");
  if (ghJid) return `greenhouse:${ghJid}`;
  if (host === "greenhouse.io" || host.endsWith(".greenhouse.io")) {
    const i = parts.indexOf("jobs");
    if (i !== -1 && i + 1 < parts.length) return `greenhouse:${parts[i + 1]}`;
  }
  const domains: Array<[string, string]> = [
    ["lever.co", "lever"],
    ["ashbyhq.com", "ashby"],
  ];
  for (const [domain, ats] of domains) {
    if ((host === domain || host.endsWith(`.${domain}`)) && parts.length >= 2) {
      return `${ats}:${parts[0].toLowerCase()}:${parts[1]}`;
    }
  }
  return canon ? `url:${canon}` : `id:${fallbackId}`;
}

// Cloudflare Workflow instance IDs must match /^[a-zA-Z0-9_-]{1,64}$/, but a
// job identity can contain ":" and, in the "url:" fallback case, an entire
// URL well past 64 characters. Hash it down to a stable, valid instance ID.
export async function workflowInstanceId(identity: string): Promise<string> {
  const bytes = new TextEncoder().encode(identity);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
