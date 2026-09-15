// Your own answers for deterministic form fields. Fill this in once before
// deploying. Nothing here is a secret in the credential sense, but if you'd
// rather not commit your phone number/address, move individual fields to
// Wrangler vars/secrets and read them from env instead — the shape below is
// just a plain object so that's a trivial swap later.
export const PROFILE = {
  firstName: "REPLACE_ME",
  lastName: "REPLACE_ME",
  email: "REPLACE_ME@example.com",
  phone: "REPLACE_ME",
  linkedin: "https://linkedin.com/in/REPLACE_ME",
  github: "https://github.com/REPLACE_ME",
  resumeUrl: "REPLACE_ME", // a hosted URL to your resume file
  school: "REPLACE_ME",
  graduationDate: "REPLACE_ME",
};

// label keyword -> profile field, checked in order, first match wins.
export const DETERMINISTIC_MATCHERS: Array<[RegExp, keyof typeof PROFILE]> = [
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
