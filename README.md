# Interlock

Interlock gives a Pi agent a durable work contract and an exclusive exact-path lease while Beads remains the task authority. Interlock V1 supports macOS and Linux only.

See `GOAL.md` for the V1 completion contract.

## V1 conflict rule

Interlock conflicts only on exact declared repository-relative Git paths after portable separator normalization, NFC Unicode normalization, and deterministic case folding. This V1 rule applies on every filesystem, so case-distinct paths conflict even on a case-sensitive worktree. The conservative rule prevents clients in worktrees on different filesystems from missing a shared Git-common lease collision.

Interlock V1 does not treat symlink or hard-link physical-file aliases as lock aliases. Two agents can declare different Git paths that resolve to the same physical file. This is an ACCEPTABLE-RISK coordination limitation. Agents must declare the same repository-relative Git path when they need a conflict.
