/**
 * What went wrong, for code to act on (the CLI's exit code, the actions a front end offers) without
 * reading the message:
 * - `usage`: the command was called wrongly (a missing argument, an unknown status);
 * - `not_found`: an id or name that doesn't exist;
 * - `not_applied`: an accept that applied nothing (see `StetError.lost`);
 * - `linked`: a decision that would split a linked group, which needs to be told what to do;
 * - `failed`: anything else.
 */
export type ErrorCode = "usage" | "not_found" | "not_applied" | "linked" | "failed";

/** Errors meant for the user: frontends show their message as is (no stack trace). */
export class StetError extends Error {
  readonly code: ErrorCode;
  /** For `not_applied`: the changes that can't be located in their file any more (you edited the text around them). */
  readonly lost: readonly string[];

  constructor(message: string, opts: { code?: ErrorCode; lost?: readonly string[] } = {}) {
    super(message);
    this.code = opts.code ?? "failed";
    this.lost = opts.lost ?? [];
  }
}

/** An id or name that doesn't exist. */
export const notFound = (message: string) => new StetError(message, { code: "not_found" });

/** A command called wrongly. */
export const usageError = (message: string) => new StetError(message, { code: "usage" });
