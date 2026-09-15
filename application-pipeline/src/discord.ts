// Discord HTTP Interactions: signature verification, message/component
// building, and interaction parsing. No Gateway connection anywhere — this
// is deliberately the "Interactions webhook" model, which is the one that
// actually fits a Worker's request/response lifecycle.

const DISCORD_API = "https://discord.com/api/v10";

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  UPDATE_MESSAGE: 7,
} as const;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/** Verifies X-Signature-Ed25519 / X-Signature-Timestamp on every incoming
 * interaction, including the initial PING — required by Discord, and
 * required by us before the body is trusted at all. Uses the Workers
 * runtime's native Ed25519 WebCrypto support (no external nacl dependency
 * needed). Returns false on any malformed input rather than throwing, so
 * callers can respond 401 uniformly. */
export async function verifyDiscordRequest(
  request: Request,
  publicKeyHex: string,
): Promise<{ valid: boolean; body: string }> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  const body = await request.text();
  if (!signature || !timestamp) return { valid: false, body };
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
    return { valid, body };
  } catch {
    return { valid: false, body };
  }
}

export interface DraftMessageJob {
  company: string;
  title: string;
  url: string;
  draftSummary: string; // short human-readable preview of the drafted answers
}

/** custom_id format: "<action>:<token>" where token is the PENDING_APPROVALS
 * KV key. Discord caps custom_id at 100 chars, so the token — not the full
 * job identity or Workflow instance id — is what gets embedded here. */
export function buildDraftMessage(job: DraftMessageJob, token: string) {
  return {
    embeds: [
      {
        title: `${job.company} — ${job.title}`,
        url: job.url,
        description: job.draftSummary.slice(0, 4000),
        color: 0x5865f2,
      },
    ],
    components: [
      {
        type: 1, // action row
        components: [
          { type: 2, style: 3, label: "Approve", custom_id: `approve:${token}` }, // success
          { type: 2, style: 4, label: "Reject", custom_id: `reject:${token}` }, // danger
          { type: 2, style: 2, label: "Edit", custom_id: `edit:${token}` }, // secondary
        ],
      },
    ],
  };
}

export async function postToChannel(
  botToken: string,
  channelId: string,
  payload: unknown,
): Promise<{ id: string }> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Discord post failed: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/** Parses "approve:<token>" / "reject:<token>" / "edit:<token>" out of a
 * message-component interaction's custom_id. */
export function parseCustomId(customId: string): { action: string; token: string } | null {
  const i = customId.indexOf(":");
  if (i === -1) return null;
  return { action: customId.slice(0, i), token: customId.slice(i + 1) };
}
