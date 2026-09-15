# CLAUDE.md

This repository contains the ambient channel, wire protocol, and cerebellum service.

## Workspace

- Use `pnpm` for installs and scripts.
- The workspace requires Node.js 20 or newer.
- `packages/ambient-protocol` owns the edge, channel, and cerebellum wire contract.
- `packages/channel-ambient` owns the daemon-facing channel and capture web app.
- `packages/cerebellum` owns perception, judgment, and speech.
- `services/` holds the cerebellum's own control script and reference deployments of the upstream
  services it calls. The upstream contracts live in `docs/service-contracts.md`; the reference
  deployments are examples, not requirements.

## Verification

Run the relevant checks before committing:

```sh
pnpm install --frozen-lockfile
pnpm run lint:types
pnpm test
pnpm run build
pnpm run lint
pnpm run format:check
```

The channel build entry point is `pnpm --filter @openduo/channel-ambient run build:plugin`.
Do not replace it with a typecheck when validating the packaged channel.

A husky pre-commit hook runs lint-staged: eslint with zero warnings, prettier, and the license
header check on staged files. Do not bypass it with `--no-verify`.

Every `ts`, `js`, `mjs`, `sh`, `py` and `css` file starts with the two-line SPDX header, after the
shebang when there is one. `packages/ambient-protocol` is `Apache-2.0`; everything else is
`FSL-1.1-Apache-2.0`. `pnpm run license:fix` adds a missing header; `pnpm run lint` rejects it.

## Boundaries

Keep the ambient wire contract independent of daemon implementation details.
The channel may depend on the published daemon protocol package, but the protocol package must not
import private daemon source or local workspace paths.
Keep credentials, room records, audio, local environment files, and deployment handoffs out of
commits. Model weights pulled by `services/*/install.sh` stay out too; the SHA-locked Silero
artifact under `packages/cerebellum/artifacts/` is source and is tracked.

## Changes

Read the assembled prompt or runtime contract in full before changing it.
Preserve existing protocol behavior unless the change explicitly updates the contract and its tests.
Do not add inference limits, retries, or other runtime constants without documenting their reason.
Write source comments and commit messages in English; user-facing Chinese and model prompt text may
remain Chinese when that is their content.

## Release hygiene

Review the staged tree for private paths, hostnames, credentials, experiment output, and internal
repository references before creating a release or publishing an artifact.
Deployment and publication require explicit review of the target environment.
