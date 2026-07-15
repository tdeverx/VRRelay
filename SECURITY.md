# Security policy

## Supported versions

VRRelay has not published a stable release yet. Security fixes are made on the default branch and will be included in the next release candidate. After v1, this table will identify supported release lines.

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities, exposed credentials, authentication bypasses, SSRF, command injection, certificate problems, or playback-grant leaks.

Use GitHub's **Security → Report a vulnerability** flow to create a private security advisory. Include:

- Affected commit or version.
- Deployment mode and node roles.
- Reproduction steps or a minimal proof of concept.
- Expected and observed behavior.
- Potential impact and any known mitigations.
- Whether credentials or real media were involved.

Do not include reusable secrets. Revoke any credential exposed during testing.

Maintainers will acknowledge a complete report as soon as practical, validate impact, coordinate a fix and disclosure, and credit reporters who want attribution. Please allow a reasonable remediation window before public disclosure.

## Security scope

High-value boundaries include dashboard authentication, personal tokens, playback grants, Jellyfin/provider tokens, node enrollment and mTLS, object-store grants, ingest authentication, URL validation, FFmpeg argument construction, log redaction, and package/update integrity. The detailed model is in [docs/architecture/security.md](docs/architecture/security.md).
