/** Applies to every repo regardless of stack. */

export const COMMON_IGNORE = [
  ".git/",
  ".DS_Store",
  "*.log",
  "tmp/",
  ".idea/",
  // secrets: reading these leaks them into the transcript
  ".env",
  ".env.*",
  "!.env.example",
  "*.pem",
  "*.key",
  "id_rsa*",
];

export const COMMON_PROTECTED = [
  { pattern: ".env", reason: "secrets file; edit it yourself, never through Claude" },
  { pattern: ".env.*", reason: "secrets file; edit it yourself, never through Claude" },
  { pattern: ".git/", reason: "git internals; use git commands instead" },
];

/** Never protected even if a pattern above matches. */
export const COMMON_PROTECTED_EXCEPTIONS = [".env.example", ".env.sample", ".env.template"];
