# Customer Distribution Readiness

**Status:** In progress

**Reviewed:** 2026-09-27

## Decision

Do not share the current repository or change its visibility as-is.

Keep the existing `heshaojian/pixverse-api-kit` repository private as the internal development and GTM workspace. Create a separate customer distribution repository or package from a sanitized tree with fresh Git history.

The customer distribution should preserve the current product architecture:

```text
pixverse-api
├── platform
└── growth-studio
```

The general web-product CLI remains the separate `pixverse` executable. Platform and Growth Studio continue to use independent credentials, billing boundaries, configuration, and durable job artifacts.

## Why the current repository must remain internal

Customer pitch pages, tracked payloads, production evidence, QA tools, and pitch tests were separated into the private `heshaojian/pixverse-pitch-studio` repository and removed from the current API Kit tree on 2026-09-27. Historical customer and internal material still exists in this repository's Git history, and internal plans remain in the working tree. A customer repository must therefore still start with fresh history rather than as a branch or ordinary clone of this repository.

The npm package now has a strict `files` allowlist for CLI, API docs, packaging helpers, and customer-plugin sources only. Treat that allowlist as a guardrail, not a distribution approval: customer releases still need to be built from a clean, reviewed tree with fresh history.

## Intended customer distribution

The sanitized repository or package should contain only:

```text
src/
test/                    # API and CLI tests only
examples/                # neutral, runnable payloads
docs/api/
skills/                  # optional sanitized customer-facing skills
.github/
.env.example
README.md
LICENSE
NOTICE
SECURITY.md
SUPPORT.md
CHANGELOG.md
package.json
package-lock.json
```

The following internal surfaces must not be included:

```text
deploy/brand-pitches/
docs/brand-pitches/
docs/superpowers/
payloads/
pixverse-cli-jobs/
qa/
test/brand-pitch*
test/plaud-*
test/revolve-*
```

Customer-facing skills must also remove personal names, customer names, internal checkout assumptions, and references to internal pitch deployments.

## P0: Required before any customer receives access

- [ ] Create a new customer distribution repository from a sanitized export with fresh Git history.
- [ ] Keep the current internal repository private.
- [x] Remove tracked customer-specific pitch, payload, job-record, QA, and pitch-test surfaces from the current API Kit tree.
- [ ] Run a full-history Gitleaks or TruffleHog scan on the new repository.
- [ ] Run the tracked-file secret scanner and dependency audit on the exact release tree.
- [ ] Decide whether distribution is proprietary customer-use, source-available, or open source.
- [ ] Add approved `LICENSE`, `NOTICE`, `SECURITY.md`, and `SUPPORT.md` files.
- [ ] Clarify whether Growth Studio is available to every recipient or only entitled accounts.
- [x] Add a strict npm `files` allowlist or build a separate curated distribution directory.
- [x] Verify that the current internal npm package dry run contains no internal or customer-specific paths.
- [ ] Verify that the exact customer release artifact contains no internal or customer-specific paths.

## P1: Customer installation and onboarding

- [ ] Select the installation channel.
  - Preferred: private package such as `@pixverse/api-cli`, retaining the `pixverse-api` executable.
  - Alternative: versioned GitHub Release containing a curated `.tgz` plus SHA-256 checksum.
- [ ] Replace clone-and-`npm link` onboarding with package or release installation instructions.
- [ ] Document supported operating systems and Node.js LTS versions.
- [ ] Explain how customers obtain Platform and Growth Studio credentials.
- [ ] Provide a first read-only command and a first `--dry-run` workflow.
- [ ] Label every billable example clearly.
- [ ] Document timeout, reconciliation, and `resume` recovery.
- [ ] Document which redacted diagnostic artifacts are safe to send to support.
- [ ] Add neutral runnable examples using `example.com`, placeholder IDs, and generic products.
- [ ] Move the complete public operation catalog into `docs/api/`; customer docs must not depend on internal agent instructions.

Suggested neutral examples:

```text
examples/platform/text-to-video.json
examples/platform/image-to-video.json
examples/platform/template-video.json
examples/growth-studio/product-url.json
examples/growth-studio/product-images.json
examples/README.md
```

## P1: Stable CLI contract

- [ ] Implement and test `pixverse-api --version`.
- [ ] Document exit codes and stdout-versus-stderr behavior.
- [ ] Define which JSON output fields are stable public contract.
- [ ] Provide command- or operation-level help for customer workflows.
- [ ] Publish an explicit compatibility and deprecation policy.
- [ ] Preserve exact-string API identifiers and provider credential isolation.
- [ ] Preserve durable single-submit job execution and poll-only resume behavior.

## P2: Release governance

- [ ] Add `CHANGELOG.md`.
- [ ] Add API versioning and compatibility documentation.
- [ ] Add `.github/CODEOWNERS`.
- [ ] Add a release workflow that produces immutable artifacts and checksums.
- [ ] Test the packed artifact in a clean temporary environment.
- [ ] Verify top-level and provider help from the installed artifact.
- [ ] Verify dry runs and mocked read-only calls from the installed artifact.
- [ ] Generate release notes and document rollback procedures.
- [ ] Configure dependency update automation.
- [ ] Tag every customer release.

## Versioning recommendation

The current `0.3.0-beta.4` version should remain an internal/private beta version until the customer distribution repository and release gates are complete.

Promote to `1.0.0` only after stabilizing:

- command names and namespaces;
- configuration variables;
- JSON output and exit codes;
- durable artifact formats;
- compatibility and deprecation commitments.

## Release gates

Before granting customer access, all of the following must pass against the exact distributed artifact:

- no internal/customer paths in the package manifest;
- full-history and tracked-file secret scans;
- dependency audit with no unresolved high-severity vulnerability;
- clean install from the chosen distribution channel;
- `pixverse-api --version` and help smoke tests;
- guarded API test suite with no paid network access;
- dry-run tests for representative Platform operations;
- mocked Growth Studio creation and recovery tests;
- legal, security, and support review;
- explicit approval to invite the named customer.

## Recommended rollout

1. Keep this repository private.
2. Build a clean customer distribution repository and package.
3. Release a private beta to one design partner.
4. Collect installation, compatibility, and support feedback.
5. Stabilize the contract before wider customer distribution.
