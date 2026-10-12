const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: number) => (s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  cyan: wrap(36),
};

let verbose = false;
let silent = false;

export function configureLogger(opts: { verbose?: boolean; silent?: boolean }) {
  verbose = opts.verbose ?? verbose;
  silent = opts.silent ?? silent;
}

export const log = {
  info: (msg: string) => !silent && console.log(msg),
  success: (msg: string) => !silent && console.log(`${c.green("✔")} ${msg}`),
  warn: (msg: string) => !silent && console.warn(`${c.yellow("⚠")} ${msg}`),
  error: (msg: string) => console.error(`${c.red("✖")} ${msg}`),
  debug: (msg: string) =>
    verbose && !silent && console.error(c.dim(`· ${msg}`)),
};
