import type { Env } from "./types";

// Your own answers for deterministic form fields. This repo is a public
// fork, so phone and email — the two fields with no public presence
// elsewhere — come from Wrangler secrets (PROFILE_PHONE / PROFILE_EMAIL)
// instead of being committed here. Everything else below is fine to commit
// (already public via LinkedIn/GitHub/your resume link itself).
export const PROFILE = {
  firstName: "Sanjith",
  lastName: "Kotaru",
  linkedin: "https://linkedin.com/in/sanjith-kotaru",
  github: "https://github.com/Sanjith-K",
  resumeUrl: "https://drive.google.com/file/d/1D5ueG58roOFJaNdw9GWcXZqFdfB-bFNc/view?usp=sharing", // a hosted URL to your resume file
  school: "New York University",
  graduationDate: "Spring 2028",
};

export function buildProfile(env: Pick<Env, "PROFILE_PHONE" | "PROFILE_EMAIL">) {
  return { ...PROFILE, phone: env.PROFILE_PHONE, email: env.PROFILE_EMAIL };
}

export type FullProfile = ReturnType<typeof buildProfile>;

// label keyword -> profile field, checked in order, first match wins.
export const DETERMINISTIC_MATCHERS: Array<[RegExp, keyof FullProfile]> = [
  [/first\s*name/i, "firstName"],
  [/last\s*name/i, "lastName"],
  [/e-?mail/i, "email"],
  [/phone/i, "phone"],
  [/linkedin/i, "linkedin"],
  [/github/i, "github"],
  [/resume|cv/i, "resumeUrl"],
  [/school|university/i, "school"],
  [/graduation/i, "graduationDate"],
];
