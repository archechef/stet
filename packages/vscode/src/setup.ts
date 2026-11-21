/** *Set up project*: a folder made a Stet project, with git and an identity for commits if it has none. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildIgnores, DOCUMENT_LANGUAGES, documentProfile, gitIdentity, matchesAny, plural, Repo, Stet } from "@stet/core";
import * as vscode from "vscode";
import type { StetExtension } from "./extension.js";
import type { Project } from "./project.js";

export class SetupWizard {
  constructor(private readonly ext: StetExtension) {}

  async pickProject(): Promise<Project | undefined> {
    const ps = this.ext.allProjects();
    if (ps.length <= 1) return ps[0];
    const pick = await vscode.window.showQuickPick(
      ps.map((p) => ({ label: p.name, description: p.mainPath, p })),
      { title: "Which project?" },
    );
    return pick?.p;
  }

  async setup(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length)
      return void vscode.window.showInformationMessage(`Open the folder of your ${DOCUMENT_LANGUAGES.map((p) => p.name).join(" or ")} project first.`);
    const folder =
      folders.length === 1
        ? folders[0]!
        : (
            await vscode.window.showQuickPick(
              folders.map((f) => ({ label: f.name, description: f.uri.fsPath, f })),
              { title: "Set up Stet for which folder?" },
            )
          )?.f;
    if (!folder) return;
    const dir = folder.uri.fsPath;
    // An agent's workspace is set up already, as part of its project: setting it up again made it
    // a project of its own.
    const loc = await Stet.locate(dir).catch(() => null);
    if (loc?.agentWorkspace) {
      const open = await vscode.window.showInformationMessage(
        `${folder.name} is a workspace of the project ${loc.mainPath}, not a project of its own. Review and create agents in the project's window.`,
        "Open the project",
      );
      if (open) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(loc.mainPath), { forceNewWindow: true });
      return;
    }
    try {
      const repo = new Repo(dir);
      // Git must know who commits before anything is created: else the first commit failed with
      // git's own message, and left a repository with no commit and staged files.
      let identity: { name: string; email: string } | null = null;
      if (!(await gitIdentity(dir))) {
        identity = await this.askIdentity();
        if (!identity) return;
      }
      const files = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*"), "**/{.git,node_modules}/**", 5000)).map((u) =>
        vscode.workspace.asRelativePath(u, false),
      );
      // A folder without any document file is likely the wrong one.
      const names = DOCUMENT_LANGUAGES.map((p) => p.name).join(" or ");
      if (!files.some((f) => DOCUMENT_LANGUAGES.some((p) => matchesAny(f, p.defaultFiles ?? [])))) {
        const go = await vscode.window.showWarningMessage(
          `${folder.name} has no ${names} files.`,
          { modal: true, detail: `Stet reviews changes to a ${names} project. Set it up for this folder anyway?` },
          "Set up anyway",
        );
        if (go !== "Set up anyway") return;
      }
      const isRepo = (await repo.tryRun(["rev-parse", "--is-inside-work-tree"])) === "true";
      if (!isRepo || !(await repo.revParse("HEAD"))) {
        // One question for a new repository and its first commit (it was two in a row), with the
        // build files left out if you like: they went into that commit.
        const ignores = files.includes(".gitignore") ? [] : buildIgnores(files);
        const commit = "Commit files";
        const ignoring = "Commit, ignoring build files";
        const ok = await vscode.window.showWarningMessage(
          isRepo ? "The repository has no commits yet." : `${folder.name} is not a git repository yet.`,
          {
            modal: true,
            detail:
              (isRepo
                ? "Stet reviews changes against your last commit. Commit the current files now?"
                : "Stet uses git to keep the agents' proposals apart from your files. Create a repository here and commit the current files as a starting point?") +
              (ignores.length
                ? `\n\n“${ignoring}” first writes a .gitignore for the build files (${ignores.slice(0, 4).join(", ")}${ignores.length > 4 ? ", …" : ""}), so it isn't committed.`
                : ""),
          },
          ...(ignores.length ? [ignoring, commit] : [commit]),
        );
        if (!ok) return;
        if (!isRepo) await repo.run(["init"]);
        if (identity) await this.setIdentity(repo, identity);
        if (ok === ignoring) await writeFile(join(dir, ".gitignore"), `# Build files (written by Stet's setup)\n${ignores.join("\n")}\n`, { flag: "wx" });
        await repo.run(["add", "-A"]);
        try {
          await repo.run(["commit", "-m", "Initial commit"]);
        } catch (e) {
          await repo.tryRun(["reset", "-q"]); // nothing left staged
          throw e;
        }
      } else if (identity) await this.setIdentity(repo, identity);
      const loc = await Stet.locate(dir);
      const current = await Stet.open(dir, loc)
        .then((st) => st.config())
        .then((c) => c.cli)
        .catch(() => undefined); // first setup
      const bundled = await this.ext.bundledCli(current, join(loc.commonDir, "stet"));
      const opts: Parameters<typeof Stet.init>[1] = bundled ? { cli: bundled.cli } : {};
      const { setUp: already, languages: counts } = await Stet.inspectSetup(dir, loc);
      // Files of both languages: asked, not guessed (a Typst thesis with one old .tex file was
      // set up as LaTeX without a word).
      if (!already) {
        if (counts.length > 1) {
          const name = (id: string) => DOCUMENT_LANGUAGES.find((l) => l.id === id)?.name ?? id;
          const pick = await vscode.window.showQuickPick(
            counts.map(([id, n], k) => ({ label: name(id), description: `${plural(n, "file")}${k === 0 ? " (most)" : ""}`, id })),
            {
              title: `${folder.name} has ${counts.map(([id, n]) => `${n} ${name(id)}`).join(" and ")} files: which language is the project written in?`,
              placeHolder: "Agents' instructions and examples follow it",
            },
          );
          if (!pick) return;
          opts.language = pick.id;
        }
      }
      const stet = await Stet.init(dir, opts);
      await this.ext.discover();
      // Agents start from the last commit: edits not committed yet are not theirs to see (as `stet init` says).
      const dirty = await stet.uncommittedEdits();
      const edits = dirty ? " You have uncommitted edits: agents start from your last commit, so commit them first, or use Share my edits." : "";
      const hasAgents = (await stet.listAgents()).some((a) => a.state === "active");
      // A second run refreshes the setup; it says so, instead of the first-time message.
      // Which language was detected: agents' instructions follow it.
      const lang = ` It is a ${documentProfile(await stet.config()).name} project for Stet (setting "language" in .git/stet/config.json).`;
      if (already) return void vscode.window.showInformationMessage(`Stet was already set up for ${folder.name}; its setup is refreshed.${lang}${edits}`);
      const next = await vscode.window.showInformationMessage(
        `Stet is set up for ${folder.name}.${lang}${edits} Next, create a workspace for an AI agent.`,
        ...(hasAgents ? [] : ["New agent workspace"]),
      );
      if (next) await this.ext.agents.newAgent();
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Stet setup failed: ${e?.message ?? e}`);
    }
  }

  private async setIdentity(repo: Repo, id: { name: string; email: string }): Promise<void> {
    await repo.run(["config", "user.name", id.name]);
    await repo.run(["config", "user.email", id.email]);
  }

  /** Name and email for git's commits in this repository, asked when git has none; null if cancelled. */
  private async askIdentity(): Promise<{ name: string; email: string } | null> {
    const why = "Git records who made each commit, and has no name for you yet. It is saved for this project only.";
    const name = await vscode.window.showInputBox({
      title: "Your name for commits (1/2)",
      prompt: why,
      placeHolder: "e.g. Ada Lovelace",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Enter a name."),
    });
    if (!name) return null;
    const email = await vscode.window.showInputBox({
      title: "Your email for commits (2/2)",
      prompt: why,
      placeHolder: "e.g. ada@example.org",
      ignoreFocusOut: true,
      validateInput: (v) => (/^\S+@\S+$/.test(v.trim()) ? undefined : "Enter an email address."),
    });
    if (!email) return null;
    return { name: name.trim(), email: email.trim() };
  }
}
