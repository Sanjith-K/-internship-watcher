// Best-effort, read-only extraction of an apply form's field list from the
// public job page's HTML. This is genuinely fragile: Greenhouse's and
// Lever's modern apply forms are largely client-rendered React/JS, so a
// plain HTML fetch (no headless browser — Workers can't easily do that
// without Cloudflare's separate Browser Rendering product, which this
// design doesn't assume) will often see an empty shell rather than real
// <input> elements. When that happens we fall back to a small generic
// schema rather than fail the step. Treat this as a starting point to
// refine per-ATS, not a finished scraper — flagging that honestly rather
// than pretending it's robust.

export interface FormField {
  key: string; // best-guess field identifier (id/name attribute, or a slug of the label)
  label: string;
  type: "text" | "textarea" | "email" | "tel" | "url" | "file" | "select";
  required: boolean;
}

export interface FormSchema {
  fields: FormField[];
  source: "parsed" | "fallback";
}

const FALLBACK_SCHEMA: FormField[] = [
  { key: "first_name", label: "First Name", type: "text", required: true },
  { key: "last_name", label: "Last Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email", required: true },
  { key: "phone", label: "Phone", type: "tel", required: false },
  { key: "resume", label: "Resume/CV", type: "file", required: true },
  { key: "linkedin", label: "LinkedIn Profile", type: "url", required: false },
  { key: "why_interested", label: "Why are you interested in this role?", type: "textarea", required: false },
];

const LABEL_INPUT_PAIR = /<label[^>]*for="([^"]+)"[^>]*>([^<]*)<\/label>/gi;
const INPUT_TAG = /<(input|textarea|select)\b[^>]*>/gi;

function attr(tag: string, name: string): string | null {
  const m =
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag) ||
    new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i").exec(tag);
  return m ? m[1] : null;
}

function inputType(tag: string): FormField["type"] {
  const tagName = /^<(\w+)/.exec(tag)?.[1]?.toLowerCase();
  if (tagName === "textarea") return "textarea";
  if (tagName === "select") return "select";
  const t = (attr(tag, "type") || "text").toLowerCase();
  if (t === "email" || t === "tel" || t === "url" || t === "file") return t;
  return "text";
}

export async function fetchFormSchema(url: string): Promise<FormSchema> {
  let html = "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": "internship-watcher-pipeline/1.0" } });
    if (res.ok) html = await res.text();
  } catch {
    // network failure — fall through to the fallback schema below
  }

  const labelsById = new Map<string, string>();
  for (const m of html.matchAll(LABEL_INPUT_PAIR)) {
    labelsById.set(m[1], m[2].trim());
  }

  const fields: FormField[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(INPUT_TAG)) {
    const tag = m[0];
    const id = attr(tag, "id") || attr(tag, "name");
    if (!id || seen.has(id)) continue;
    const type = attr(tag, "type");
    if (type === "hidden" || type === "submit" || type === "button") continue;
    seen.add(id);
    fields.push({
      key: id,
      label: labelsById.get(id) || attr(tag, "placeholder") || attr(tag, "aria-label") || id,
      type: inputType(tag),
      required: tag.includes("required"),
    });
  }

  if (fields.length === 0) {
    return { fields: FALLBACK_SCHEMA, source: "fallback" };
  }
  return { fields, source: "parsed" };
}
