# Security Policy

## Supported versions

Only the latest release gets security fixes.

## Reporting a vulnerability

Please report a vulnerability privately:

1. **Do not open a public issue.**
2. Use GitHub's private vulnerability reporting on the repository's **Security** tab, or contact the maintainer directly.
3. Include:
   - what the problem is
   - the steps to reproduce it
   - what an attacker could do with it
   - a suggested fix, if you have one

Redact passwords, session cookies and host addresses from anything you send.

## What Keystone protects

Keystone is a read-only view of several Homebridge instances for a few trusted people. It signs in to each Homebridge UI with a non-admin user and never forwards a change to Homebridge. The Homebridge passwords stay on the server, in a secrets file that the server refuses to read if group or other users can access it.

The full security model is in [docs/architecture.md](docs/architecture.md#security-model). It covers sign-in, login throttling, sessions, the client address behind a proxy, the Content Security Policy and what the health check shows. The tests in `test/auth.test.ts` and `test/app.test.ts` pin the exact rules.

## How the repository is checked

- `npm audit` in CI for the runtime dependencies, and Dependency Review on each pull request
- Dependabot alerts and security updates, plus weekly version updates for npm packages and GitHub Actions
- CodeQL for the TypeScript code and the workflows
- Secret scanning with push protection
- GitHub Actions pinned to commit SHAs, with the least permissions that each workflow needs

## Advice for people running Keystone

1. Put Keystone behind a TLS proxy on the same host, as described in [docs/operations.md](docs/operations.md#put-nginx-in-front), and keep `listen.host` on loopback.
2. Do not expose Keystone to the internet.
3. Give each person their own user, and remove users who no longer need access.
4. Keep Node.js and Keystone up to date.
5. Never commit `config.json`, `secrets.json` or the `data` directory.

## Response timeline

- **Acknowledgment:** within 48 hours
- **First assessment:** within 1 week
- **Fix:** depends on severity
  - Critical: 24 to 48 hours
  - High: 1 week
  - Medium: 2 weeks
  - Low: the next release
