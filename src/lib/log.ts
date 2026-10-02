const ts = () => new Date().toISOString().slice(11, 19);

export const log = {
  step: (n: number | string, msg: string) => console.log(`\x1b[36m[${ts()}] ── Paso ${n}: ${msg}\x1b[0m`),
  info: (msg: string) => console.log(`[${ts()}]    ${msg}`),
  ok: (msg: string) => console.log(`\x1b[32m[${ts()}] ✔  ${msg}\x1b[0m`),
  warn: (msg: string) => console.log(`\x1b[33m[${ts()}] ⚠  ${msg}\x1b[0m`),
  err: (msg: string) => console.log(`\x1b[31m[${ts()}] ✖  ${msg}\x1b[0m`),
  tx: (label: string, url: string) => console.log(`[${ts()}]    ${label}: ${url}`),
};
