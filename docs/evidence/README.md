# Agent OS baseline snapshot — 2026-08-25

This branch preserves the local Picord source that existed before migration to Pi 0.84.3. It is evidence and rollback input, not a production release.

## Provenance

- Git base: upstream `v0.4.0` (`14589144110e76724745d391342a1716a05bcc45`)
- Published package: `@venthezone/picord@0.4.0`
- Preserved source: Agent OS `vendor/picord-fork`
- Additional manifests: active overlay and installed running `src`/`dist`

The original patch inventory is retained verbatim even though later image-input work made its 19+7 file count and five-file overlay statement stale. The audited count at capture time was 20 modified existing files and 8 added source/test files, plus the original inventory itself. The overlay contained 12 files and the running renderer had diverged from both the overlay and this baseline.

Each `*.sha256` file contains hashes relative to its captured root. `running-dist.sha256` is generated output and must be compared behaviorally. No credentials, config state, Discord tokens, sessions, or journals are included.
