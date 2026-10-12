import pkg from "../../package.json" with { type: "json" };

/** Published npm name. Unscoped `claude-kit` is refused by npm (too close to `claudekit`). */
export const PACKAGE_NAME = pkg.name;
export const VERSION = pkg.version;
/** How users run it without installing. */
export const NPX = `npx ${PACKAGE_NAME}`;
