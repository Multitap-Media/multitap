---
type: Process
title: "Secrets scan before commit, release or publish"
description: "How the repo scans for leaked secrets with betterleaks: the pre-commit hook, pnpm run secrets:scan modes, the shared config and ignore file, the maintainer-values env pattern, scanning logs, and how pasted secrets are handled in chat."
tags: [security, secrets, betterleaks, process]
generated: { by: agent/mcp, at: "2026-10-17T01:10:30Z" }
status: stable
---

Source: `.betterleaks.toml`, `scripts/secrets-scan.js`, `scripts/hooks/pre-commit`; AGENTS.md "Security reminders". This replaces the old `secrets-sweep` skill and its `git grep` pattern.

**Tool.** [betterleaks](https://github.com/betterleaks/betterleaks) (a gitleaks successor), installed at `~/.local/bin/betterleaks.exe` on Windows. WSL has no copy, so `pnpm run ci` skips the scan there with a warning (`--optional`). Findings are always redacted, so the output is safe to leave in a transcript.

**Config.** `.betterleaks.toml` extends betterleaks' default rules and adds this repo's: `multitap-manifest-url` (an addon manifest URL with configuration in the path), `multitap-proxy-password` (a non-placeholder `api_password=`), `multitap-media-token-secret`, `multitap-long-opaque-token` (120+ characters), and `multitap-provider-marker` (`streaming_provider`, `elfhosted`). Its global filter allows made-up passwords in test files (`test/`, `*.test.ts`, `*_test.go`) for the generic and password-shaped rules only, ALL_CAPS placeholders such as `METRICS_KEY`, and the public Easynews manifest signature fixture. The manifest-URL and provider rules still apply in tests. `.betterleaksignore` holds fingerprints of historic findings that were checked and are benign (the old skill quoted its own search pattern); add a line only after checking. <!-- betterleaks:allow -->

**Commands.**
- `pnpm run secrets:install-hook` once per clone: sets `core.hooksPath` to `scripts/hooks`, so every commit scans its staged changes. Bypass one commit with `git commit --no-verify` only when the finding is a checked false positive.
- `pnpm run secrets:scan` (staged), `secrets:scan all` (full history, staged and unstaged changes and untracked files; `pnpm run ci` runs this; changes are scanned as files with `betterleaks fs`, staged ones copied out of the index, since betterleaks 2.0.0-rc.5 has no `git --staged`/`--unstaged`), `secrets:scan history`, and `secrets:scan paths <file|dir>...` for files outside git: core logs, reports, scratch notes. Run `paths` on logs after any real-addon or real-engine run; info-level logs must show nothing, and debug logs always contain credentials, so never share them.
- `BETTERLEAKS_EXTRA_PATTERN` (an RE2 regex in your shell, never in the repo) adds the maintainer's current passwords, provider names or addresses as a rule for that run.

**Fixing a finding.** A real secret: remove it, rotate it, and treat history as exposed. A placeholder: make it obviously one (`<password>`, `…`, `REDACTED`) rather than widening the config. A repeated benign shape: tighten the rule's filter in `.betterleaks.toml` and prove it with a seeded file outside the repo.

**Chat and scratch.** Secrets pasted into chat go straight to a scratch file outside the repo (mode 600), and agents work from the path, not the value. Do not echo such files (a printed note once leaked a password into a transcript). Delete scratch databases that hold manifest URLs.

**Before publishing core.** Run `secrets:scan history`, and rotate anything found.

Related: [[architecture/secrets-policy]]; the `verify` skill.
