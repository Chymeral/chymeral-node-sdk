# Chymeral Node SDK Technical Journal

This journal records the scope and decisions behind the first Node.js client
library for the public Chymeral Link Protocol (CLP). It complements the
product-facing [README](README.md) and the Chymeral host manual.

## Initial scope

The Node SDK is a separate repository and public scoped npm package. Its Git
repository is named `chymeral-node-sdk`; its npm identity is
`@chymeral/node-sdk`. It implements CLP v2.0 as an external client, so a Node.js
application remains an ordinary program launched by a Chymeral terminal. The
host does not embed Node.js, dynamically load this package, or grant it
privileged runtime behavior.

The initial implementation includes the full public scene and notification
surface already available in CLP v2.0:

- negotiated lifecycle, capabilities, subscriptions, and session data;
- scene node creation, atomic updates, hierarchy, root layers, and removal;
- session-owned RGBA8 and animated GIF images;
- intrinsic terminal-cell text and returned metrics;
- input, scene, timing, resize, delivery-gap, and close notifications;
- overlap queries/transitions, alpha contact, input passthrough, and incoming
  external-file-drop routing where the host backend grants it.

## Architectural decisions

### TypeScript source, JavaScript delivery

The SDK is written in strict TypeScript and emits ESM JavaScript plus
declarations. This gives JavaScript consumers a normal Node module while
providing TypeScript consumers strongly typed handles, discriminated events,
and command inputs. The source remains understandable without code generation
or a native binding.

### ESM and Node 22 baseline

The initial package is ESM-only and requires Node.js 22 or newer. That baseline
provides mature async iteration, modern type definitions, and stable built-in
local IPC without carrying dual-module wrapper complexity during the first
compatibility line.

### Built-in transport, zero runtime dependencies

The package uses `node:net` directly. Node maps a path to a Unix-domain socket
on Linux and to a named pipe on Windows, exactly matching Chymeral's local CLP
boundary. No browser transport, TCP listener, native addon, foreign-function
interface, or runtime npm package is needed.

### Camel case at the API boundary

Public methods and properties use idiomatic Node/TypeScript camelCase:
`createNode`, `setNode`, `isOverlapping`, `externalDropEnabled`, and so on.
The implementation alone translates them to the stable CLP snake_case wire
format. This keeps JavaScript code natural without changing the
language-neutral protocol vocabulary.

### Independent inbound pumping and ordered commands

The SDK pumps host messages as soon as the handshake completes, placing typed
notifications in an asynchronous queue. Outbound operations are serialized:
an `uploadImage` JSON command and its binary fragments cannot interleave with
another command. This preserves the CLP image transfer contract while allowing
events and timing to reach an application during long-running command flows.

### Observable pressure and bounded state

The notification queue is bounded. A client receives `delivery_gap` when
Chymeral coalesces continuous information; a local client that cannot keep up
fails explicitly rather than presenting a false lossless stream. Discrete
input and resize remain host-enforced delivery guarantees.

### Live and isolated validation

The repository has two complementary validation paths. The Node test suite
creates a small framed fake CLP host, checking lifecycle, invalid response
ordering, binary fragmentation, command serialization, notification decoding,
and clean closure without a graphical dependency.
`examples/clp-conformance.ts` runs against a real Chymeral window and verifies
host behavior including timing, resources, text metrics, alpha contact, GIF
mutation, overlap, and a session-only close. Its `--manual` mode mirrors the
visual interaction test used by the Rust reference SDK.

M22 adds a versioned, language-neutral CLP v2.0 fixture corpus in the host
repository. This package vendors the exact snapshot and SHA-256 manifest, then
replays every vector through its public asynchronous API and an independent
fake host in the Linux/Windows Node.js 22 and 24 matrix. It does not depend on
host code or network retrieval during CI.

M23–M24 add CLP v2.1 presentation and application window metadata without
weakening the ordered promise-based command path. The public TypeScript
metadata patch uses idiomatic optional properties: omission preserves a field
and `null` clears it. The one-time v2.0 retry removes both v2.1-only
capabilities, while the vendored v2.1 fixture replay verifies presentation and
title/icon metadata through the public API and an independent fake host.

## M25 release integration

The `1.5.0` package consolidates the M23 and M24 API as the stable Node.js and
TypeScript binding for CLP v2.1. It keeps the deliberate one-time v2.0 retry
without expanding a presentation packet into individual `setNode()` calls.
`npm run ci`, package dry-run inspection, and the Linux/Windows Node.js 22 and
24 matrix cover the built ESM package, fixture replay, type checks, and tests.
The vendored v2.1 fixture snapshot and SHA-256 manifest match the core and Rust
SDK snapshots byte for byte. Live presentation and metadata probes passed
against Chymeral `1.5.0` on Windows, Linux/X11, and native Wayland; the latter
correctly reports dynamic application icons unsupported while applying titles.

## Intentional boundaries

- This package is a CLP client, not a terminal, widget toolkit, graphics engine
  implementation, or a Node plugin for the Chymeral host.
- It provides no browser, Electron, TCP, WebSocket, or remote-network
  transport; CLP remains a local authenticated IPC protocol.
- It does not introduce widgets, physics, 3D, gamepad support, outgoing
  external drag-and-drop, or non-rectangular geometry beyond image alpha.
- It is the first Node binding, not a replacement for the Rust SDK or a source
  of special protocol authority.

Those limits keep the package a small, auditable reference for JavaScript and
TypeScript applications while CLP remains open to future language SDKs.

## Documentation and release boundary

The SDK documentation separates consumer integration, contributor expectations,
private security reporting, and npm publishing. The README is the public entry
point; `CONTRIBUTING.md` defines engineering expectations; `SECURITY.md`
defines the confidential reporting path; and `PUBLISHING.md` defines the
reproducible release path for `@chymeral/node-sdk`.

This separation avoids conflating a GitHub release with an npm installation
artifact. The repository and tag identify reviewed source and release notes,
while npm distributes the built ESM package. The Git repository name and npm
scope intentionally serve different roles: the repository remains
`chymeral-node-sdk`, while consumers install `@chymeral/node-sdk`.
