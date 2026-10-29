---
type: Decision
title: "Multitap's repository starts with fresh history"
description: "Decision 2026-10-25: Multitap is published from its own repository whose git history starts fresh (first commit tagged v0.2.0, 2026-10-29, the private work before it squashed in), with nothing carried over from the project it was built in; the release record before that lives in the CHANGELOG."
tags: [core, publishing, repository, decision]
generated: { by: "agent/claude-opus-5.5", at: "2026-10-26T12:00:00Z" }
status: stable
---

**Decision (2026-10-25).** Multitap is published from **its own repository with fresh git history**. Multitap was first built inside a larger private project, as the server its apps use. No commits came over: this repository starts from a snapshot of Multitap's tree on 2026-10-26, once the public name was applied ([[decision/core-public-name-multitap]]). While the repository was still private, from 2026-10-26 to 2026-10-29, its first commit was followed by fixes (line endings, the secrets scan) and docs changes; before it went public they were squashed into that commit (maintainer, 2026-10-29), so the first commit is dated 2026-10-29. This one rewrite came before anything was public; pushed history is never rewritten after that ([[decision/release-without-approval]]).

**What came along:** the server (`packages/core`), the client packages (`packages/api`, `packages/addon-protocol`), the pnpm workspace, the lint and dependency-cruiser boundary rules ([[architecture/boundary-rule]]), the test fakes and the contract harness, the scripts the checks need, the Dockerfile, the licences ([[decision/core-licence]]), this knowledge bundle (Multitap's own concepts, rewritten where they described the original project or its deployment) and the October 2026 review ([[core-review/summary]]).

**What follows from it.**
- The first commit is the 0.2.0 release, tagged `v0.2.0`, which is `pnpm run api:diff`'s first baseline. Releases 0.1.0 to 0.1.4 were tagged `core-v*` in the original repository; their record is in `CHANGELOG.md` and [[fact/core-release-history]], not in git.
- The secrets scan before publishing is of this repository's history ([[process/secrets-sweep]]); it came back clean on 2026-10-26, and again on 2026-10-29 for the squashed history.
- Apps that used Multitap inside the original project now depend on the published packages, like any other client.

Related: [[process/core-release]], [[core-review/summary]].
