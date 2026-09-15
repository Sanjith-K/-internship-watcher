import type { FormField, FormSchema } from "./ats-forms";
import { buildProfile, DETERMINISTIC_MATCHERS, type FullProfile } from "./profile";
import type { Env } from "./types";

export interface DraftedAnswer {
  field: FormField;
  value: string;
  source: "profile" | "ai" | "unfilled";
}

export interface DraftResult {
  answers: DraftedAnswer[];
  summary: string; // short human-readable text for the Discord embed
}

// Kept as a plain string rather than a Workers AI enum type, since the
// text-generation catalog changes over time — verify this model id is
// still current in the Workers AI dashboard before deploying, and swap it
// if not.
const DRAFT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

function matchProfileField(profile: FullProfile, label: string): string | null {
  for (const [pattern, key] of DETERMINISTIC_MATCHERS) {
    if (pattern.test(label)) return profile[key];
  }
  return null;
}

async function draftFreeText(env: Env, company: string, title: string, label: string): Promise<string> {
  const prompt =
    `You are drafting a short, honest, first-person answer for a job application question. ` +
    `Company: ${company}. Role: ${title}. Question: "${label}". ` +
    `Write 2-4 sentences, specific and non-generic, no placeholders, no markdown. ` +
    `This is a DRAFT for a human to review and edit before submitting, not a final answer.`;
  try {
    const result = (await env.AI.run(DRAFT_MODEL, {
      messages: [{ role: "user", content: prompt }],
    })) as { response?: string };
    return (result.response || "").trim();
  } catch (err) {
    return `[AI drafting failed: ${(err as Error).message} — needs a manual answer]`;
  }
}

export async function draftApplication(
  env: Env,
  company: string,
  title: string,
  schema: FormSchema,
): Promise<DraftResult> {
  const profile = buildProfile(env);
  const answers: DraftedAnswer[] = [];
  for (const field of schema.fields) {
    if (field.type === "file") {
      answers.push({ field, value: profile.resumeUrl, source: "profile" });
      continue;
    }
    const profileValue = matchProfileField(profile, field.label);
    if (profileValue) {
      answers.push({ field, value: profileValue, source: "profile" });
      continue;
    }
    if (field.type === "textarea") {
      const drafted = await draftFreeText(env, company, title, field.label);
      answers.push({ field, value: drafted, source: "ai" });
      continue;
    }
    answers.push({ field, value: "", source: "unfilled" });
  }

  const lines = answers.map((a) => {
    const tag = a.source === "unfilled" ? " ⚠️ unfilled" : "";
    const preview = a.value.length > 160 ? a.value.slice(0, 157) + "..." : a.value;
    return `**${a.field.label}**${tag}: ${preview || "_(empty)_"}`;
  });
  if (schema.source === "fallback") {
    lines.unshift("_(Could not read the real form — using a generic field guess. Review carefully.)_");
  }
  return { answers, summary: lines.join("\n") };
}
