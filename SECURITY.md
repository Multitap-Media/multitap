# Security policy

This policy covers **Multitap** (`packages/core` and its container image) and the
client packages `@multitap/api` (`packages/api`) and `@multitap/addon-protocol`
(`packages/addon-protocol`).

## Reporting a vulnerability

Report it privately. Please don't open a public issue, pull request or
discussion about it.

- **Email:** project@multitap.dev

Include what you can of:

- the version (`vX.Y.Z` tag, image tag or commit) and how Multitap runs
  (bare host or Docker, built-in TLS or a proxy, which settings matter);
- the steps, a proof of concept or a failing test, and what an attacker gains;
- whether you plan to publish, and when.

Leave out real secrets: no API keys, media tokens, addon manifest URLs (they
often carry account credentials), stream URLs or engine passwords. Use
placeholders or a throwaway setup.

What happens next: this is a small project run by volunteers, so there's no
guaranteed response time, but we aim to acknowledge a report within a week and
to agree a disclosure date with you. A fix ships in a patch release with an
entry under "Security" in [CHANGELOG.md](CHANGELOG.md),
crediting you unless you'd rather not be named.

Test only against a deployment you own. Don't access other people's data, and
don't run denial-of-service tests against anyone else's instance.

## Supported versions

Multitap is `0.x`. Security fixes go into `main` and ship in the next patch
release of the current minor version. Older releases get no backports: upgrade
to the latest.

| Version | Security fixes |
|---|---|
| Latest `0.2.x` release | Yes |
| Earlier releases | No, upgrade |

The client packages aren't published on their own yet; they are released
with Multitap, and the same rule applies.

## Threat model

Multitap is designed for these conditions, and a way to break them is a
vulnerability:

- **Addons are hostile.** Anyone may install any addon URL, so manifests,
  catalogs, metas, streams and subtitles are attacker-controlled: their size,
  timing, shape, text and the URLs in them.
- **The media listener faces the internet.** Anyone can send it requests. A
  media token holder is a browser, not a trusted client.
- **API key holders are trusted clients, within their scope.** A key with
  fewer scopes must not be able to do more.
- **The engine has no authentication.** Only Multitap may reach it, and Multitap must
  not let anyone else steer it beyond what the design allows.
- **Operators are not security experts.** Unsafe defaults and silent
  misconfiguration count.

## In scope

- Addon input that makes Multitap fetch from loopback, private, link-local or
  metadata addresses not listed in `MULTITAP_ADDON_PRIVATE_ALLOW`, or call the engine's
  API.
- Addon input that freezes Multitap or exhausts its memory or CPU (slow regexes,
  oversized responses, unbounded caches).
- On the media listener: serving anything other than a valid token's own
  media, forging, extending or reviving a token after it expired or was
  revoked, path tricks, or reaching the engine through it.
- API keys: a route reachable with less than its scope, a way past
  authentication, a revoked key that still works, or the API revealing itself
  to a caller without a key (it answers `404` like an unknown path).
- Secrets leaking: addon manifest URLs, stream URLs, the engine's proxy
  password, API keys or media tokens in `/v1` responses, events, error details,
  metrics labels, or logs at `info` and above.
- A default or a silent misconfiguration that exposes Multitap or the engine.

## Out of scope

- **What an `admin` key can do.** Admin keys are trusted with everything:
  installing addons, configuring engines, and downloading backups, which
  contain every stored secret. Likewise, a `client` key acting within its
  scope, for example minting media tokens for any session.
- **The engine itself** (for example
  [stremio-server-go](https://github.com/M0Rf30/stremio-server-go), which has no
  authentication by design). Making an engine reachable from a network is a
  deployment error. Report engine vulnerabilities to the engine's project.
- **An exposed API listener without TLS.** `/v1` (port 8080 by default) must
  stay private or use TLS, since every request carries an API key. Multitap warns
  at startup when it listens on a non-loopback address over plain HTTP.
- **What addons serve.** The content an addon lists, and the public hosts its
  stream URLs point to, are the addon's. Multitap and the engine fetch public URLs
  by design.
- **Everything around Multitap:** reverse proxies, the host, Docker, and the
  operator's TLS certificates.
- **Denial of service that needs a valid API key**, and volumetric attacks.
- **Scanner output without a demonstrated impact.**
- **Apps built on Multitap.** Report problems in a client or app to its own
  project, unless the cause is in Multitap.

## Known weaknesses and limits

- Open findings from the October 2026 security review are listed in
  [ROADMAP.md](ROADMAP.md) under "Next". You don't need to
  report them again, unless you can show more impact than they describe.
- A media token is a bearer credential for one session until it expires or is
  revoked. Revoking the API key that minted it doesn't revoke it; revoke the
  token's subject, or all of the session's tokens, too.
