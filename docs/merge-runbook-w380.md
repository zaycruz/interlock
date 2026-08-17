# Merge runbook: w380-unification to canonical main

This runbook merges branch `w380-unification` (tip `3be3174`) into canonical
`main` (base `019f142`). Run every step yourself. Do not trust a self-report.

## Preconditions

Do not start this runbook until all conditions are true:

- Head office has relayed the QA PASS verdict from space wP for tip
  `3be3174`.
- Your local repository is clean: `git status` shows no staged or unstaged
  changes.
- Your local branch tip matches the reviewed tip:

  ```bash
  git rev-parse w380-unification   # must print 3be3174...
  git rev-parse main               # must print 019f142...
  ```

If either SHA differs, stop. Escalate to head office. The QA verdict does
not cover a different tip.

## Merge

```bash
cd /Users/master/projects/interlock
git checkout main
git merge --no-ff w380-unification -m "Merge w380-unification: unified coordination plane + QA must-fix fixes"
```

Resolve no conflicts by hand-editing test expectations. If the merge has
conflicts, stop and escalate to engineering (wT) through head office.

## Verify the merged result

Run the full suite on merged main. Do not skip the build.

```bash
npm ci
npm run typecheck
npm test
```

Expected result: 85 tests, 84 pass, 1 skip (Linux-only process-identity
test), 0 fail.

If any check fails, do not merge-force and do not patch on main. Go to
Rollback.

## Record and report

```bash
git rev-parse main
```

Report the resulting main SHA to head office by space mail. From that point
this team owns the repository end to end.

## Rollback

WARNING: Rollback discards the merge commit on local main. Use it only
before you have reported the new main SHA to head office.

```bash
git checkout main
git reset --hard 019f142
```

Then report the failed merge and the failing test output to head office.
Head office routes the findings to engineering (wT).
