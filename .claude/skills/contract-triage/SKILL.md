---
name: contract-triage
description: Diagnose and fix Schemathesis contract-run failures (pnpm run contract) as real OpenAPI/behaviour mismatches or documented false positives. Use when the contract run fails or after adding or changing a /v1 route.
---

# Contract-run triage

`pnpm run contract` runs core against the fake addons and the fake engine (as
`home`) in WSL, in three passes (`read`, `client`, `admin`), with a stateful
phase that follows the OpenAPI `links`. Config: `packages/core/test/contract/run.ts`
and `schemathesis.toml`.

## Workflow
1. Run one pass and keep the output: `pnpm run contract -- --pass client > out.log 2>&1`
   then `grep -n -E "FAILURES|Failed|Reproduce|curl|Expected|Hint" out.log`.
   Options: `--seed N`, `--max-examples N`, `-- <schemathesis args>`.
2. Classify each failure:
   - **Real mismatch** (most of them so far). Fix the code or the document:
     - a status the route returns but doesn't declare (410 on session routes,
       400/404/409 on admin routes) → declare the response, with a problem body;
     - documented constraints that differ from validation (we removed name
       trimming; a `pattern` requiring a non-space character; a `client` key
       bag whose key length wasn't documented) → make schema and behaviour the
       same, preferably by validating the raw value;
     - a response field that can be `null` documented as non-null
       (`NextVideo.video`) → fix the schema.
   - **False positive.** Configure it narrowly, with a comment saying why:
     per-operation settings in `schemathesis.toml` (accepted statuses like
     400/404/409/410 for valid input), or the `--exclude-checks` list in
     `run.ts`.
3. Re-run the failing pass, then all three, then `pnpm run ci`.

## Current exclusions (and why)
- `ignored_auth`, `missing_required_header`: unauthenticated requests get 404
  by design (okf:architecture/core-api-keys-security).
- `negative_data_rejection` on GET: Schemathesis adds unknown query params and
  headers that core ignores. It stays ON for POST/PUT/PATCH/DELETE in a second
  invocation per pass (request bodies).
- `use_after_free`: a released session stays readable as `status: released` by
  design.
- `GET /v1/events` (SSE never ends) is disabled; Vitest covers it.

## Rules of thumb
- Don't widen an exclusion to make a run green; narrow it to one operation.
- A new lifecycle route needs OpenAPI `links` and, if it can answer 4xx for
  valid generated input, an entry in `schemathesis.toml`.
- After any route change: `pnpm run api:generate` before the run.
