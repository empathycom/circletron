# Changelog

- 2026/07/29 - 3.0.15

  - Mint a GitHub App installation token when `GITHUB_CHECKS_APP_ID` and
    `GITHUB_CHECKS_APP_PRIVATE_KEY` are set (and `GITHUB_CHECKS_TOKEN` is
    not), so skipped workflows are reported as proper check runs with
    conclusion `skipped`. The private key may be provided as a raw PEM or
    base64-encoded.

- 2026/07/29 - 3.0.14

  - In `skip: check-runs` mode, when posting the `skipped` check run fails
    (e.g. the token is a personal access token, which cannot use the Checks
    API), fall back to posting a classic commit status with state `success`
    under the same required-check context before degrading to a skip
    workflow. Requires branch protection checks that accept any source.

- 2026/07/29 - 3.0.13

  - Pin `lerna` to 8.2.4 in the Docker image. The unpinned `npm install -g lerna`
    started pulling lerna 9, which requires Node 18+ and crashes on the image's
    Node 16 base, breaking the `trigger-jobs` setup job.
  - Upgrade the Docker base image from `node:16-alpine3.13` to `node:20-alpine`.

- 2026/07/28 - 3.0.12

  - Add opt-in `skip: check-runs` mode: skipped workflows are omitted from the generated configuration entirely and the setup job posts a GitHub check run per skipped workflow, named like the required check with conclusion `skipped`, so branch protection stays satisfied without running any skip jobs. Workflows whose check run cannot be posted fall back to the green `skip` workflow.
  - Add `checkNames` option to map workflow names to required check names.
  - The setup job now uploads a `circletron/skips.json` artifact listing every skipped workflow in the pipeline.
  - Add `report-skip` subcommand so custom skip paths can publish a distinctly-named `skipped` check run and skip artifact.

- 2021/02/03 - 3.0.5

  - Fix bug that occurs when jobs with parameters are skipped.

- 2021/10/22 - 3.0.4

  - Add `passTargetBranch` configuration option.

- 2021/09/06 - 3.0.3

  - Add `runOnlyChangedOnTargetBranches` configuraton option.

- 2021/08/13 - 3.0.2

  - Fix crash for circle.yml files without `jobs`.

- 2021/08/03 - 3.0.1

  - Fix support for `dependencies`.

- 2021/07/09 - 3.0.0

  - Grab `dependencies` from each package's `circle.yml` file instead of configuring all dependencies in `.circleci/circletron.yml`.
  - Fix bug where branchpoint could be detected earlier than it actually was.

- 2021/07/05 - 2.0.1

  - Use `targetBranches` regex to determine when to run all jobs on a branch.

- 2021/06/25 - 2.0.0

  - Use `.circleci/circletron.yml` as the configuration file instead of `.circleci/lerna.yml`.
