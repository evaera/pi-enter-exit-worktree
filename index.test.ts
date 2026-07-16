import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension, { loadConfig, loadState, sanitizeWorktreeName } from "./index.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalWorktreeRoot = process.env.PI_ENTER_EXIT_WORKTREE_ROOT;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initializeRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.com");
  writeFileSync(join(root, "tracked.txt"), "base\n");
  writeFileSync(join(root, ".gitignore"), "*.ignored\n");
  git(root, "add", "tracked.txt", ".gitignore");
  const tree = git(root, "write-tree").trim();
  const commit = execFileSync("git", ["commit-tree", tree, "-m", "initial"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  git(root, "update-ref", "refs/heads/main", commit);
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "reset", "--hard", "HEAD");
}

function makePiHarness() {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const tools = new Map<string, any>();
  const sent: string[] = [];
  const pi = {
    registerCommand(name: string, options: any) {
      commands.set(name, options.handler);
    },
    registerTool(options: any) {
      tools.set(options.name, options);
    },
    getSessionName() {
      return "test-task";
    },
    sendUserMessage(message: string) {
      sent.push(message);
    },
  } as any;
  extension(pi);
  return { commands, tools, sent };
}

function makeContext(manager: SessionManager) {
  const notices: string[] = [];
  const context = {
    mode: "tui",
    hasUI: true,
    sessionManager: manager,
    waitForIdle: async () => {},
    switchedSessionFile: undefined as string | undefined,
    switchSession: async (path: string, options: any) => {
      context.switchedSessionFile = path;
      const replacement = SessionManager.open(path);
      await options.withSession({
        hasUI: true,
        ui: {
          setStatus() {},
          notify(message: string) {
            notices.push(message);
          },
        },
        sessionManager: replacement,
      });
      return { cancelled: false };
    },
    ui: {
      input: async () => "test-task",
      select: async (_title: string, options: string[]) => options[0],
      setStatus() {},
      notify(message: string) {
        notices.push(message);
      },
    },
    notices,
  } as any;
  return context;
}

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalWorktreeRoot === undefined) delete process.env.PI_ENTER_EXIT_WORKTREE_ROOT;
  else process.env.PI_ENTER_EXIT_WORKTREE_ROOT = originalWorktreeRoot;
});

describe("enter and exit worktree", () => {
  it("sanitizes worktree names", () => {
    expect(sanitizeWorktreeName(" Feature/Auth Flow ")).toBe("feature-auth-flow");
    expect(() => sanitizeWorktreeName("---")).toThrow();
  });

  it("loads the worktree root from JSON config", () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-enter-exit-config-"));
    writeFileSync(join(temp, "pi-enter-exit-worktree.json"), '{"worktreeRoot":"~/custom-worktrees"}\n');
    expect(loadConfig(temp)).toEqual({ worktreeRoot: "~/custom-worktrees" });
  });

  it("registers natural-language tools that queue commands", async () => {
    const harness = makePiHarness();
    await harness.tools.get("enter_worktree").execute("1", { name: "Feature Auth" });
    await harness.tools.get("new_worktree").execute("2", { name: "Fresh Task" });
    await harness.tools.get("exit_worktree").execute("3", {});
    expect(harness.sent).toEqual([
      "/enter-worktree feature-auth",
      "/new-worktree fresh-task",
      "/exit-worktree",
    ]);
  });

  it("moves staged, unstaged, and untracked changes into and out of a worktree", async () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-enter-exit-worktree-"));
    const agent = join(temp, "agent");
    const repo = join(temp, "sample-repo");
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.PI_ENTER_EXIT_WORKTREE_ROOT = join(temp, "worktrees");
    initializeRepo(repo);
    writeFileSync(join(repo, "tracked.txt"), "existing stash\n");
    git(repo, "stash", "push", "-m", "keep this stash");
    const existingStash = git(repo, "rev-parse", "refs/stash").trim();

    writeFileSync(join(repo, "tracked.txt"), "staged\n");
    git(repo, "add", "tracked.txt");
    writeFileSync(join(repo, "tracked.txt"), "staged\nunstaged\n");
    writeFileSync(join(repo, "untracked.txt"), "new\n");
    const originalStatus = git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all");

    const sourceSession = SessionManager.create(repo, join(temp, "source-sessions"));
    sourceSession.appendMessage({ role: "user", content: "keep this context", timestamp: Date.now() });
    sourceSession.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "context kept" }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    expect(sourceSession.getCwd()).toBe(repo);
    const harness = makePiHarness();
    await harness.commands.get("enter-worktree")!("feature", makeContext(sourceSession));

    expect(git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")).toBe("");
    const state = loadState(agent);
    const record = Object.values(state.records)[0]!;
    expect(record.sourceRoot).toBe(realpathSync(repo));
    expect(git(record.destinationRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all")).toBe(
      originalStatus,
    );
    expect(readFileSync(join(record.destinationRoot, "tracked.txt"), "utf8")).toBe("staged\nunstaged\n");

    const targetSessions = await SessionManager.list(record.destinationRoot);
    expect(targetSessions.length).toBeGreaterThan(0);
    writeFileSync(join(record.destinationRoot, "build.ignored"), "preserve me\n");
    const destinationSession = SessionManager.open(targetSessions[0]!.path);
    const exitContext = makeContext(destinationSession);
    await harness.commands.get("exit-worktree")!("", exitContext);

    expect(git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")).toBe(originalStatus);
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("staged\nunstaged\n");
    expect(Object.keys(loadState(agent).records)).toHaveLength(0);
    expect(git(repo, "rev-parse", "refs/stash").trim()).toBe(existingStash);
    expect(existsSync(record.destinationRoot)).toBe(false);
    const archived = git(repo, "worktree", "list", "--porcelain")
      .split("\n")
      .find((line) => line.startsWith("worktree ") && line.includes("/.exited/"))
      ?.slice("worktree ".length);
    expect(archived).toBeTruthy();
    expect(readFileSync(join(archived!, "build.ignored"), "utf8")).toBe("preserve me\n");

    const resumedSourceSession = SessionManager.open(exitContext.switchedSessionFile!);
    await harness.commands.get("enter-worktree")!("feature", makeContext(resumedSourceSession));
    const reentered = Object.values(loadState(agent).records)[0]!;
    expect(reentered.destinationRoot).toBe(record.destinationRoot);
    expect(readFileSync(join(reentered.destinationRoot, "build.ignored"), "utf8")).toBe("preserve me\n");
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("/.exited/");
  });

  it("creates from origin HEAD without touching a dirty source and flops back on exit", async () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-new-worktree-"));
    const agent = join(temp, "agent");
    const repo = join(temp, "sample-repo");
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.PI_ENTER_EXIT_WORKTREE_ROOT = join(temp, "worktrees");
    initializeRepo(repo);
    const localMain = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "default-only.txt"), "from origin default\n");
    git(repo, "add", "default-only.txt");
    const remoteTree = git(repo, "write-tree").trim();
    const remoteMain = execFileSync("git", ["commit-tree", remoteTree, "-p", localMain, "-m", "remote default"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    git(repo, "reset", "--hard", localMain);
    git(repo, "update-ref", "refs/remotes/origin/main", remoteMain);
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    writeFileSync(join(repo, "tracked.txt"), "source staged\n");
    git(repo, "add", "tracked.txt");
    writeFileSync(join(repo, "tracked.txt"), "source staged\nsource unstaged\n");
    writeFileSync(join(repo, "source-untracked.txt"), "source untracked\n");
    writeFileSync(join(repo, "source.ignored"), "source ignored\n");
    const sourceStatus = git(repo, "status", "--porcelain=v1", "--untracked-files=all");

    const sourceSession = SessionManager.create(repo, join(temp, "source-sessions"));
    sourceSession.appendMessage({ role: "user", content: "start clean", timestamp: Date.now() });
    sourceSession.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ready" }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const harness = makePiHarness();
    const enterContext = makeContext(sourceSession);
    await harness.commands.get("new-worktree")!("fresh-task", enterContext);
    const record = Object.values(loadState(agent).records)[0]!;
    expect(record.branch).toBe("fresh-task");
    expect(record.mode).toBe("new");
    expect(git(record.destinationRoot, "branch", "--show-current").trim()).toBe("fresh-task");
    expect(readFileSync(join(record.destinationRoot, "default-only.txt"), "utf8")).toBe("from origin default\n");
    expect(readFileSync(join(record.destinationRoot, "tracked.txt"), "utf8")).toBe("base\n");
    expect(existsSync(join(record.destinationRoot, "source-untracked.txt"))).toBe(false);
    expect(existsSync(join(record.destinationRoot, "source.ignored"))).toBe(false);
    expect(git(record.destinationRoot, "status", "--porcelain")).toBe("");
    expect(git(repo, "branch", "--show-current").trim()).toBe("main");
    expect(git(repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(sourceStatus);
    expect(git(repo, "show", ":tracked.txt")).toBe("source staged\n");
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("source staged\nsource unstaged\n");
    expect(readFileSync(join(repo, "source-untracked.txt"), "utf8")).toBe("source untracked\n");
    expect(readFileSync(join(repo, "source.ignored"), "utf8")).toBe("source ignored\n");

    git(repo, "reset", "--hard", "HEAD");
    rmSync(join(repo, "source-untracked.txt"));
    rmSync(join(repo, "source.ignored"));
    git(repo, "switch", "-c", "unrelated-source-branch");

    writeFileSync(join(record.destinationRoot, "tracked.txt"), "fresh change\n");
    const destinationSession = SessionManager.open(enterContext.switchedSessionFile!);
    await harness.commands.get("exit-worktree")!("", makeContext(destinationSession));

    expect(git(repo, "branch", "--show-current").trim()).toBe("fresh-task");
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("fresh change\n");
    expect(git(repo, "status", "--porcelain").trim()).toBe("M tracked.txt");
  });

  it("archives a created worktree when session relocation fails", async () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-new-worktree-failed-session-"));
    const agent = join(temp, "agent");
    const repo = join(temp, "sample-repo");
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.PI_ENTER_EXIT_WORKTREE_ROOT = join(temp, "worktrees");
    initializeRepo(repo);
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    writeFileSync(join(repo, "tracked.txt"), "failed staged\n");
    git(repo, "add", "tracked.txt");
    writeFileSync(join(repo, "tracked.txt"), "failed staged\nfailed unstaged\n");
    writeFileSync(join(repo, "failed-untracked.txt"), "preserve me\n");
    writeFileSync(join(repo, "failed.ignored"), "preserve ignored\n");
    const sourceStatus = git(repo, "status", "--porcelain=v1", "--untracked-files=all");

    const session = SessionManager.create(repo, join(temp, "sessions"));
    session.appendMessage({ role: "user", content: "new task", timestamp: Date.now() });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ready" }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    rmSync(session.getSessionFile()!);

    const harness = makePiHarness();
    await expect(harness.commands.get("new-worktree")!("failed-task", makeContext(session))).rejects.toThrow(
      "Cannot fork",
    );
    expect(Object.keys(loadState(agent).records)).toHaveLength(0);
    expect(existsSync(join(temp, "worktrees", "sample-repo", "failed-task"))).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain("/.exited/failed-task-");
    expect(git(repo, "branch", "--list", "failed-task").trim()).toBe("");
    expect(git(repo, "branch", "--show-current").trim()).toBe("main");
    expect(git(repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(sourceStatus);
    expect(git(repo, "show", ":tracked.txt")).toBe("failed staged\n");
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("failed staged\nfailed unstaged\n");
    expect(readFileSync(join(repo, "failed-untracked.txt"), "utf8")).toBe("preserve me\n");
    expect(readFileSync(join(repo, "failed.ignored"), "utf8")).toBe("preserve ignored\n");
  });

  it("refuses to overwrite ignored source files when flopping branches", async () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-exit-ignore-collision-"));
    const agent = join(temp, "agent");
    const repo = join(temp, "sample-repo");
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.PI_ENTER_EXIT_WORKTREE_ROOT = join(temp, "worktrees");
    initializeRepo(repo);
    const localMain = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "cache.ignored"), "tracked on default\n");
    git(repo, "add", "-f", "cache.ignored");
    const remoteTree = git(repo, "write-tree").trim();
    const remoteMain = execFileSync("git", ["commit-tree", remoteTree, "-p", localMain, "-m", "track cache"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    git(repo, "reset", "--hard", localMain);
    git(repo, "update-ref", "refs/remotes/origin/main", remoteMain);
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    const session = SessionManager.create(repo, join(temp, "sessions"));
    session.appendMessage({ role: "user", content: "new task", timestamp: Date.now() });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ready" }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const harness = makePiHarness();
    const enterContext = makeContext(session);
    await harness.commands.get("new-worktree")!("collision-task", enterContext);
    const record = Object.values(loadState(agent).records)[0]!;
    writeFileSync(join(record.destinationRoot, "tracked.txt"), "worktree change\n");
    writeFileSync(join(repo, "cache.ignored"), "source cache\n");

    const destinationSession = SessionManager.open(enterContext.switchedSessionFile!);
    await expect(harness.commands.get("exit-worktree")!("", makeContext(destinationSession))).rejects.toThrow();
    expect(readFileSync(join(repo, "cache.ignored"), "utf8")).toBe("source cache\n");
    expect(git(record.destinationRoot, "branch", "--show-current").trim()).toBe("collision-task");
    expect(readFileSync(join(record.destinationRoot, "tracked.txt"), "utf8")).toBe("worktree change\n");
    expect(loadState(agent).records[record.destinationRoot]!.phase).toBe("active");
  });

  it("rejects dirty submodules without touching an existing stash", async () => {
    const temp = mkdtempSync(join(tmpdir(), "pi-enter-exit-worktree-submodule-"));
    const agent = join(temp, "agent");
    const repo = join(temp, "super");
    const child = join(temp, "child");
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.PI_ENTER_EXIT_WORKTREE_ROOT = join(temp, "worktrees");
    initializeRepo(repo);
    initializeRepo(child);
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "sm");
    git(repo, "add", ".gitmodules", "sm");
    const tree = git(repo, "write-tree").trim();
    const parent = git(repo, "rev-parse", "HEAD").trim();
    const commit = execFileSync("git", ["commit-tree", tree, "-p", parent, "-m", "add submodule"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    git(repo, "update-ref", "refs/heads/main", commit);
    git(repo, "reset", "--hard", "HEAD");

    writeFileSync(join(repo, "tracked.txt"), "stash me\n");
    git(repo, "stash", "push", "-m", "existing stash");
    const stashBefore = git(repo, "rev-parse", "refs/stash").trim();
    writeFileSync(join(repo, "sm", "tracked.txt"), "dirty submodule\n");

    const session = SessionManager.create(repo, join(temp, "sessions"));
    session.appendMessage({ role: "user", content: "context", timestamp: Date.now() });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ready" }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const harness = makePiHarness();
    await expect(harness.commands.get("enter-worktree")!("submodule", makeContext(session))).rejects.toThrow(
      "Dirty submodules are not supported",
    );
    expect(git(repo, "rev-parse", "refs/stash").trim()).toBe(stashBefore);
    expect(readFileSync(join(repo, "sm", "tracked.txt"), "utf8")).toBe("dirty submodule\n");
    expect(Object.keys(loadState(agent).records)).toHaveLength(0);
  });
});
