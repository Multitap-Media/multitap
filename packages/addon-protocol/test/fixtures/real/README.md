# Captured addon responses

Real responses captured on 2026-09-27 from Cinemeta, the YouTube channels addon,
public Torrentio, a Torrentio + Real-Debrid configuration and Easynews++.

Redacted before commit:
- every stream `url` / `externalUrl` is replaced with `https://example.invalid/redacted/<n>`
- `proxyHeaders` values are replaced
- credential strings (debrid key, usenet account, private addon host) are replaced with `REDACTED`
- Easynews++'s internal `_temp` blobs are removed
- public Torrentio responses are trimmed to 20 streams each

Never add a fixture that contains a real stream URL, manifest URL with configuration, key, username or password.
