/**
 * Minimal `{{name}}` substitution for prose/static templates (`*.tmpl`, imported as text).
 * Templates with real logic are plain TS functions instead.
 * Missing variables throw, so a typo can't silently ship "undefined" into a user's repo.
 */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Error(`template variable "${name}" was not provided`);
    return vars[name]!;
  });
}
