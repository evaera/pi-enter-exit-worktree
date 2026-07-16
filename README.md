# pi-enter-exit-worktree

A focused Git worktree manager for [Pi](https://github.com/earendil-works/pi) that moves the live session with your working state.

`pi-enter-exit-worktree` moves branches and uncommitted changes between a primary checkout and managed worktrees. It also supports starting a clean task from the repository's default branch.

## Requirements

- Pi
- Git

## Installation

Install directly from GitHub:

```bash
pi install git:github.com/evaera/pi-enter-exit-worktree
```

For local development, install the project directory instead:

```bash
pi install /path/to/pi-enter-exit-worktree
```

Run `/reload` after changing an existing installation.

## Usage

```text
/enter-worktree [name]   Move the current branch, changes, and Pi session into a worktree
/new-worktree [name]     Create a clean branch and worktree from the default branch
/exit-worktree           Move the worktree branch, changes, and Pi session back
```

Pi also receives `enter_worktree`, `new_worktree`, and `exit_worktree` tools for natural-language requests.

### Entering a worktree

`/enter-worktree` transfers the current branch, staged changes, unstaged changes, untracked files, and live Pi session into:

```text
~/worktrees/<repo-folder>/<worktree-name>
```

The source checkout is left clean and detached at its previous commit so the branch can be checked out by the managed worktree.

### Creating a new worktree

`/new-worktree` creates a new branch named after the worktree, based on the repository's default branch, without transferring anything from the source checkout. Staged, unstaged, untracked, and ignored files remain untouched in the source checkout.

The default branch is discovered from symbolic `origin/HEAD`. When that ref is unavailable or ambiguous, Pi asks you to select a local or remote branch instead of assuming `main` or `master`.

### Exiting a worktree

`/exit-worktree` requires the source checkout to be clean, but its current branch does not matter. The extension:

1. Snapshots changes from the managed worktree.
2. Detaches the managed worktree to release its branch.
3. Switches the source checkout to that branch.
4. Restores staged, unstaged, and untracked changes.
5. Moves the Pi session back.
6. Archives the old worktree under `<repo-folder>/.exited/`.

Entering the same worktree name again reuses the newest clean archive. This preserves ignored files such as dependencies and build caches. A dirty archive is left untouched and a fresh worktree is created.

## Configuration

Create `~/.pi/agent/pi-enter-exit-worktree.json`:

```json
{
  "worktreeRoot": "~/worktrees"
}
```

`worktreeRoot` accepts an absolute path or a path beginning with `~/`. Set `PI_ENTER_EXIT_WORKTREE_ROOT` to override the JSON value for one Pi process.

## Safety

- The source checkout may be dirty when creating a new worktree, but it must be clean before exiting one.
- Exit deliberately changes the source checkout to the managed worktree's branch.
- Branch switches refuse to overwrite ignored files.
- Ignored files are not transferred. Exited worktrees are archived rather than deleted.
- Internal Git snapshots remain reachable until a handoff finishes successfully.
- Dirty submodules are rejected rather than partially transferred.
- Interrupted or conflicting operations preserve recovery metadata under `~/.pi/agent/enter-exit-worktree/`.

## Development

```bash
npm install
npm run check
npm test
npm pack --dry-run
```

The extension uses Pi's public extension and session APIs and Git's public worktree and stash interfaces.

## License

MIT
