# Changelog

All notable user-visible changes to the Chymeral Node SDK are recorded here.
The package follows [Semantic Versioning](https://semver.org/); Chymeral and
CLP have independent version lines.

The current release is `1.7.1` with CLP v2.4. Earlier headings are retained as
a chronological archive and do not describe the current public contract.

## [Unreleased]

## [1.7.1] - 2026-10-26

### Added

- CLP v2.4 `scene_batch`, the typed `SceneBatch` builder, batch-local aliases,
  operation/result types, and `Client.applySceneBatch()`.
- Byte-checked v2.4 fixture replay and live conformance coverage for atomic
  create/update/remove batches, returned surviving handles, and temporary
  aliases removed before commit.

### Changed

- Connection now requests CLP v2.4. The v2.0 retry removes `scene_batch`
  together with the earlier v2.1-only capabilities; unavailable batches are
  never silently expanded into sequential node commands.
- Live probes now report the CLP version negotiated with their host instead of
  a stale feature-era version label.

### Compatibility

- Version `1.7.1` implements CLP v2.4 and retains the existing v2.0 fallback.
  The earlier `1.5.x` line implements CLP v2.1.

## [1.5.0] - 2026-10-22

### Added

- CLP v2.1 support for the `presentation` capability,
  `presentScene()`, `presentSceneWithId()`, presentation value types, and
  `presentation_status` notifications.
- A live `example:presentation` probe for pointer, scroll, resize, and
  coalescible 60 Hz parent/control presentation traffic.
- Byte-checked CLP v2.1 fixture replay for accepted and rejected packets.
- CLP v2.1 support for the `window_metadata` capability,
  `setWindowMetadata()`, `WindowMetadataPatch`, `WindowMetadataStatus`, and
  `WindowMetadataSupport`.
- Byte-checked v2.1 replay for title/icon metadata, field preservation, and
  explicit clearing.

### Changed

- `Client.connect()` retries once against a v2.0-only host without
  `presentation` or `window_metadata`; presentation packets never silently
  become `setNode()` calls.

### Compatibility

- Package `1.5.0` implements CLP v2.1 and retains one-time v2.0 fallback. The
  earlier `1.0.x` line implements CLP v2.0. The future breaking `2.0.0` line is
  reserved for the separately validated M26 platform expansion.

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
