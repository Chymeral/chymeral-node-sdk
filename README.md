<p align="center">
  <a href="https://github.com/Chymeral/chymeral"><img src="https://raw.githubusercontent.com/Chymeral/chymeral/main/branding/chymeral_logo.svg" alt="Chymeral logo" width="160"></a>
</p>

# Chymeral Node SDK

<p align="center">
  <a href="https://github.com/Chymeral/chymeral-node-sdk/actions/workflows/ci.yml"><img src="https://github.com/Chymeral/chymeral-node-sdk/actions/workflows/ci.yml/badge.svg" alt="SDK quality checks"></a>
  <a href="https://www.npmjs.com/package/@chymeral/node-sdk"><img src="https://img.shields.io/npm/v/%40chymeral%2Fnode-sdk.svg" alt="npm version"></a>
  <a href="https://github.com/Chymeral/chymeral-node-sdk/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Chymeral/chymeral-node-sdk.svg?v=1.0.1" alt="MIT License"></a>
</p>

> Official Node.js and TypeScript client SDK for the Chymeral Link Protocol
> (CLP).

Chymeral Node SDK lets a normal Node.js application use the local graphics
runtime exposed by a running Chymeral terminal. It is an external client
library: it does not create a separate window, load into the host process, or
make JavaScript and TypeScript privileged languages in the Chymeral ecosystem.

The SDK presents idiomatic camelCase TypeScript APIs while serializing the
stable CLP wire vocabulary internally. It implements the public CLP v2.0
contract and has no runtime npm dependencies, native addons, or foreign-function
interface.

## At a glance

| Topic                | Current contract                                |
| -------------------- | ----------------------------------------------- |
| npm package          | `@chymeral/node-sdk`                            |
| Package line         | `1.x`, stable public API                        |
| Protocol             | CLP `v2.0`                                      |
| Runtime              | Node.js `22` or newer                           |
| Platforms            | Linux and Windows                               |
| Module format        | ESM only                                        |
| Runtime dependencies | None                                            |
| Connection           | Authenticated local IPC inherited from Chymeral |

This repository is the source of the first Node SDK. Its package version is
independent from both Chymeral and CLP versions: compatibility is negotiated at
connection time. The `1.x` line is the stable public API and deliberately
provides no provisional CLP v1.x aliases.

## What it provides

- A lifecycle-aware `Client` that connects through the private endpoint and
  token inherited from a Chymeral terminal.
- Typed commands for retained scene nodes, atomic mutation, image ownership,
  intrinsic text, overlap queries, alpha contact, input passthrough, and
  supported external-file-drop targets.
- Promise-based commands plus queue and async-iterator APIs for input, scene,
  timing, resize, delivery-pressure, and closing notifications.
- Session-owned RGBA8 and animated GIF uploads, including CLP binary-frame
  fragmentation and ordered command delivery.
- Opaque TypeScript `NodeHandle`, `ImageHandle`, and `SessionId` brands.
- A live conformance client and deterministic protocol tests that do not require
  a graphical window.

## Requirements

- Node.js `22` or newer.
- A Chymeral release that supports CLP v2.0.
- A program launched from the shell inside that Chymeral window, so it inherits
  `CHYMERAL_CLP_ENDPOINT` and `CHYMERAL_CLP_TOKEN`.

The SDK uses Node's built-in local IPC support: Unix-domain sockets on Linux
and named pipes on Windows. Starting from an ordinary terminal is valid Node.js
execution, but `Client.connectFromEnv()` correctly throws
`MissingEnvironmentError` because there is no Chymeral session to join.

The endpoint and token are per-session credentials. Treat them as private
process state: do not log, persist, forward, or expose them to child processes
that do not need CLP access.

## Installation

Install the published package from npm:

```text
npm install @chymeral/node-sdk
```

For development against a local SDK checkout:

```text
cd chymeral-node-sdk
npm ci
npm run build

cd ../your-application
npm install ../chymeral-node-sdk
```

The package is ESM-only:

```ts
import { Client } from "@chymeral/node-sdk";
```

Maintainers should follow [PUBLISHING.md](https://github.com/Chymeral/chymeral-node-sdk/blob/main/PUBLISHING.md)
rather than treating a GitHub release attachment as an npm distribution.

## Quick start

Run the following program from a Chymeral terminal. It creates a scene node in
front of the terminal grid, waits for `q`, and then closes only its own CLP
session.

```ts
import { Client, type Notification } from "@chymeral/node-sdk";

function isQuitKey(notification: Notification): boolean {
  return (
    notification.kind === "event" &&
    notification.event.kind === "key" &&
    notification.event.state === "pressed" &&
    notification.event.key.kind === "character" &&
    notification.event.key.value === "q"
  );
}

const client = await Client.connectFromEnv(["scene", "input"]);
await client.subscribe(["raw_input"]);

const { node } = await client.createNode(
  {
    kind: "rectangle",
    properties: { x: 32, y: 32, width: 180, height: 72 },
    color: [37, 99, 235, 230],
  },
  { layer: "overlay" },
);

try {
  for await (const notification of client.notifications()) {
    if (isQuitKey(notification)) {
      break;
    }
  }
} finally {
  await client.removeNode(node).catch(() => undefined);
  await client.close().catch(() => undefined);
}
```

`Client.connectFromEnv()` completes the lifecycle handshake before it
resolves:

```text
hello → init → init_complete → start → started
```

The immutable `client.session` value contains the negotiated protocol version,
session ID, granted capabilities, and launch context. `Client.connect()` is
available for controlled launchers and tests; ordinary applications should use
`connectFromEnv()`.

## Capabilities, subscriptions, and notifications

Request only the capabilities an application needs, then inspect the negotiated
result with `client.hasCapability()`.

| Capability      | Enables                                                         |
| --------------- | --------------------------------------------------------------- |
| `scene`         | Retained nodes, hierarchy, layers, and mutation                 |
| `images`        | Session-owned RGBA8 and GIF uploads                             |
| `input`         | Raw keyboard, pointer, scroll, focus, terminal, and scene input |
| `timing`        | `tick` and `frame` notifications                                |
| `overlap`       | Direct overlap queries and transition events                    |
| `external_drop` | Incoming desktop-file drops on supported backends               |
| `text`          | Intrinsic terminal-cell text nodes                              |

`subscribe()` accepts `raw_input`, `terminal`, and `timing`. Notifications
can be consumed with `nextNotification()`, `tryNextNotification()`, or the
`notifications()` async iterator. Use one consumer strategy per client:
concurrent consumers intentionally share the same arrival queue.

Continuous data can be coalesced under delivery pressure. A `delivery_gap`
notification identifies the affected categories so the application can rebuild
state derived from those streams. Commands remain serialized by the SDK so an
image upload cannot interleave with another command.

## Scene model

Every session owns an implicit retained scene in logical pixels. Root nodes use
the `underlay` layer behind the terminal grid or the `overlay` layer in
front of it. Child coordinates are local to their parent. Sibling `zIndex`
orders painting, and insertion order deterministically resolves ties.

`createNode()` creates a root or child; `setNode()` validates and applies an
atomic patch; `removeNode()` removes a node and all descendants.

| Node kind   | Purpose                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `empty`     | Geometry, hierarchy, clipping, overlap, and interaction without a visual |
| `rectangle` | Solid RGBA8 visual                                                       |
| `image`     | A session-owned RGBA8 image or animated GIF                              |
| `text`      | Intrinsic terminal-cell text with returned metrics                       |

`uploadImage()` accepts either RGBA8 pixels or encoded GIF bytes and returns
an opaque `ImageHandle`. Resources belong to the creating session and cannot
be shared across sessions. Remove unreferenced resources with `removeImage()`.

## Interaction, overlap, and external drops

A node can participate in interaction independently of its visual:

- `inputPassthrough: true` paints the node but skips it for pointer-derived
  and external-drop targeting. Its children remain independently interactive.
- Image nodes default to rectangular `contactShape`. Set
  `{ kind: "alpha", threshold: 1 }` to use uploaded alpha. A threshold of
  `1` makes every non-transparent pixel interactive.
- The chosen contact shape is shared by pointer routing, drag/drop targets,
  external-file drops, direct overlap queries, and overlap transitions.
- Set `overlapEnabled: true` on nodes that should participate in overlap
  detection. Use `isOverlapping()`, `getOverlaps()`,
  `overlap_enter`, and `overlap_leave`.
- Set `externalDropEnabled: true` only after
  `client.hasCapability("external_drop")` confirms that the host granted it.

Incoming external file drops are available on Windows and X11/XWayland. Native
Wayland may omit `external_drop` from the granted capabilities; applications
must keep a useful pointer/keyboard path when that happens.

Scene events cover pointer enter, leave, move, press, release, focus,
in-scene drag/drop, overlap transitions, and supported external drops. Raw
input additionally exposes keyboard, pointer, scroll, focus, terminal, and
custom events.

## Intrinsic scene text

Request `scene` and `text`, then create a text node:

```ts
const label = await client.createNode(
  {
    kind: "text",
    properties: { x: 48, y: 64 },
    text: "Status:\tready\n界",
    style: { weight: "bold", color: [220, 230, 255, 255] },
  },
  { layer: "overlay" },
);

console.log(label.textMetrics);
```

The text origin is the top-left corner of its first cell. Chymeral computes the
node rectangle from the widest explicit line and row count using current
terminal-cell metrics. Text accepts printable Unicode, `\n`, and tabs at local
eight-cell stops. It does not wrap or ellipsize. Empty text is `0 × 0`, and a
trailing newline creates an extra blank row.

Omitted style fields inherit the terminal font, size, line height, and
foreground color. A custom `font` is an alias from `scene_text.fonts` in
`chymeral.toml`; it is not a host-system font-family lookup.

## Errors and closure

The SDK uses typed errors for expected integration failures:

| Error                                    | Meaning                                                   |
| ---------------------------------------- | --------------------------------------------------------- |
| `MissingEnvironmentError`                | The program lacks inherited CLP credentials               |
| `CapabilityNotGrantedError`              | An operation requires a capability the host did not grant |
| `InvalidInputError`                      | A public API argument is malformed before transport       |
| `CommandError` or `HostError`            | Chymeral rejected a command or lifecycle message          |
| `ProtocolError`                          | The peer violated the negotiated CLP contract             |
| `TransportError` or `SessionClosedError` | The local connection or session is no longer usable       |

`close()` and `reportFault()` terminate only the CLP program session. They
never close the surrounding terminal window or alter its stdin, stdout, or
stderr.

## Validation

Run repository checks:

```text
npm ci
npm run ci
npm pack --dry-run
```

The conformance client needs an active Chymeral terminal session:

```text
npm run example:conformance
npm run example:conformance -- --manual
```

The default run verifies lifecycle, subscriptions, timing, RGBA8/GIF image
upload/removal, text metrics, alpha contact, overlap, and session-only closure.
The manual mode additionally presents a layered scene for pointer, alpha,
passthrough, GIF, and external-drop checks.

The host repository maintains a versioned,
language-neutral [CLP v2.0 fixture corpus](https://github.com/Chymeral/chymeral/tree/main/protocol/fixtures/v2.0).
This package vendors its exact snapshot in `fixtures/clp/v2.0`, including
`SHA256SUMS`. Its corpus test verifies that checksum and replays every vector
through the public client and an independent fake host. Update both files only
from a reviewed core revision. The corpus complements, rather than replaces,
this package's focused fake-host tests and live conformance executable.

GitHub Actions runs the repository quality checks on Linux and Windows with
Node.js 22 and 24; `npm run ci` includes the vendored corpus replay.

## Documentation and governance

- [Contributing guide](https://github.com/Chymeral/chymeral-node-sdk/blob/main/CONTRIBUTING.md)
  — development, compatibility, review, and validation expectations.
- [Publishing guide](https://github.com/Chymeral/chymeral-node-sdk/blob/main/PUBLISHING.md)
  — reproducible npm release procedure for this package name.
- [Security policy](https://github.com/Chymeral/chymeral-node-sdk/blob/main/SECURITY.md)
  — private vulnerability-reporting process and scope.
- [Technical journal](https://github.com/Chymeral/chymeral-node-sdk/blob/main/Technical_Journal.md)
  — architectural decisions behind the SDK.
- [Chymeral manual](https://github.com/Chymeral/chymeral/blob/main/Main_Manual.md)
  — host configuration, terminal behavior, and runtime semantics.
- [CLP v2.0 fixture corpus](https://github.com/Chymeral/chymeral/tree/main/protocol/fixtures/v2.0)
  — portable, language-neutral frame vectors for SDK conformance work.
- [Chymeral Rust SDK](https://github.com/Chymeral/chymeral-rust-sdk) — the
  separate Rust reference and conformance client, published on
  [crates.io](https://crates.io/crates/chymeral-rust-sdk).
- [Changelog](https://github.com/Chymeral/chymeral-node-sdk/blob/main/CHANGELOG.md)
  — user-visible package history.

CLP is language-neutral. This SDK and the separate Rust SDK are client
implementations, not protocol forks or requirements for applications written
in another language.

## License

This repository is distributed under the [MIT License](https://github.com/Chymeral/chymeral-node-sdk/blob/main/LICENSE).
