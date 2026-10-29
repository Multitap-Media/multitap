---
name: verify
description: Fully verify the repository before committing, releasing or reporting done: CI, contract run, Linux (WSL) run, flake triage, secrets scan. Use when asked to verify, check the tree, or before any commit that touches code.
---

# Verifying the tree

Run from the repo root on Windows. Report results plainly; if something failed,
say so with the test name.

## The gate
1. `pnpm run ci` (lint, typecheck, api:check, api:diff, docs:check, vitest, secrets scan). Read the `ci: ok` line.
   Do not pipe it into something that hides the exit status and then commit.
2. If routes, schemas, OpenAPI examples or contract config changed:
   `pnpm run contract` (WSL, native copy via `scripts/linux-run.sh`; read,
   client and admin passes must all be ok). Triage failures with the
   `contract-triage` skill.
3. Before a release or a hand-off: run everything on Linux too, from WSL:
   `scripts/linux-run.sh <root script> [args]`, e.g. `scripts/linux-run.sh ci`
   (lint, typecheck, tests, and the contract run when on Linux) or
   `scripts/linux-run.sh test packages/core/test/cors-tls.test.ts`. It copies the
   working tree to a native directory first (`source ~/.nvm/nvm.sh` in
   non-interactive WSL shells; set a private `WORK` if another run may be
   active). The SIGHUP TLS test only runs there.
4. `pnpm run docs:check` (docs vs code; `pnpm run ci` runs it too) and, after a concept change, `okf validate knowledge --strict`.
5. Secrets scan: `pnpm run secrets:scan all` (history, unstaged and untracked; `pnpm run ci` runs it
   too, and the pre-commit hook scans every commit). After a real-addon or real-engine run, also
   `pnpm run secrets:scan paths <log files>`. See okf:process/secrets-sweep.

## Flakes
- Known family: `read ECONNRESET` in node:http tests under full-suite load on
  Windows (cors-tls hardened by sending `Connection: keep-alive` with
  `agent: false` and destroying the client socket after `end`;
  gateway "answers HEAD…" has a retry-once workaround, root cause unknown).
- A red full run that is green when the file is run alone is a flake
  candidate, not proof. Re-run the full suite 3 times; **capture the failing
  test name and error** (`pnpm vitest run 2>&1 | grep -E "FAIL|Error:"`) and
  record new ones in `ROADMAP.md` (flaky-test history).
- Never "fix" a flake by lengthening timeouts without explaining why.

## Machine hygiene
- Never `taskkill /IM node.exe` (kills every node process on the machine,
  including other agents' Multitap processes). Kill by PID or match the command line.
- Keep scratch work in the session scratchpad, not in the repo.
