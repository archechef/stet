/**
 * What the front ends (the `stet` command, the MCP server's callers, the VS Code extension) use of
 * the core. Everything else is internal: tests import it from its module.
 */
export { anchor } from "./anchor.js";
export * from "./config.js";
export { describeItem, firstLines, type ItemDescription, SHOWN_LINES } from "./describe.js";
export { type DoctorCheck, doctor } from "./doctor.js";
export { itemEffect } from "./effects.js";
export { type ErrorCode, notFound, StetError, usageError } from "./errors.js";
export { gitIdentity, Repo } from "./git.js";
export type { GroupHint, NoteHint } from "./grouping.js";
export { checkToolUse, type GuardContext, type HookInput } from "./guard.js";
export type { HookStatus } from "./hooks.js";
export { findInbox, followInbox, type InboxLine } from "./inbox.js";
export { type InlineDiff, inlineDiff } from "./inline.js";
export { archivedMessage } from "./instructions.js";
export {
  buildIgnores,
  DOCUMENT_LANGUAGES,
  documentProfile,
  hasPdfPreview,
  hasPreview,
  type LanguageProfile,
  matchesAny,
  profileByName,
  profileHasPreview,
  profileRenderer,
} from "./lang/index.js";
export { forgetLibraryProfile, type LibraryProfile, libraryDirectory, readLibrary } from "./lang/library.js";
export { MARK_CLOSE, MARK_OPEN } from "./lang/markdown-render.js";
export type { SetupAction, SpokenRules, SyntaxRules, Typesetter } from "./lang/profile.js";
export { describeFeedback, StetMcpServer, serveStdio } from "./mcp.js";
export * from "./model.js";
export { type MoveChange, moveChangesOf } from "./moves.js";
export { type DeliveredNote, describeNote } from "./notes.js";
export { foldPath, pathExists } from "./paths.js";
export type { Missing, PageSide, PageView, PreviewImage, PreviewResult } from "./preview/builder.js";
export type { PreviewConfig, PreviewEnv } from "./preview/env.js";
export type { Box } from "./preview/words.js";
export type { ReviewChange, ReviewDocument } from "./review.js";
export type { GroupExtras } from "./service/groups.js";
export type { AcceptResult, AgentStatus, ItemFilter, ProfileImport, SubmitResult, SyncResult, UndoResult } from "./service.js";
export { Stet } from "./service.js";
export type { Edit } from "./split.js";
export { CHANGED_FILE } from "./store.js";
export { changeSummary, isSafeRepoPath, lineDiff, lineOf, oneLine, paragraphChange, plural, printable, spokenChange, summaryTexts } from "./text.js";
export type { CliCommand, WorkspaceResult } from "./workspace.js";
export { verifyAgentWorktree } from "./worktree.js";
