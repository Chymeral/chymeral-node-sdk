# Security Policy

## Supported versions

| Version line     | Supported |
| ---------------- | --------- |
| `1.5.x`          | Yes       |
| `1.0.x`          | No        |
| Earlier versions | No        |

Security fixes are released in the current supported line. The Chymeral host
and its SDKs have independent release versions, so include both versions in a
report whenever possible.

## Scope

This policy covers the Chymeral Node SDK's:

- CLP framing, parsing, and local IPC lifecycle;
- authentication-token handling and connection setup;
- public input validation, resource transfer, and notification handling;
- conformance executable and package-distribution configuration.

A vulnerability in the Chymeral host itself belongs to the
[core repository's security process](https://github.com/Chymeral/chymeral/security/advisories/new).
A third-party npm, Node.js, operating-system, compositor, or terminal issue
should also be reported to its responsible project when appropriate.

## Report privately

Do not disclose a suspected vulnerability through a public issue, discussion,
pull request, release comment, or social-media post.

Use the GitHub private reporting form for this repository:

<https://github.com/Chymeral/chymeral-node-sdk/security/advisories/new>

If GitHub private reporting is unavailable, contact a repository owner
privately through GitHub. Include enough information to reproduce and assess
the issue:

- affected SDK, Chymeral, Node.js, and operating-system versions;
- a minimal reproduction and expected versus observed behavior;
- security impact, attack prerequisites, and relevant logs;
- a suggested mitigation if one is known.

Never include a live `CHYMERAL_CLP_ENDPOINT`, `CHYMERAL_CLP_TOKEN`, npm
access token, private file path, or other credential in the report. Redact
sensitive data before attaching logs or screenshots.

## Coordinated handling

Maintainers will reproduce the issue, determine its scope, prepare a fix and
tests, and coordinate disclosure with the reporter. Please allow time for a
patched release before publishing technical details. Acknowledgment preferences
may be included in the report.
