export { anchor } from "./anchor.js";
export * from "./config.js";
export { type DoctorCheck, doctor } from "./doctor.js";
export { effectOf, itemEffect } from "./effects.js";
export { type ErrorCode, notFound, StetError, usageError } from "./errors.js";
export { gitIdentity, Repo } from "./git.js";
export type { GroupHint, NoteHint } from "./grouping.js";
export { checkToolUse, type GuardContext, type HookInput } from "./guard.js";
export { HOOK_NAMES, type HookStatus, hookStatus, installHooks, uninstallHooks } from "./hooks.js";
export { findInbox, followInbox, INBOX_FILE, INBOX_TIMING, type InboxLine, InboxWriter, parseInboxLine } from "./inbox.js";
export { type InlineDiff, inlineDiff } from "./inline.js";
export { agentInstructions, archivedMessage, MCP_INSTRUCTIONS, mcpInstructions } from "./instructions.js";
export {
  BIBTEX,
  buildIgnores,
  DOCUMENT_LANGUAGES,
  detectLanguage,
  documentProfile,
  hasPreview,
  LATEX,
  type LanguageProfile,
  languageCounts,
  matchesAny,
  PLAIN,
  PROFILES,
  profileByName,
  profileFor,
  TYPST,
} from "./lang/index.js";
export {
  detectEngine,
  detectRoot,
  errorsOf,
  excerpt,
  LATEX_TYPESETTER,
  missingFiles,
  PREVIEW_CONTAINERFILE,
  PREVIEW_TEX_CONTAINERFILE,
  parseSynctex,
  plainWords,
  previewExtrasContainerfile,
} from "./lang/latex-preview.js";
export type { SyntaxRules, Typesetter } from "./lang/profile.js";
export { describeFeedback, StetMcpServer, serveStdio, TOOLS, toolsFor } from "./mcp.js";
export * from "./model.js";
export { type MoveChange, moveChanges, moveChangesOf, moveTexts } from "./moves.js";
export { type DeliveredNote, describeNote } from "./notes.js";
export { foldPath, isInside, pathExists, samePath } from "./paths.js";
export {
  type Box,
  containerArgs,
  cropRegion,
  DEFAULT_PREVIEW,
  type Missing,
  markRuns,
  type PageSide,
  type PageView,
  type PreviewConfig,
  type PreviewEnv,
  type PreviewImage,
  type PreviewResult,
  wordDiff,
} from "./preview.js";
export { mapReviewEdits, type ReviewChange, type ReviewDocument, reviewDocument } from "./review.js";
export type { AcceptResult, AgentStatus, ItemFilter, SubmitResult, SyncResult, UndoResult } from "./service.js";
export { BASE_REF, Stet } from "./service.js";
export { type Edit, splitText } from "./split.js";
export { CHANGED_FILE } from "./store.js";
export { changeSummary, isSafeRepoPath, lineDiff, lineOf, oneLine, paragraphChange, printable, spokenChange, summaryTexts } from "./text.js";
export { tokenizeWords } from "./tokenizer.js";
export { type CliCommand, cliShellCommand, isWorkspaceFile, WORKSPACE_FILES, type WorkspaceResult, writeWorkspaceFiles } from "./workspace.js";
export { verifyAgentWorktree, WorktreeIntegrityError } from "./worktree.js";
