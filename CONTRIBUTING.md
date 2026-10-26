# Contributing to Chymeral Node SDK

Thank you for helping improve the official Node.js and TypeScript client for the
Chymeral Link Protocol (CLP).

This repository must remain a small, independently auditable CLP client. A
Node.js application using it is an ordinary program launched by Chymeral; the
host neither embeds Node.js nor loads this package as a plugin.

## Development setup

Use Node.js `22` or newer. From the repository root:

```text
npm ci
npm run ci
npm pack --dry-run
```

`npm run ci` performs strict TypeScript checking, deterministic protocol
tests, an ESM declaration build, and Prettier validation. `npm pack --dry-run`
checks the artifact that npm would publish without creating an archive.

Do not commit `node_modules`, `dist`, personal Chymeral configuration,
screenshots, or generated package archives. Add a narrowly scoped fixture only
when it is essential to reproduce a protocol behavior.

## Test at the right level

The test suite uses a framed fake CLP host, so it validates lifecycle ordering,
message parsing, binary fragmentation, command serialization, notification
decoding, and closure without a graphics window:

```text
npm test
```

For a live host check, start Chymeral, open its terminal, and run:

```text
npm run example:conformance
npm run example:conformance -- --manual
npm run example:presentation
npm run example:scene-batch
npm run example:window-metadata
```

The manual scenario is the required visual check for a change that affects
scene rendering, text, alpha contact, GIF animation, input passthrough,
overlap, or external drops. Validate affected behavior on Linux and Windows
when the change crosses an OS or backend boundary.

The presentation probe is required for a frame-presentation change. Click its
panel to focus the session, exercise pointer movement, scroll,
resize, and the `b` burst, then compare its summary with an optional
`CHYMERAL_PRESENTATION_TRACE=1` host trace. Do not describe either value as
physical input-to-photon latency.

The window-metadata probe is required for a title/icon change. Confirm
title-only preservation, explicit clearing, session-only closure, and the
backend's reported icon-support state on every affected platform.

The conformance client and scene-batch visual probe are required for a CLP
v2.4 scene-batch change. Use the conformance client to verify surviving aliases
and the absence of a temporary removed alias. Use `example:scene-batch` to
confirm its complete panel appears without visible progressive assembly and
that `q` closes only the session, not the terminal.

## Public API and protocol compatibility

Published `1.7.x` is a typed asynchronous binding for CLP v2.4 with capability
negotiation and a one-time compatibility retry for an earlier compatible host.
A change to a
public export, type, serialization rule, lifecycle behavior, error, Node.js
baseline, or supported platform must include:

1. Focused automated tests.
2. A README or reference-documentation update when users can observe it.
3. A `CHANGELOG.md` entry when it changes public behavior.
4. A live conformance update when it changes the host-facing contract.

For a CLP v2.4 change, update the reviewed
[v2.4 fixture corpus](https://github.com/Chymeral/chymeral/tree/main/protocol/fixtures/v2.4)
and its vendored `fixtures/clp/v2.4` snapshot together. Check both hashes, keep
the complete compatibility regression replay, and add a public `SceneBatch`
conformance case when the feature changes batch behavior. Do not add a network
download or a dependency on the Chymeral host to this package's ordinary CI.

CLP is language-neutral. Do not add Node-only wire behavior, host internals as
a dependency, silent compatibility aliases, or APIs that cannot be represented
by another conforming client. Coordinate a proposed wire-contract change with
the [Chymeral core repository](https://github.com/Chymeral/chymeral) before
implementation.

Preserve the host's ownership and capability boundaries. In particular, never
turn opaque node, image, or session handles into globally reusable strings and
never assume that an optional capability was granted.

## Code and documentation standards

- Keep the implementation ESM-first, strict TypeScript, and free of runtime
  npm dependencies unless a protocol requirement makes one necessary.
- Prefer explicit validation and typed errors at the public boundary.
- Keep commands serialized and inbound notifications independently pumped.
- Use the existing naming convention: idiomatic camelCase APIs and stable
  snake_case only on the CLP wire.
- Run `npm run format:write` only when formatting needs to be updated, then
  rerun `npm run ci`.
- Keep examples copyable and identify whether they require a live Chymeral
  terminal.

## Pull requests

Keep each pull request focused. Describe the user-visible behavior, protocol
or compatibility implications, tests run, and platforms exercised. Include a
minimal reproduction for an interoperability defect and avoid unrelated
refactors in a protocol fix.

Security issues must not be filed as public issues or pull requests. Follow
[SECURITY.md](SECURITY.md) instead.

## Releases

Only a maintainer should publish a package. The complete, current release
procedure is in [PUBLISHING.md](PUBLISHING.md). It covers artifact inspection,
npm authentication, the public scoped `@chymeral/node-sdk` command, and
post-publication verification.
