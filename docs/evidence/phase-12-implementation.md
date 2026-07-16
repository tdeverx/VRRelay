# Phase 12 implementation checkpoint — publication metadata guardrails

Date: 2026-07-15

This is a source-tree publication-readiness checkpoint. It is not evidence that
the public remote exists, repository settings are enabled, branch protection is
configured, release credentials are present, or a public release candidate has
passed.

## Scope completed

- `script/check-repository.mjs` now guards the community and publication files
  required before opening the repository:
  - code of conduct, contributing guide, governance, support, security policy,
    license, third-party notices, public release checklist, pull request
    template, issue templates, and Dependabot config.
  - the security policy must direct vulnerability reports to GitHub private
    vulnerability reporting and warn against public issues for sensitive reports.
  - the bug template must warn reporters not to include credentials and must
    distinguish ordinary bugs from security reports.
  - the public release checklist must keep secret scanning, push protection,
    Dependabot alerts, private vulnerability reporting, code scanning, branch
    protection, and tag/release restriction gates.
  - Dependabot must cover npm, GitHub Actions, and Docker manifests.
- These assertions run through `npm run check` and therefore through `npm run ci`.

## Lean guardrails run

Commands:

```text
npm run check:repo
```

Result: the repository metadata guard passed and confirmed the publication
checklist and security-reporting prompts are present.

## Deferred to final high-pass verification

- Create the public remote only after the release-candidate gate.
- Enable GitHub secret scanning, push protection, Dependabot alerts, private
  vulnerability reporting, code scanning, protected `main`, required reviews,
  required checks, and release/tag restrictions on the actual repository.
- Run the full clean-clone release suite, resolve security findings, create the
  release candidate, install final artifacts, and complete real VRChat evidence.
