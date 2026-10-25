# Security policy

Lists is built to keep shared lists private. Security reports are very welcome.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
go to the repository's **Security** tab and choose **Report a vulnerability**.

Please include:

- what an attacker can do, and under which assumptions (see
  [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)),
- steps to reproduce, or a proof of concept,
- the affected version or commit.

You can expect an acknowledgement within 7 days. We will keep you informed while we
work on a fix, and credit you in the advisory unless you prefer otherwise.

## Scope

In scope:

- anything that lets someone without the link read or change a list,
- anything that lets a read-only link write _(once read-only links exist)_,
- leaks of keys or content to relays, the static host or third parties,
- XSS, CSP bypasses, or injection through list content,
- weaknesses in the cryptographic design described in
  [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

Out of scope, documented as known limitations:

- relays seeing IP addresses and activity timing,
- anyone holding a valid link having full access,
- attacks that require an unlocked device or a malicious browser extension.

## Supported versions

The project is pre-1.0. Only the latest commit on `main` (the deployed version)
receives security fixes.
