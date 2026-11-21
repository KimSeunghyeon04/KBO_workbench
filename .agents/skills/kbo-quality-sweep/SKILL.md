---
name: kbo-quality-sweep
description: Run scoped or incremental quality sweeps of KBO Workbench, with reproducible findings, regression checks, and preservation of existing edits and user data. Use for requested repository audits or sweep-driven fixes.
---

# KBO quality sweep

Read the repository profile at [docs/quality-sweep/kbo-workbench.md](../../../docs/quality-sweep/kbo-workbench.md)
before starting a sweep. Resolve this link from this skill directory. Use
`git rev-parse --show-toplevel` in the user's checkout to obtain the actual root. The profile owns the
area map, severity criteria, allowed checks, mutation procedure, and completion criteria. Repository
`AGENTS.md` and the user's scope take precedence. No external quality-sweep installation is required.

## Choose the requested scope

For an audit, report evidenced findings without changing code. For sweep-driven fixes, reproduce each
finding and make the smallest correction in its owning module. Creating or installing this skill does
not request a sweep. Do not start a goal, schedule, commit, push, PR, or deployment merely by loading it.
Use an existing goal only when the user explicitly requested one. Keep the invocation automatically
discoverable; the workflow itself respects the requested action.

## Preserve the working state

Record HEAD and existing staged, unstaged, and untracked source changes. Inspect code in the original
checkout without resetting, restoring, stashing, cleaning, changing branches, or formatting it globally.
Read the profile's required repository documents, public package entrypoints, and related tests.
Use Graft first for code boundaries, and callers/grep when exhaustive impact analysis is needed.

Use `scripts/quality-sweep.py prepare` from the repository root to make a separate snapshot of the
current source bytes, including uncommitted edits. Keep its absolute path and source manifest with the
run's ledger. Run checks through the helper in that snapshot. Install dependencies there separately;
never link the original node_modules or reuse Windows dependencies in a Linux container.

The helper excludes real env files and user data before reading contents, rejects links and junctions,
strips DB/workspace/Compose environment settings, and allows only the profile's checks. It is an
accidental-misuse guard, not an OS security boundary. Do not use the original `sweep_guard.py` or
`scope_check.py` as proof that ignored data or KBO operational commands are protected. Never connect
the sweep to the user's workspace or database. Follow the separate reviewed, isolated path in the
profile when DB integration or E2E is required.

If source verification detects another edit, preserve it and create a fresh snapshot. A dirty original
checkout is expected. When fixes are requested, apply only reviewed patches in the original checkout
and validate a new snapshot; do not copy the snapshot back over user files.

## Review and verify

Follow the profile's risk order within the user's scope. Report actual input/state → incorrect result,
file and line, violated contract, severity and confidence. Track rejected candidates and reasons so
they do not recur without new evidence. Do not treat every refactoring preference as a defect.

For fixes, reproduce with a regression at the same layer and preserve source evidence, deterministic
findings/hash, atomic updates, blocking behavior and sealed immutability. Correction bugs require a
fixture with anonymized players and teams. Review all affected consumers before closing a finding.
Use meaningful function and call-site mutations for critical rules; use the helper's byte-preserving
`mutate` in the snapshot, inspect the actual assertion, and reject syntax/import failures as evidence.

Run targeted checks, then the profile's six base quality gates and applicable architecture,
integration/E2E or performance checks. Verify UI changes in a real browser with the repository's
relevant UI skills. Record environment failures, skipped DB tests and unverified browser behavior as
unfinished verification. Do not lower strict schemas, weaken tests, refresh golden hashes blindly, or
change user data to obtain a passing result.

Keep a run ledger in the snapshot with findings, causes, fixes, test/mutation evidence and unresolved
decisions. Review the covered scope again and then review changes introduced by that recheck.
Use subagents only when the user or applicable instructions authorize delegation; single-agent
review is supported. Stop and report at the profile's bounds rather than repeating unproductive work.

Report coverage, confirmed findings, changes, actual check results and limitations, source-preservation
verification, and the next unresolved action. Preserve the original dirty state and distinguish
existing changes from the requested sweep patches. Never claim the ledger's format check alone
proves completion.
