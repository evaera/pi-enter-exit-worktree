import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATE_VERSION = 2;
const STATE_DIR = "enter-exit-worktree";
const CONFIG_FILE = "pi-enter-exit-worktree.json";
const STATUS_KEY = "enter-exit-worktree";

type Phase = "entering" | "active" | "exiting";

export interface HandoffRecord {
  destinationRoot: string;
  sourceRoot: string;
  sourceCwdRelative: string;
  sourceHead: string;
  branch: string;
  mode: EnterMode;
  enterBackupRef?: string;
  enterSignature?: string;
  enterFingerprint?: string;
  exitBackupRef?: string;
  exitSignature?: string;
  exitFingerprint?: string;
  phase: Phase;
  createdAt: string;
}

interface StateFile {
  version: number;
  records: Record<string, HandoffRecord>;
}

export interface ExtensionConfig {
  worktreeRoot?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RepoInfo {
  root: string;
  commonDir: string;
  head: string;
  primaryRoot: string;
  name: string;
}

interface Snapshot {
  ref?: string;
  signature: string;
  fingerprint: string;
}

type EnterMode = "enter" | "new";

function normalizePath(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

function expandPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolve(value);
}

export function configPath(baseAgentDir = agentDir()): string {
  return join(baseAgentDir, CONFIG_FILE);
}

export function loadConfig(baseAgentDir = agentDir()): ExtensionConfig {
  const path = configPath(baseAgentDir);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ExtensionConfig;
  if (parsed.worktreeRoot !== undefined && (typeof parsed.worktreeRoot !== "string" || !parsed.worktreeRoot.trim())) {
    throw new Error(`Invalid worktreeRoot in ${path}`);
  }
  return parsed;
}

function worktreeBaseDir(): string {
  const configured = process.env.PI_ENTER_EXIT_WORKTREE_ROOT ?? loadConfig().worktreeRoot;
  return configured ? expandPath(configured) : join(homedir(), "worktrees");
}

export function statePath(baseAgentDir = agentDir()): string {
  return join(baseAgentDir, STATE_DIR, "state.json");
}

export function loadState(baseAgentDir = agentDir()): StateFile {
  const path = statePath(baseAgentDir);
  if (!existsSync(path)) return { version: STATE_VERSION, records: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StateFile>;
  if (parsed.version !== STATE_VERSION || !parsed.records || typeof parsed.records !== "object") {
    throw new Error(`Unsupported worktree handoff state in ${path}`);
  }
  return parsed as StateFile;
}

export function saveState(state: StateFile, baseAgentDir = agentDir()): void {
  const path = statePath(baseAgentDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function mutateState(mutate: (state: StateFile) => void, baseAgentDir = agentDir()): void {
  const lock = join(baseAgentDir, STATE_DIR, "state.lock");
  mkdirSync(dirname(lock), { recursive: true });
  try {
    mkdirSync(lock);
  } catch {
    throw new Error("Another worktree handoff is updating shared state. Try again.");
  }
  try {
    const state = loadState(baseAgentDir);
    mutate(state);
    saveState(state, baseAgentDir);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function saveRecord(record: HandoffRecord): void {
  mutateState((state) => {
    state.records[record.destinationRoot] = record;
  });
}

function deleteRecord(destinationRoot: string): void {
  mutateState((state) => {
    delete state.records[destinationRoot];
  });
}

async function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? 1,
      };
      if (result.code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

async function git(args: string[], cwd: string): Promise<string> {
  return (await run("git", args, cwd)).stdout;
}

function parseWorktreePaths(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => normalizePath(line.slice("worktree ".length)));
}

async function repoInfo(cwd: string): Promise<RepoInfo> {
  let root: string;
  try {
    root = normalizePath((await git(["rev-parse", "--show-toplevel"], cwd)).trim());
  } catch {
    throw new Error("This command must run inside a Git working tree");
  }
  const commonRaw = (await git(["rev-parse", "--git-common-dir"], root)).trim();
  const commonDir = normalizePath(resolve(root, commonRaw));
  const head = (await git(["rev-parse", "HEAD"], root)).trim();
  const worktreePaths = parseWorktreePaths(await git(["worktree", "list", "--porcelain"], root));
  const primaryRoot = worktreePaths[0] ?? root;
  return { root, commonDir, head, primaryRoot, name: basename(primaryRoot) };
}

async function statusSignature(root: string): Promise<string> {
  return git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
}

async function checkoutFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await statusSignature(root));
  hash.update(await git(["diff", "--cached", "--binary", "--full-index", "HEAD"], root));
  hash.update(await git(["diff", "--binary", "--full-index"], root));
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"], root))
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const path of untracked) {
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    hash.update(path);
    hash.update(String(stat.mode));
    if (stat.isSymbolicLink()) hash.update(readlinkSync(absolute));
    else if (stat.isFile()) hash.update(readFileSync(absolute));
  }
  return hash.digest("hex");
}

function acquireOperationLock(commonDir: string): () => void {
  const lock = join(commonDir, "pi-enter-exit-worktree.operation.lock");
  const owner = join(lock, "pid");
  const create = () => {
    mkdirSync(lock);
    writeFileSync(owner, `${process.pid}\n`, { mode: 0o600 });
  };
  try {
    create();
  } catch {
    let liveOwner = true;
    try {
      const pid = Number(readFileSync(owner, "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0) liveOwner = false;
      else process.kill(pid, 0);
    } catch {
      liveOwner = false;
    }
    if (liveOwner) throw new Error("Another worktree handoff is already running for this repository");
    rmSync(lock, { recursive: true, force: true });
    create();
  }
  return () => rmSync(lock, { recursive: true, force: true });
}

async function assertNoDirtySubmodules(root: string): Promise<void> {
  const status = await git(["status", "--porcelain=v2", "--untracked-files=all"], root);
  const dirty = status.split("\n").filter((line) => {
    if (!line.startsWith("1 ") && !line.startsWith("2 ")) return false;
    const submodule = line.split(" ")[2] ?? "";
    return submodule.startsWith("S") && submodule.slice(1) !== "...";
  });
  if (dirty.length > 0) {
    throw new Error("Dirty submodules are not supported. Clean or separately move submodule changes first.");
  }
}

async function optionalRef(root: string, ref: string): Promise<string | undefined> {
  try {
    return (await git(["rev-parse", "--verify", ref], root)).trim();
  } catch {
    return undefined;
  }
}

async function assertClean(root: string, label: string): Promise<void> {
  if ((await statusSignature(root)).length > 0) {
    throw new Error(`${label} has uncommitted changes. Move or clean those changes first.`);
  }
}

export function sanitizeWorktreeName(value: string): string {
  const result = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80);
  if (!result) throw new Error("Worktree name must contain a letter or number");
  return result;
}

function backupRef(): string {
  return `refs/pi-enter-exit-worktree/${randomUUID()}`;
}

async function snapshotChanges(root: string, label: string, ref: string): Promise<Snapshot> {
  await assertNoDirtySubmodules(root);
  const signature = await statusSignature(root);
  const fingerprint = await checkoutFingerprint(root);
  if (!signature) return { signature, fingerprint };

  const before = await optionalRef(root, "refs/stash");
  await git(["stash", "push", "--include-untracked", "--message", label], root);
  const oid = await optionalRef(root, "refs/stash");
  if (!oid || oid === before) {
    throw new Error("Git did not create the expected handoff stash. Existing stashes were left untouched.");
  }
  await git(["update-ref", ref, oid], root);

  const top = await optionalRef(root, "refs/stash");
  if (top !== oid) throw new Error("Git stash changed unexpectedly while creating the handoff snapshot");
  await git(["stash", "drop", "stash@{0}"], root);
  return { ref, signature, fingerprint };
}

async function applySnapshot(root: string, snapshot: Snapshot): Promise<void> {
  if (!snapshot.ref) return;
  await git(["stash", "apply", "--index", snapshot.ref], root);
  const actual = await statusSignature(root);
  const fingerprint = await checkoutFingerprint(root);
  if (actual !== snapshot.signature || fingerprint !== snapshot.fingerprint) {
    throw new Error("Git working state changed while transferring the handoff snapshot");
  }
}

async function deleteRef(root: string, ref: string | undefined): Promise<void> {
  if (!ref) return;
  await git(["update-ref", "-d", ref], root);
}

async function restoreAfterFailedEnter(
  sourceRoot: string,
  destinationRoot: string,
  snapshot: Snapshot,
  sourceBranch?: string,
): Promise<boolean> {
  try {
    if (sourceBranch) {
      if (existsSync(destinationRoot)) {
        await git(["switch", "--detach", "HEAD"], destinationRoot);
      }
      await git(["switch", "--no-overwrite-ignore", sourceBranch], sourceRoot);
    }
    if (!snapshot.ref) return true;
    await applySnapshot(sourceRoot, snapshot);
    await deleteRef(sourceRoot, snapshot.ref);
    return true;
  } catch {
    return false;
  }
}

async function reusableArchive(
  sourceRoot: string,
  destinationParent: string,
  name: string,
): Promise<string | undefined> {
  const archiveRoot = join(destinationParent, ".exited");
  const candidates = parseWorktreePaths(await git(["worktree", "list", "--porcelain"], sourceRoot))
    .filter((path) => dirname(path) === normalizePath(archiveRoot) && basename(path).startsWith(`${name}-`))
    .sort((left, right) => basename(right).localeCompare(basename(left)));
  const candidate = candidates[0];
  if (!candidate) return undefined;
  return (await statusSignature(candidate)) === "" ? candidate : undefined;
}

function archivePath(destinationRoot: string): string {
  const parent = join(dirname(destinationRoot), ".exited");
  mkdirSync(parent, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${basename(destinationRoot)}-${stamp}`;
  for (let index = 0; index < 100; index++) {
    const candidate = join(parent, index === 0 ? base : `${base}-${index + 1}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not choose an archive path under ${parent}`);
}

function targetCwd(root: string, relativeCwd: string): string {
  const destination = resolve(root, relativeCwd);
  if (destination !== root && !destination.startsWith(`${root}/`)) {
    throw new Error(`Session directory is outside the repository root: ${relativeCwd}`);
  }
  if (!existsSync(destination)) mkdirSync(destination, { recursive: true });
  return destination;
}

function removeSessionFile(path: string | undefined): void {
  if (path) rmSync(path, { force: true });
}

function forkSession(sourceFile: string, cwd: string): string {
  const manager = SessionManager.forkFrom(sourceFile, cwd);
  const file = manager.getSessionFile();
  if (!file) throw new Error("Failed to create the relocated Pi session");
  return file;
}

async function chooseDefaultBranchRef(
  root: string,
  ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
): Promise<string> {
  if (await optionalRef(root, "refs/remotes/origin/HEAD")) {
    try {
      return (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root)).trim();
    } catch {
      // A direct origin/HEAD is ambiguous, so fall through to explicit selection.
    }
  }

  const output = await git(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
    root,
  );
  const branches = output
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value && !value.endsWith("/HEAD"));
  if (branches.length === 0) throw new Error("No local or remote branches are available");
  const selected = await ctx.ui.select("Default branch", branches);
  if (!selected) throw new Error("No default branch selected");
  return selected;
}

async function enterWorktree(
  pi: ExtensionAPI,
  args: string,
  ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
  mode: EnterMode = "enter",
): Promise<void> {
  await ctx.waitForIdle();
  if (ctx.mode !== "tui") throw new Error("/enter-worktree requires interactive Pi");
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("Cannot move an in-memory Pi session");

  const sourceCwd = normalizePath(ctx.sessionManager.getCwd());
  const source = await repoInfo(sourceCwd);
  const releaseOperation = acquireOperationLock(source.commonDir);
  try {
  const state = loadState();
  if (state.records[source.root]) {
    throw new Error("This checkout is already managed by worktree handoff. Use /exit-worktree first.");
  }
  const transitionalSibling = Object.values(state.records).find(
    (record) => record.sourceRoot === source.root && record.phase !== "active",
  );
  if (transitionalSibling) {
    throw new Error(
      `This checkout has an unfinished ${transitionalSibling.phase} handoff at ${transitionalSibling.destinationRoot}`,
    );
  }

  let rawName = args.trim();
  if (!rawName) {
    const branch = (await git(["branch", "--show-current"], source.root)).trim();
    const suggestion = pi.getSessionName() || branch.split("/").at(-1) || "task";
    rawName = (await ctx.ui.input("Worktree name", suggestion))?.trim() ?? "";
  }
  if (!rawName) {
    ctx.ui.notify("Cancelled", "info");
    return;
  }

  const name = sanitizeWorktreeName(rawName);
  let branch: string;
  let worktreeHead: string;
  if (mode === "new") {
    const defaultRef = await chooseDefaultBranchRef(source.root, ctx);
    worktreeHead = (await git(["rev-parse", `${defaultRef}^{commit}`], source.root)).trim();
    branch = name;
    if (await optionalRef(source.root, `refs/heads/${branch}`)) {
      throw new Error(`Branch already exists: ${branch}`);
    }
  } else {
    branch = (await git(["branch", "--show-current"], source.root)).trim();
    if (!branch) throw new Error("/enter-worktree requires the source checkout to be on a branch");
    worktreeHead = source.head;
  }

  const destinationParent = resolve(worktreeBaseDir(), source.name);
  mkdirSync(destinationParent, { recursive: true });
  const destinationRoot = join(normalizePath(destinationParent), name);
  if (existsSync(destinationRoot)) throw new Error(`Worktree path already exists: ${destinationRoot}`);
  const reusedFrom = mode === "enter"
    ? await reusableArchive(source.root, normalizePath(destinationParent), name)
    : undefined;

  const relativeCwd = relative(source.root, sourceCwd);
  const preparedRef = mode === "enter" ? backupRef() : undefined;
  const enterSignature = await statusSignature(source.root);
  const enterFingerprint = await checkoutFingerprint(source.root);
  const record: HandoffRecord = {
    destinationRoot: normalizePath(destinationRoot),
    sourceRoot: source.root,
    sourceCwdRelative: relativeCwd,
    sourceHead: worktreeHead,
    branch,
    mode,
    enterBackupRef: preparedRef,
    enterSignature,
    enterFingerprint,
    phase: "entering",
    createdAt: new Date().toISOString(),
  };
  saveRecord(record);
  ctx.ui.setStatus(STATUS_KEY, `entering ${name}`);

  let snapshot: Snapshot = { signature: "", fingerprint: await checkoutFingerprint(source.root) };
  let targetSessionFile: string | undefined;
  let replacementStarted = false;
  let switchAttempted = false;
  let switchCancelled = false;
  try {
    snapshot = mode === "enter"
      ? await snapshotChanges(source.root, `pi enter-worktree ${name}`, preparedRef!)
      : { signature: enterSignature, fingerprint: enterFingerprint };
    record.enterBackupRef = snapshot.ref;
    record.enterFingerprint = snapshot.fingerprint;
    saveRecord(record);
    if (mode === "enter") {
      await git(["switch", "--detach", worktreeHead], source.root);
    }
    if (reusedFrom) {
      await git(["checkout", "--no-overwrite-ignore", "--detach", worktreeHead], reusedFrom);
      await git(["worktree", "move", reusedFrom, destinationRoot], source.root);
      await git(["switch", "--no-overwrite-ignore", branch], destinationRoot);
    } else if (mode === "new") {
      await git(["worktree", "add", "-b", branch, destinationRoot, worktreeHead], source.root);
    } else {
      await git(["worktree", "add", destinationRoot, branch], source.root);
    }
    if (mode === "enter") await applySnapshot(destinationRoot, snapshot);

    record.phase = "active";
    saveRecord(record);

    const destinationCwd = targetCwd(record.destinationRoot, relativeCwd);
    targetSessionFile = forkSession(sessionFile, destinationCwd);
    switchAttempted = true;
    const switched = await ctx.switchSession(targetSessionFile, {
      withSession: async (replacementCtx) => {
        replacementStarted = true;
        removeSessionFile(sessionFile);
        replacementCtx.ui.setStatus(STATUS_KEY, undefined);
        replacementCtx.ui.notify(
          `${reusedFrom ? "Re-entered" : "Entered"} worktree ${record.destinationRoot}`,
          "info",
        );
      },
    });
    if (switched.cancelled) {
      switchCancelled = true;
      throw new Error("Pi session switch was cancelled");
    }
  } catch (error) {
    if (replacementStarted || (switchAttempted && !switchCancelled)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      throw error;
    }
    removeSessionFile(targetSessionFile);
    try {
      const durableRef = preparedRef ? await optionalRef(source.root, preparedRef) : undefined;
      const recoverableSnapshot = durableRef
        ? { ref: preparedRef, signature: enterSignature, fingerprint: record.enterFingerprint ?? snapshot.fingerprint }
        : snapshot;
      const restored = await restoreAfterFailedEnter(
        source.root,
        destinationRoot,
        recoverableSnapshot,
        mode === "enter" ? branch : undefined,
      );
      if (restored) {
        let destinationHandled = !existsSync(destinationRoot);
        if (!destinationHandled && reusedFrom && !existsSync(reusedFrom)) {
          try {
            await git(["worktree", "move", destinationRoot, reusedFrom], source.root);
            destinationHandled = true;
          } catch {
            // Fall through to archiving the checkout.
          }
        }
        if (!destinationHandled && existsSync(destinationRoot)) {
          try {
            await git(["switch", "--detach", "HEAD"], destinationRoot);
            await git(["worktree", "move", destinationRoot, archivePath(destinationRoot)], source.root);
            destinationHandled = true;
          } catch {
            // Keep the entering record so the checkout remains recoverable.
          }
        }
        let branchHandled = true;
        if (destinationHandled && mode === "new" && (await optionalRef(source.root, `refs/heads/${branch}`))) {
          try {
            await git(["branch", "-D", branch], source.root);
          } catch {
            branchHandled = false;
          }
        }
        if (destinationHandled && branchHandled) deleteRecord(record.destinationRoot);
      }
    } finally {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    throw error;
  }
  } finally {
    releaseOperation();
  }
}

async function exitWorktree(
  ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
): Promise<void> {
  await ctx.waitForIdle();
  if (ctx.mode !== "tui") throw new Error("/exit-worktree requires interactive Pi");
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("Cannot move an in-memory Pi session");

  const currentCwd = normalizePath(ctx.sessionManager.getCwd());
  const current = await repoInfo(currentCwd);
  const releaseOperation = acquireOperationLock(current.commonDir);
  try {
  const state = loadState();
  const record = state.records[current.root];
  if (!record) {
    throw new Error(`This is not a worktree created by /enter-worktree: ${current.root}`);
  }
  if (record.phase === "entering") {
    throw new Error("The enter operation did not finish. Recovery metadata is preserved in the state file.");
  }
  const transitionalSibling = Object.values(state.records).find(
    (candidate) =>
      candidate.destinationRoot !== record.destinationRoot &&
      candidate.sourceRoot === record.sourceRoot &&
      candidate.phase !== "active",
  );
  if (transitionalSibling) {
    throw new Error(
      `The source checkout has an unfinished ${transitionalSibling.phase} handoff at ${transitionalSibling.destinationRoot}`,
    );
  }

  const source = await repoInfo(record.sourceRoot);
  if (source.commonDir !== current.commonDir) throw new Error("The source checkout belongs to a different Git repository");

  let snapshot: Snapshot;
  if (record.phase === "exiting") {
    if (record.exitSignature === undefined || record.exitFingerprint === undefined) {
      throw new Error("Exit recovery metadata is incomplete");
    }
    snapshot = {
      ref: record.exitBackupRef,
      signature: record.exitSignature,
      fingerprint: record.exitFingerprint,
    };
    await assertClean(current.root, "Managed worktree");
    if (
      (await statusSignature(source.root)) !== snapshot.signature ||
      (await checkoutFingerprint(source.root)) !== snapshot.fingerprint
    ) {
      throw new Error("Exit recovery is ambiguous. The source checkout does not match the recorded snapshot.");
    }
  } else {
    await assertClean(source.root, "Source checkout");
    const preparedRef = backupRef();
    record.phase = "exiting";
    record.exitBackupRef = preparedRef;
    record.exitSignature = await statusSignature(current.root);
    record.exitFingerprint = await checkoutFingerprint(current.root);
    saveRecord(record);
    try {
      snapshot = await snapshotChanges(current.root, "pi exit-worktree", preparedRef);
      record.exitBackupRef = snapshot.ref;
      saveRecord(record);
      await git(["switch", "--detach", "HEAD"], current.root);
      try {
        await git(["switch", "--no-overwrite-ignore", record.branch], source.root);
      } catch (switchError) {
        await git(["switch", "--no-overwrite-ignore", record.branch], current.root);
        await applySnapshot(current.root, snapshot);
        record.phase = "active";
        record.exitBackupRef = undefined;
        record.exitSignature = undefined;
        record.exitFingerprint = undefined;
        saveRecord(record);
        await deleteRef(source.root, snapshot.ref);
        throw switchError;
      }
      await applySnapshot(source.root, snapshot);
    } catch (error) {
      const currentStatus = await statusSignature(current.root);
      if (currentStatus === record.exitSignature) {
        record.phase = "active";
        record.exitBackupRef = undefined;
        record.exitSignature = undefined;
        record.exitFingerprint = undefined;
        saveRecord(record);
      }
      throw error;
    }
  }

  ctx.ui.setStatus(STATUS_KEY, "exiting worktree");
  let targetSessionFile: string | undefined;
  let replacementStarted = false;
  let switchAttempted = false;
  let switchCancelled = false;
  try {
    const sourceCwd = targetCwd(source.root, record.sourceCwdRelative);
    targetSessionFile = forkSession(sessionFile, sourceCwd);
    switchAttempted = true;
    const switched = await ctx.switchSession(targetSessionFile, {
      withSession: async (replacementCtx) => {
        replacementStarted = true;
        let cleanupWarning: string | undefined;
        try {
          let preservedPath = record.destinationRoot;
          try {
            preservedPath = archivePath(record.destinationRoot);
            await git(["worktree", "move", record.destinationRoot, preservedPath], source.root);
          } catch (archiveError) {
            cleanupWarning = `Exited successfully, but could not archive the old worktree: ${String(archiveError)}`;
          }
          cleanupWarning ??= `Exited successfully. Preserved the old worktree at ${preservedPath}.`;
          await deleteRef(source.root, record.enterBackupRef);
          await deleteRef(source.root, record.exitBackupRef);
          deleteRecord(record.destinationRoot);
          removeSessionFile(sessionFile);
        } catch (cleanupError) {
          cleanupWarning = `Exited successfully, but cleanup is incomplete: ${String(cleanupError)}`;
        }
        replacementCtx.ui.setStatus(STATUS_KEY, undefined);
        replacementCtx.ui.notify(cleanupWarning ?? `Exited worktree to ${source.root}`, cleanupWarning ? "warning" : "info");
      },
    });
    if (switched.cancelled) {
      switchCancelled = true;
      throw new Error("Pi session switch was cancelled");
    }
  } catch (error) {
    if (!replacementStarted && (!switchAttempted || switchCancelled)) {
      removeSessionFile(targetSessionFile);
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
    throw error;
  }
  } finally {
    releaseOperation();
  }
}

export default function worktreeHandoffExtension(pi: ExtensionAPI) {
  pi.registerCommand("enter-worktree", {
    description: "Move this Pi session and Git changes into a managed worktree",
    handler: async (args, ctx) => enterWorktree(pi, args, ctx),
  });

  pi.registerCommand("new-worktree", {
    description: "Create a clean worktree from the repository default branch and move this Pi session into it",
    handler: async (args, ctx) => enterWorktree(pi, args, ctx, "new"),
  });

  pi.registerCommand("exit-worktree", {
    description: "Move this Pi session and Git changes back to its source checkout",
    handler: async (_args, ctx) => exitWorktree(ctx),
  });

  pi.registerTool({
    name: "enter_worktree",
    label: "Enter Worktree",
    description:
      "Move the current Pi session and all repository changes into a new managed Git worktree. Use when the user asks to enter, move into, or continue in a worktree.",
    promptSnippet: "Move the current session and repository changes into a managed Git worktree",
    promptGuidelines: [
      "Use enter_worktree when the user asks to enter or move the current task into a worktree.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Short worktree name. Omit to ask the user." })),
    }),
    async execute(_id, params) {
      const suffix = params.name?.trim() ? ` ${sanitizeWorktreeName(params.name)}` : "";
      pi.sendUserMessage(`/enter-worktree${suffix}`, { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued /enter-worktree." }],
        details: {},
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "new_worktree",
    label: "New Worktree",
    description:
      "Create a clean worktree and branch from the repository default branch, then move the current Pi session into it without transferring source checkout changes. Use when the user asks to start a new worktree.",
    promptSnippet: "Create a clean worktree from the default branch and move the current session into it",
    promptGuidelines: [
      "Use new_worktree when the user asks to create or start a new worktree without carrying current changes into it.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Short worktree and branch name. Omit to ask the user." })),
    }),
    async execute(_id, params) {
      const suffix = params.name?.trim() ? ` ${sanitizeWorktreeName(params.name)}` : "";
      pi.sendUserMessage(`/new-worktree${suffix}`, { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued /new-worktree." }],
        details: {},
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "exit_worktree",
    label: "Exit Worktree",
    description:
      "Move the current Pi session and all repository changes back to the source checkout recorded by enter_worktree or new_worktree, switching that checkout to the worktree branch. Use when the user asks to exit or leave the worktree.",
    promptSnippet: "Return the current session and repository changes to its recorded source checkout",
    promptGuidelines: [
      "Use exit_worktree when the user asks to exit or leave a worktree created by enter_worktree.",
    ],
    parameters: Type.Object({}),
    async execute() {
      pi.sendUserMessage("/exit-worktree", { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued /exit-worktree." }],
        details: {},
        terminate: true,
      };
    },
  });
}
