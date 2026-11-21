/** `stet`'s command line: parsed against the command table, run, and turned into an exit code. */
import { parseArgs } from "node:util";
import { type CliCommand, DOCUMENT_LANGUAGES, notFound, Stet, StetError, usageError } from "@stet/core";
import { COMMANDS, type Command, type Ctx, SECTIONS, VERSION } from "./commands.js";
import { GLOBAL_OPTIONS, OPTIONS, type OptionName, type Opts } from "./options.js";
import { forTerminal, red, useColor } from "./output.js";

/** Exit codes, for scripts: 1 any other error, 2 a wrong command line, 3 an unknown id or name. */
export const EXIT = { error: 1, usage: 2, unknown: 3 } as const;

/** Where a run reads and writes; the defaults are the process's own. */
export interface Io {
  cwd: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Stet's colours in the output. */
  color: boolean;
  /** How other tools run this CLI: the script that called `main`. */
  self: CliCommand;
}

/** `stet --help`, from the command table. */
export function help(): string {
  const sections = Object.entries(SECTIONS).map(([key, title]) =>
    [
      title,
      ...COMMANDS.filter((c) => c.section === key)
        .flatMap((c) => c.usage)
        .map((u) => `  ${u}`),
    ].join("\n"),
  );
  return [
    `stet — review AI-proposed changes to ${DOCUMENT_LANGUAGES.map((p) => p.name).join(" and ")} projects`,
    ...sections,
    "Global: --json for machine-readable output, --help.",
  ].join("\n\n");
}

/** The options `command` takes (and the global ones). A wrong option is a usage error, not a stack trace (test report B1). */
function parseFor(command: Command | undefined, argv: string[]): { opt: Opts; args: string[] } {
  const names = new Set<OptionName>([...GLOBAL_OPTIONS, ...(command?.options ?? [])]);
  const options = Object.fromEntries(Object.entries(OPTIONS).filter(([k]) => names.has(k as OptionName)));
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options });
    return { opt: values as Opts, args: positionals.slice(1) };
  } catch (e: any) {
    if (!String(e?.code).startsWith("ERR_PARSE_ARGS")) throw e;
    // An option of another command: say so, rather than that it doesn't exist.
    const other = /^Unknown option '--?([\w-]+)'/.exec(String(e.message))?.[1];
    const flag = other && Object.entries(OPTIONS).find(([k, o]) => k === other || ("short" in o && o.short === other));
    if (flag) throw usageError(`\`stet${command ? ` ${command.name}` : ""}\` has no option --${flag[0]}. Run \`stet --help\`.`);
    const msg = String(e.message)
      .split("\n")[0]!
      .replace(/\. To specify a positional argument.*$/, "");
    throw usageError(`${msg}. Run \`stet --help\`.`);
  }
}

/** Run `stet` with `argv` (the arguments after `stet`); returns the exit code. */
export async function main(argv: string[], io: Partial<Io> = {}): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  // Nothing they return may pass for an exit code (commands end with `return print(…)`).
  const print = (s: string): void => void (io.stdout ?? console.log)(s);
  const printError = (s: string): void => void (io.stderr ?? console.error)(s);
  useColor(io.color ?? (!!process.stdout.isTTY && !process.env.NO_COLOR));
  // A first look, to find the command: every option is known here, none refused.
  const first = parseArgs({ args: argv, allowPositionals: true, strict: false, options: OPTIONS });
  let json = first.values.json === true;
  try {
    const [name] = first.positionals;
    if (first.values.version === true || name === "version") {
      print(json ? JSON.stringify({ version: VERSION }, null, 2) : `stet ${VERSION}`);
      return 0;
    }
    if (!name || first.values.help === true || name === "help") {
      if (!name) parseFor(undefined, argv); // `stet --nope` is a mistake, not a request for help
      print(help());
      return 0;
    }
    const command = COMMANDS.find((c) => c.name === name);
    if (!command) throw notFound(`Unknown command '${name}'. Run \`stet --help\`.`);
    const { opt, args } = parseFor(command, argv);
    json = !!opt.json;
    let stet: Stet | undefined;
    if (command.project) {
      const located = await Stet.locate(cwd);
      const reviewer = typeof command.reviewer === "function" ? command.reviewer(args) : !!command.reviewer;
      if (reviewer && located.agentWorkspace) {
        throw new StetError(
          `\`stet ${name}\` is for the reviewer, and this is an agent's workspace (${located.toplevel}). Run it in your project folder, ${located.mainPath}.`,
        );
      }
      stet = await Stet.open(cwd, located);
    }
    const ctx: Ctx = {
      args,
      opt,
      cwd,
      get stet(): Stet {
        if (!stet) throw new Error(`stet ${name} doesn't open the project`);
        return stet;
      },
      out: (human, data) => {
        if (json) return print(JSON.stringify(data, null, 2));
        const s = human();
        if (s) print(forTerminal(s));
      },
      print,
      printError,
      self: io.self ?? { command: process.execPath, args: [process.argv[1] ?? "stet"] },
    };
    return (await command.run(ctx)) ?? 0;
  } catch (e: any) {
    if (e instanceof StetError) {
      if (json) print(JSON.stringify({ error: e.message }));
      else printError(forTerminal(red("error: ") + e.message));
      return e.code === "usage" ? EXIT.usage : e.code === "not_found" ? EXIT.unknown : EXIT.error;
    }
    // Not Stet's own error: the message, and the stack only when asked for.
    printError(forTerminal(red("error: ")) + (e?.message ?? String(e)) + (process.env.STET_DEBUG ? `\n${e?.stack ?? ""}` : "\n(set STET_DEBUG=1 for details)"));
    return EXIT.error;
  }
}
