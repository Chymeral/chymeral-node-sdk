# Publishing Chymeral Node SDK

This guide defines the release procedure for the public scoped npm package,
`@chymeral/node-sdk`. It is written for repository maintainers and complements
the consumer-facing [README](README.md).

A package publication is a public compatibility statement. The package version,
`CHANGELOG.md` entry, Git tag, GitHub release, npm metadata, and source
revision must all describe the same SDK contract.

## Before a release

Start from the intended `main` revision with no generated or unrelated changes:

```text
git status --short
git log -1 --oneline
npm ci
npm run ci
npm pack --dry-run
```

Review the dry-run file list. The archive should contain the built `dist`
output and the files declared in `package.json`, not `node_modules`,
personal configuration, test fixtures, local archives, or source-only
development artifacts.

Before publishing, ensure all of the following are true:

1. `package.json` and `package-lock.json` carry the chosen package version.
2. `CHANGELOG.md` describes the public changes and compatibility impact.
3. The source revision has passed the full local CI and appropriate live
   Chymeral validation on Linux and Windows.
4. A maintainer has reviewed the npm package name, repository URL, license,
   exports, Node.js engine range, and tarball contents.
5. The Git commit and release tag are ready to identify exactly what was
   published.

Do not publish an uncommitted working tree, a version that has not passed
`npm pack --dry-run`, or a build whose public documentation disagrees with its
exports.

## Authenticate deliberately

Use an npm account that belongs to the `@chymeral` organization and has
permission to publish this package. Verify the active identity before every
release:

```text
npm login
npm whoami
```

Enable the strongest account protections available to the publishing account.
Never place an npm token in source control, documentation examples, issue
attachments, or CI logs.

## Publish the current package

The current package is public and scoped, so publish it with:

```text
npm publish --access public
```

The `prepublishOnly` lifecycle hook runs `npm run ci` before npm uploads the
tarball. Treat a failed hook as a release failure; fix the cause and repeat the
full preflight rather than bypassing it.

Do not use force publication. A published version should be treated as
immutable. Correct a package defect with a new SemVer release or deprecate the
affected version according to the npm policy in effect at that time.

## Verify the public result

After npm reports success, check the public metadata and install the exact
published version into a clean temporary project:

```text
npm view @chymeral/node-sdk version dist-tags --json

mkdir chymeral-node-sdk-smoke
cd chymeral-node-sdk-smoke
npm init -y
npm install @chymeral/node-sdk@<published-version>
node --input-type=module --eval 'import("@chymeral/node-sdk").then(({ Client }) => console.log(typeof Client))'
```

The final command must print `function`. Follow it with the live conformance
client from a Chymeral terminal when validating a release candidate or a
substantive transport/API change.

Then create the matching Git tag and GitHub release. The GitHub release is a
source and release-notes record; npm is the installation channel for this SDK.
Do not upload a manually built SDK archive as the primary Node.js distribution.

## Package identity

The Git repository remains `Chymeral/chymeral-node-sdk`; no GitHub repository
rename is required for this npm scope. The two names intentionally serve
different audiences:

- GitHub uses `chymeral-node-sdk` as the discoverable source repository.
- npm uses `@chymeral/node-sdk` as the installation and import identity.

Keep the package name, README badges and examples, lockfile, release notes,
and npm commands aligned whenever the package identity changes. A future name
migration is a versioned compatibility and distribution decision, not an
alternate install instruction.

## References

- [npm publish documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish)
- [npm package publishing overview](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm organization scopes and packages](https://docs.npmjs.com/about-organization-scopes-and-packages/)
