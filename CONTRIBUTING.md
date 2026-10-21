# Contributing to Keystone

Thanks for contributing. This guide covers bug reports, feature requests, local setup and pull requests.

Please read and follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## How to contribute

### Reporting bugs

1. Check the repository's [issues](../../issues) for an existing report.
2. Open a new issue with the **Bug Report** template. Include:
   - the Keystone version, or the commit if you run from `main`
   - your OS, Node.js version and Homebridge UI version
   - the steps to reproduce, and what you expected to happen
   - the relevant lines from the Keystone log, with passwords, cookies and addresses removed

### Suggesting features

1. Check the existing issues first.
2. Open a **Feature Request** that describes the problem, the change you propose and who would use it.

Keystone stays read-only toward Homebridge. A feature that would change anything in Homebridge is out of scope.

### Pull requests

1. Create a branch, for example `git checkout -b feature/short-description`.
2. Keep the change focused, and add tests for new behavior.
3. Run the checks below.
4. Open the pull request with a [Conventional Commits](https://www.conventionalcommits.org) title.

#### Commit and pull request titles

Commit subjects and pull request titles drive automated releases through [release-please](RELEASING.md):

| Prefix | Use for | Release |
|---|---|---|
| `feat:` | A new feature | minor |
| `fix:` | A bug fix | patch |
| `perf:` | A performance improvement | patch |
| `docs:`, `test:`, `refactor:`, `style:`, `chore:`, `ci:` | Changes that people running Keystone do not see | none |

Add `!` after the type, or a `BREAKING CHANGE:` footer, when an upgrade needs action from the person running Keystone. For example: a renamed setting or a new minimum Node.js version.

release-please writes `CHANGELOG.md` from these subjects, so do not edit it by hand. Write the subject for someone who runs Keystone, because it becomes the line in the release notes.

#### Pull request checklist

- [ ] Tests added or updated when behavior changes
- [ ] `npm run check` and `npm run build` pass
- [ ] Docs updated where the change is visible (see [Keeping docs in sync](#keeping-docs-in-sync))
- [ ] A Conventional Commits title that reads well in the release notes

### Keeping docs in sync

Update the matching doc in the same pull request when a change is visible to people who use or run Keystone:

| The change touches | Update |
|---|---|
| What users see in the page | [README.md](README.md) "What you get" |
| A setting in `config.json`, or a default | [README.md](README.md) "Configuration" and [config.example.json](config.example.json) |
| How the parts fit together, storage or the security model | [docs/architecture.md](docs/architecture.md) |
| Installing, running as a service, health checks, logs, backups or upgrades | [docs/operations.md](docs/operations.md) |
| How to report a vulnerability, or which versions get fixes | [SECURITY.md](SECURITY.md) |
| How releases are made | [RELEASING.md](RELEASING.md) |

Keep the docs free of things that change often. Do not list test counts, file counts or the values of limits. Name the constant or the test that holds the exact rule, and link to it. Adding a test or tuning a limit should not need a doc change.

## Development setup

### Prerequisites

- Node.js 24 or newer. The version in [.nvmrc](.nvmrc) is the one to develop on.
- Git

You do not need a real Homebridge. `npm run dev:fake` starts two fake instances.

### Setup

```bash
git clone <repository URL>
cd keystone
npm ci
npm run build
npm run dev:fake
```

Open `http://localhost:8590` and sign in as `example` with `keystone-dev-password`. The fake setup keeps its data in `data/dev`, which git ignores.

### Scripts

| Script | What it does |
|---|---|
| `npm run check` | Typecheck, lint and tests. CI runs this. |
| `npm run build` | Compiles the server and the web UI into `dist` |
| `npm test` | Only the tests |
| `npm run typecheck` | Only the TypeScript checks, for the server and the web UI |
| `npm run lint` | Only ESLint |
| `npm run dev:fake` | Keystone against two fake Homebridge instances |
| `npm start` | Keystone from `dist`, with `config.json` |
| `npm run secrets` | Adds users and stores the Homebridge passwords |

The tests use Node's built-in test runner and run the TypeScript sources directly. The integration tests start a fake Homebridge UI from `test/helpers/fake-homebridge.ts`, which speaks the real login, REST and socket.io log protocol. Tests must not depend on timing. Wait for a condition instead of sleeping for a fixed time.

[CI](.github/workflows/ci.yml) runs `npm audit`, `npm run check` and `npm run build` on the oldest supported Node.js and on the current release. [CodeQL](.github/workflows/codeql.yml) runs on pull requests, on pushes to `main` and once a week. [Dependency Review](.github/workflows/dependency-review.yml) fails a pull request that adds a dependency with a known vulnerability. [Release](.github/workflows/release.yml) runs release-please on each merge to `main`. `main` is protected, so every change goes through a pull request, and the CI jobs must pass before it merges. Dependabot opens pull requests for npm packages and GitHub Actions. Every workflow pins its actions to a commit SHA, and Dependabot keeps those pins current.

## Project structure

[docs/architecture.md](docs/architecture.md#source-layout) says what each part of `src/` and `test/` holds. The other top-level folders are `docs/` for the guides, `scripts/` for the fake Homebridge setup, and `.github/` for the workflows, Dependabot and the issue and pull request templates.

## Code standards

- Keystone only reads from Homebridge. Never send a change to Homebridge.
- Validate all input at the boundary: the config file, HTTP requests and Homebridge answers.
- Copy each Homebridge answer into Keystone's own types, so that fields such as the setup PIN never reach the browser.
- Add log text to the page only as text, never as HTML.
- Never log passwords, session tokens or cookies.
- Keep the only runtime dependency, `socket.io-client`. Discuss a new dependency in an issue first.
- Use placeholder data in tests and docs: `192.0.2.x` addresses, `example.com` hosts and names such as `example-1`.
- Keep functions small and typed, and add tests for new code paths.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the same license as the project.

## Questions

Open an issue to discuss. The main docs are:

- [README.md](README.md): overview and quick start
- [docs/architecture.md](docs/architecture.md) and [docs/operations.md](docs/operations.md)
- [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [RELEASING.md](RELEASING.md)
