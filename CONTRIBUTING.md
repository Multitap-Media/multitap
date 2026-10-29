# Contributing

Thanks for helping. This file covers licensing and sign-off. How to build and
check your change is in [AGENTS.md](AGENTS.md) (it applies to people too): in
short, `pnpm install`, then `pnpm run ci` before you send a change that touches
code, and `pnpm run docs:check` for docs.

## Licences

| Part | Licence |
|---|---|
| Multitap: `packages/core` and its container image | [AGPL-3.0-only](packages/core/LICENSE) |
| Multitap's client packages: `@multitap/api` in `packages/api` (schemas, OpenAPI document, typed client) and `@multitap/addon-protocol` in `packages/addon-protocol` (addon protocol types and client) | [MIT](packages/api/LICENSE) |
| Everything else in this repository (scripts, docs, the knowledge bundle) | [AGPL-3.0-only](LICENSE) |

Multitap is AGPL so that it stays open: anyone may run, change and share it, and
anyone who runs a changed Multitap for other people over a network must offer
those people the source of their version. The client packages are MIT so that
apps and players built on Multitap's API can use any licence.

Your contribution is licensed under the licence of the part it changes, the
same terms everyone else receives. There is no contributor licence agreement:
you keep the copyright on your work, and no one can relicense the project
without its contributors.

## Sign your commits (DCO)

Every commit in a pull request needs a `Signed-off-by` line. With it you
certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the change, or otherwise have the right to submit it under the
licence above.

```bash
git commit -s -m "fix(core): …"   # adds: Signed-off-by: Your Name <you@example.org>
```

Use your real name or a name you are known by consistently, and an email you
can be reached at. To sign commits you already made, run
`git rebase --signoff main` and force-push your branch.
