# Changelog

All notable user-visible changes to the Chymeral Node SDK are recorded here.
The package follows [Semantic Versioning](https://semver.org/); Chymeral and
CLP have independent version lines.

## [Unreleased]

### Added

- Development CLP v2.1 support for the `presentation` capability,
  `presentScene()`, `presentSceneWithId()`, presentation value types, and
  `presentation_status` notifications.
- A live `example:presentation` probe for pointer, scroll, resize, and
  coalescible 60 Hz parent/control presentation traffic.
- Byte-checked CLP v2.1 fixture replay for accepted and rejected packets.

### Changed

- `Client.connect()` retries once against a v2.0-only host without
  `presentation`; presentation packets never silently become `setNode()`
  calls.

### Compatibility

- These unreleased APIs target package `2.0.0`. Published `1.0.x` remains the
  stable CLP v2.0 package line.

## [1.0.1] - 2026-10-19

### Fixed

- Replaced relative license links in the packaged README with the canonical
  GitHub license URL, so the link works from npm as well as from the source
  repository.

## [1.0.0] - 2026-10-19

### Added

- The initial stable asynchronous Node.js and TypeScript binding for the
  public CLP v2.0 lifecycle, capabilities, subscriptions, notifications, and
  close model.
- Typed scene operations for nodes, atomic mutation, hierarchy, RGBA8/GIF
  images, intrinsic text, overlap queries, alpha image contact, input
  passthrough, and supported incoming external-file-drop events.
- Built-in local IPC for Unix-domain sockets on Linux and named pipes on
  Windows, with no runtime npm dependencies or native addons.
- A `clp-conformance` executable for live Chymeral validation and protocol
  tests covering framing, fragmented input, commands, binary uploads, events,
  and clean closure.

### Changed

- Adopted `@chymeral/node-sdk` as the public npm identity while preserving
  the `chymeral-node-sdk` Git repository name.
- Reorganized the public README around installation, lifecycle, capabilities,
  scene semantics, validation, and typed errors.
- Added dedicated contributor, security, and npm publishing guidance for the
  stable public package.

### Compatibility

- `1.x` supports CLP v2.0 only. It deliberately omits provisional CLP v1.x
  commands and aliases.
- The package is ESM-only and requires Node.js 22 or newer.
