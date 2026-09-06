# V1 candidate evidence — 2026-09-06

Status: local candidate. The release gate is not complete. Nothing is published by this work.

The candidate is based on `875e188` in branch `feat/gtm-v1`. The primary checkout is unchanged. The final candidate version is `1.0.0`. The initial dogfood archive used version `0.0.4`; its evidence remains below as development history. The remote PR also includes the earlier local MCP integration after remote base `ef09ff8`.

## Verified behavior

| Check | Evidence |
|---|---|
| Root regression suite | Recorded run: 296 tests, 295 passed, one Linux-only skip, zero failures. The subsequent full gate also passed the test command after the remaining lifecycle and Pi fixes. |
| Linux validation | Node 22.23.2 on Linux arm64: 300 tests, 297 passed, three macOS-only skips, zero failures. Adapter: three passed. Type checks, unused-symbol checks, and dependency audit passed. Beads 1.2.2 was verified against its published checksum. |
| Linked lifecycle review | Independent adversarial review passed 25 focused tests. Ownership, acceptance drift, legacy attachment, terminal history, and pending recovery findings were fixed. |
| Verification and communication review | Independent security review passed 31 focused tests. Ordinary descendant timeout and owner-death cleanup, bounded output, retry identity, privacy filters, and MCP authorization passed. |
| Adapter | Three existing adapter tests passed against the current root package. |
| Pi | Eight lifecycle tests passed. Real Pi 0.84.4 loaded the packed extension and passed claim, heartbeat, reload retention, checkpoint restoration, and departure release. No model inference was used for this host smoke. |
| Packed repositories | Three real Beads repositories completed CLI work. Two worktrees rejected an exact-path collision and retained one owner. |
| Packed MCP workflow | Separate server processes passed task contention, a lost send response, owner SIGKILL, verified recovery, restart, retry deduplication, context restoration, and observed completion. |
| Actual model agents | Two native agents used the installed CLI for clarification, review, approval, and completion. Only `total.mjs` changed. Both acceptance checks passed. Task `total` and Beads `agentv1-mbm` reached terminal completion. The reviewer had zero pending messages. No human relayed work context. |
| Atlas | Packed read-only status passed at `04cce89e5c166b1b191fc6fe51d1a0d590942fef`. Tracked application files remained unchanged. |
| Quality | Type checks, unused-symbol checks, dependency audit, adapter checks, governance checks, whitespace, and file-size checks passed. |

The scripted MCP scenario measured 2,672.9 ms for recovery, one claim winner, zero duplicate effects, and one passing observed acceptance item out of one. A supplementary run against the same archive also closed both sides of the thread and verified zero pending messages. These are controlled workflow measurements, not production performance guarantees.

The archive SHA-256 is `edc633698db071395c47717f26c5234b2209276e8853582d5cc7d605f01477b5`.

The final `1.0.0` archive passed a fresh build, pack, installation, scripted dogfood, and Pi host smoke after complexity cleanup. Its SHA-256 is `22761c507b47800e1fabc28b614e7cff1a4223fef60096c0d4578329e0dd272b`. This run measured 3,469.6 ms recovery, one claim winner, zero duplicate effects, zero pending messages, and one passing observed acceptance item out of one. Packaged documentation matches the source.

Two actual agents also repeated the task against this exact final archive. Contract `4b6212e0-ae8c-414f-aae9-c9ae6a5a753b` and Beads issue `agentv1-st9` reached completion. Both captured checks passed. Only `total.mjs` changed, and the reviewer finished with zero pending messages. A long terminal input batch required a shorter retry before sending a review request; this caused no duplicate message or extra file change.

## Local evidence locations

- `.omx/gtm-v1-tests.log`
- `.omx/gtm-v1-quality.log`
- `.omx/gtm-v1-quality-final.log`
- `.omx/gtm-v1-remote-base-quality.log`
- `.omx/evidence/dogfood/2026-09-06T20-16-40.072Z/release-verification.json`
- `.omx/evidence/pi-1.0.0/interlock-pi-smoke-RFPIOk/evidence.json`
- `.omx/evidence/linux-v1/output.log`
- `.omx/evidence/linux-v1/container-state.json`
- `.omx/evidence/linux-v1/image-digest.json`
- `.omx/evidence/linux-v1/source.sha256`
- `.omx/evidence/linux-v1/run.sh`
- `.engineering/quality-report.json`
- `.omx/evidence/dogfood/2026-09-06T18-54-09.414Z/report.json`
- `.omx/evidence/dogfood/2026-09-06T18-57-21.790Z/report.json`
- `.omx/packed-pi-smoke.log`
- `.omx/evidence/dogfood/real-agent-v1/final-inspect.json`
- `.omx/evidence/dogfood/real-agent-v1/producer-evidence.txt`
- `/Volumes/RTL-2TB/interlock-pi-smoke-7Gjh65/evidence.json`

These local artifacts are not included in the npm package. Run `node scripts/dogfood-v1.mjs` from an approved external worktree to repeat the scripted scenario. Run `TMPDIR=/Volumes/RTL-2TB PI_BIN=pi node test/pi/host-smoke.mjs <installed-package-root>` to repeat the isolated host smoke.

## Remaining release gates

- The full local engineering gate now passes, including native ESLint correctness and complexity checks. All 36 initial complexity findings were resolved without suppressions. The user authorized the development-only tooling. The exact committed revision must also pass hosted CI before release.
- Coverage, mutation, duplication, dependency-cycle, and automated security analysis remain unconfigured warnings. Manual reviews and TypeScript unused checks do not establish those properties.
- GitHub reports `main` is not protected. Required remote checks and review enforcement are not installed by the local hooks. The changed CI workflow has not run remotely.
- Remote CI, public release publication, and long-running production use remain unverified. Local Linux validation does not establish the remote CI result.
- The stored npm credential returns HTTP 401. GitHub release distribution is the available publication path. Do not interpret a GitHub release as npm registry publication.

Linux validation used a separate temporary Colima profile with external storage. The existing default profile could not start because its disk was marked in use. The temporary profile and its container data were removed after validation. The default profile and Docker context were retained.

Verification records the executed command and its outcome. It does not independently judge whether that command is a sufficient acceptance test. Same-user filesystem access, deliberately detached subprocesses, and external Beads writes remain outside an atomic security boundary.
