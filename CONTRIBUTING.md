# Contributing

Two branches matter:

- `main` is production. It only changes through a release PR from `dev` or a hotfix.
- `dev` is where work lands. Every push to `dev` builds a dev release that you can install from inside the app.

## Making a change

1. Branch from `dev`. Name it after the change, like `fix-safari-export`. Claude Code sessions use their own `claude/...` names, which is fine.
2. Keep one change per PR. If you find something unrelated, open a second PR.
3. Open the PR against `dev`. Use the PR title as the release note: say what changes for the user, in plain words.
4. CI has to pass. It builds the web UI, runs `go vet` and `go test`, and builds the image.
5. Squash-merge into `dev` yourself once CI is green. There are no required reviews.

Before you start, check the open PRs so you don't both work on the same screen.

## Testing a dev build

Every merge into `dev` replaces the [dev release](https://github.com/baki2001/Incus-WebUI/releases/tag/dev). Its version looks like `v0.7.0-dev.42`: the last release plus the build number.

To run it, open Settings > Updates and about, switch the channel to Dev and install the update. Switch back to Stable to return to the latest release. Use a test install for this, not the one you rely on.

## Releasing

1. Test the latest dev build in the app.
2. Open a PR from `dev` to `main` titled after the version, like `Release v0.7.0`. List the user-facing changes in the body, and tell the other person you're releasing.
3. Merge with "Create a merge commit". Don't squash: `dev` and `main` then stay in step.
4. Run the Release workflow (Actions > Release > Run workflow on `main`) with the version, like `v0.7.0`. It builds the binaries and the image and publishes the release. Installs on Stable see it within an hour.

Version numbers: bump the middle number for new features (`v0.7.0`), the last one for fixes only (`v0.7.1`).

## Hotfixes

For a bug in production that can't wait: branch from `main`, open the PR against `main`, release it as a patch version, then merge `main` into `dev` so the fix isn't lost.

## Writing

README, docs, PR text and UI copy should be short and plain. Say what something does. Skip filler and sales words.
