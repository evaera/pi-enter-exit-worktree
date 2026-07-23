# Changelog

## Unreleased

- Allow multiple active managed worktrees to share the same source checkout.
- Preserve recovery isolation by blocking sibling operations while a handoff is unfinished.
- Allow `/new-worktree` to leave staged, unstaged, untracked, and ignored source changes untouched.

## 0.1.0

- Add `/enter-worktree` for moving the current branch, working state, and Pi session into a managed worktree.
- Add `/new-worktree` for creating a clean branch and worktree from the repository default branch.
- Add `/exit-worktree` for moving the worktree branch, working state, and Pi session back to the source checkout.
- Add reusable archived worktrees, configurable storage, and recovery safeguards.
