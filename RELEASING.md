# Releasing

[release-please](https://github.com/googleapis/release-please) automates releases. It works out the version, `CHANGELOG.md`, the git tag and the GitHub Release from the commit messages, so nobody edits or creates them by hand.

Keystone is not published to npm. A release is a git tag and a GitHub Release. People who run Keystone check out the tag, or follow `main`.

## Flow

1. A pull request with a **Conventional Commits title** is squash-merged into `main`. The title becomes the commit subject, and the subject decides the next version:

   | Subject prefix | Example | Version bump |
   |---|---|---|
   | `fix:` | `fix: keep the log at the bottom after sign-in` | patch |
   | `feat:` | `feat: show host network throughput` | minor |
   | `feat!:` or `fix!:`, or a `BREAKING CHANGE:` footer | `feat!: require Node.js 26` | major |
   | `perf:` | `perf: use the search index for long queries` | patch |
   | `chore:`, `docs:`, `refactor:`, `style:`, `test:`, `ci:` | `docs: fix a typo` | no release |

2. The **CI** and **CodeQL** workflows run.
3. **release-please** opens or updates a **Release PR** titled `chore(main): release X.Y.Z`. It bumps the version in `package.json`, `package-lock.json`, `.release-please-manifest.json` and the page footer in `src/web/index.html`, and adds the new section to `CHANGELOG.md`. Several changes that land before a release go into the same Release PR.
4. Merging the Release PR runs `release.yml` again. This time it creates the `vX.Y.Z` tag and publishes the GitHub Release.

To ship a release, land the changes, approve the Release PR's checks, then merge the Release PR.

To force a version, add this footer to the squash commit message in the merge dialog:

```
Release-As: 1.0.0
```

release-please then retitles the Release PR to that version. Do not edit `.release-please-manifest.json` or `CHANGELOG.md` by hand for that.

One commit can list several changes. Put each extra change at the bottom of the commit message as its own Conventional Commits line, with a blank line between them. Each one becomes its own line in the release notes.

## Approve the Release PR checks

`github-actions[bot]` authors the Release PR, because `release.yml` passes `github.token` to release-please. GitHub creates the checks for a bot's pull request, but holds them until a user with write access approves them.

**Open the Release PR's Checks tab and click "Approve and run" before merging.**

- There is no CLI for this. `POST /actions/runs/{run_id}/approve` covers forks from first-time contributors, not this gate.
- The approval does not stick. Every release needs it, and so does every update that release-please makes to an open Release PR.
- **Merging without approving turns the runs red.** They end as `failure` with no jobs and no logs. That means nobody approved them, not that anything broke.

GitHub added this step in its [change for pull requests created by bots](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/). It applies to branches in the same repository, not only to forks, and a repository cannot turn it off. The only way to avoid it is to author the Release PR as a different identity, which needs a GitHub App or a personal access token. This repository uses neither, because the click costs less.

## Repository settings (required once)

Under **Settings → Actions → General → Workflow permissions**:

1. **Read and write permissions**
2. **Allow GitHub Actions to create and approve pull requests**

Without the second setting, release-please can update its branch but cannot open the Release PR.

## Branch protection

`main` is protected, and the protection stays compatible with this flow:

- **A pull request is required** before merging. It needs no approving review, because there is one maintainer.
- **The rules apply to administrators too**, so nobody pushes to `main` directly.
- **The CI jobs must pass.** That includes the Release PR, so approve its checks before you merge it.
- **Squash merges only**, with the pull request title as the commit subject and an empty body, because release-please reads that subject.
- **Linear history**, and no force pushes or deletion of `main`.

A pull request that lists several changes for the release notes needs them in the squash commit. The body is empty by default, so paste the extra Conventional Commits lines into the merge dialog.

## Notes

- **Commit subjects drive releases.** Write them for someone who runs Keystone, because they become the release notes.
- `.release-please-manifest.json` holds the released version. It is `{}` until the first release, and `initial-version` in `release-please-config.json` makes that release 0.1.0.
- `release-please-config.json` sets which commit types appear in the release notes.
