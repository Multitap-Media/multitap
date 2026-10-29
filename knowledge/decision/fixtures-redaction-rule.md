---
type: Decision
title: Captured addon responses are redacted before commit; never add an unredacted fixture
description: "Rule for packages/addon-protocol test fixtures: real addon responses are captured and redacted (stream URLs replaced, proxy header values replaced, credentials replaced, internal blobs removed, Torrentio trimmed). Never add a fixture containing a real stream URL, a manifest URL with configuration, a key, a username or a password."
tags: [fixtures, redaction, secrets, requirement]
generated: { by: agent/mcp, at: "2026-10-09T15:24:00Z" }
status: stable
---

Source: packages/addon-protocol/test/fixtures/real/README.md (13 lines); AGENTS.md "Never commit real manifest URLs".

**Captured on 2026-09-27** from Cinemeta, the YouTube channels addon, public Torrentio, a Torrentio configuration with Real-Debrid, and Easynews++.

**Redaction, before commit:**
- every stream `url` and `externalUrl` replaced with `https://example.invalid/redacted/<n>`;
- `proxyHeaders` values replaced;
- credential strings (debrid key, usenet account, private addon host) replaced with `REDACTED`;
- Easynews++'s internal `_temp` blobs removed;
- public Torrentio responses trimmed to 20 streams each.

**Rule.** Never add a fixture that contains a real stream URL, a manifest URL with configuration, a key, a username or a password. The secrets scan (betterleaks, on every commit) checks for these ([[process/secrets-sweep]]).

Related: Core README.
