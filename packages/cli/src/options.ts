/** The command line's options; each command takes some of them (`Command.options`). */
export const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  main: { type: "string" },
  kind: { type: "string" },
  path: { type: "string" },
  remove: { type: "boolean" },
  agent: { type: "string" },
  status: { type: "string" },
  all: { type: "boolean" },
  force: { type: "boolean" },
  text: { type: "string" },
  "text-file": { type: "string" },
  "no-commit": { type: "boolean" },
  commit: { type: "boolean" },
  message: { type: "string", short: "m" },
  title: { type: "string", short: "t" },
  "revise-rest": { type: "boolean" },
  only: { type: "boolean" },
  groups: { type: "string" },
  parts: { type: "string" },
  reason: { type: "string" },
  notes: { type: "string" },
  peek: { type: "boolean" },
  once: { type: "boolean" },
  on: { type: "string" },
  extras: { type: "boolean" },
  page: { type: "string" },
  before: { type: "boolean" },
  print: { type: "boolean" },
  full: { type: "boolean" },
  confirm: { type: "boolean" },
  language: { type: "string" },
} as const;

export type OptionName = keyof typeof OPTIONS;
/** Parsed options: strings and booleans, as `parseArgs` gives them. */
export type Opts = { -readonly [K in OptionName]?: (typeof OPTIONS)[K]["type"] extends "string" ? string : boolean };

/** Always accepted. */
export const GLOBAL_OPTIONS: OptionName[] = ["json", "help", "version"];
