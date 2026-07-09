# circletron

[![build status](https://circleci.com/gh/circletron/circletron.png?style=shield)](https://circleci.com/gh/circletron/circletron)
[![Known Vulnerabilities](https://snyk.io/test/github/circletron/circletron/badge.svg)](https://snyk.io/test/github/circletron/circletron)
[![Renovate](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://renovatebot.com)

circletron is a tool to simplify working with monorepos. Currently monorepos managed via lerna are supported.

With circletron the `.circleci/config.yml` is distributed across subproject directories within the monorepo. Each subproject can define its own commands, workflows and jobs. Jobs defined within subpackage specific workflows will be automatically skipped in branches where no changes were detected.

## How to use

1. Create a minimal `.circleci/config.yml` like this:

```yaml
version: 2.1
setup: true
orbs:
  circletron: circletron/circletron@3.0.5

workflows:
  trigger-jobs:
    jobs:
      - circletron/trigger-jobs
```

2. Optionally create a `circle.yml` in the root of the monorepo. The jobs in this `circle.yml` will always run and any `commands`, `executors` and `orbs` defined in this `circle.yml` will be available in the `circle.yml` of all other subpackages. This is also where `version` should be defined, if not the version `2.1` will be assigned.

3. Create a `circle.yml` in each subpackage within the monorepo which requires automation. The jobs in this circle configuration are run only when there are changes in the respective branch to a file within this subpackage or changes to one of the subpackages that it depends on. `conditional: false` may be added to a job to specify that it must always be run.

4. Optionally create a `.circleci/circletron.yml` file to specify target branches e.g.

```
# this is the default value
targetBranches: ^(release/|main$|master$|develop$)
```

To determine the branchpoint of a PR, circletron finds the latest commit that belongs to a branch matching the `targetBranches` regex. All jobs are run for pushes to a branch matching `targetBranches` except when `runOnlyChangedOnTargetBranches` is specified.

5. Optionally add `dependencies` to `circle.yml` files

`project1/circle.yml`:

```typescript
dependencies:
  - project2
  - project3

jobs:
  test-project-1:
    steps:
      - checkout
      - npm run test

workflows:
  project-1-workflow:
    jobs:
      - test-project-1
```

This will cause jobs within `project1` to run when changes are detected in either `project1`, `project2` or `project3`.

## Details

It is useful to set up branch protection rules to prevent code from being merged when a CI job does not pass. When jobs are omitted then the PR will never be mergeable since the job will remain in a `pending` state. For this reason `circletron` will never omit a job that was determined not to be run, instead the job will be replaced with a simple job that echos "Job is not required" and return a success exit status.

## Advanced Configuration

circletron can be configured to only run workflows on target branches in the packages that have changed since the last successful build on that branch. This feature interacts with the Circle API v2 so requires an access token to be provided, via the `CIRCLE_TOKEN` environment variable. This feature can be turned on using `runOnlyChangedOnTargetBranches`:

```yml
runOnlyChangedOnTargetBranches: true
```

circletron can be configured to skip whole workflows and not just specific jobs. This feature can be turned on using `skip`. Skip defaults to 'jobs'.

```yml
skip: workflows
```

When circletron is set to skip: jobs, instead of omitting jobs for GitHub protection rules, we run a simple job that returns success.
In cases where you share jobs across workflows it might be more relevant to create a simple workflow that will run a single skip job and returns success. That way if two packages share a job circletron will know to omit running it on packages that haven't changed.

## Skip indication

With `skip: workflows`, a skipped workflow is replaced by a green `skip` job so required status checks stay satisfied, while making skips visibly and machine-readably distinct from real passing runs. The generated `skip` job (which always exits successfully):

1. Publishes a GitHub check run on the pipeline's commit with conclusion `skipped`, named `<workflow> (circletron: skipped — unaffected)` so it can never collide with a CircleCI-reported required check name. The summary explains that the package was unaffected on this branch.
2. Uploads a machine-readable JSON artifact (registered via `store_artifacts` at `circletron/skip.json`) so tooling can count real runs vs skips:

```json
{
  "workflow": "my-workflow",
  "status": "skipped-unaffected",
  "pipelineId": "<pipeline id>",
  "pipelineNumber": "<pipeline number>",
  "commitSha": "<sha>",
  "branch": "<branch>"
}
```

### Token requirements

Creating check runs requires the `GITHUB_CHECKS_TOKEN` environment variable, typically injected via a CircleCI context. Classic GitHub personal access tokens **cannot** create check runs: the token must be a GitHub App installation token or a fine-grained PAT with `checks: write` permission on the repository. If the variable is absent the skip job logs a warning and still succeeds exactly as before — only the check run is omitted.

### `report-skip` subcommand

The check-run posting and artifact writing is available as a standalone subcommand so custom skip paths (e.g. jobs that `circleci-agent step halt` on certain branches) can share the same naming convention and artifact schema:

```sh
circletron report-skip --workflow my-workflow --reason halted-on-branch
```

The reason (default `unaffected`) is reflected in the check-run name (`my-workflow (circletron: skipped — halted-on-branch)`), summary and the artifact's `status` field (`skipped-halted-on-branch`). The artifact is written to `/tmp/circletron/skip.json`; register it with `store_artifacts` to upload it. Repository owner/name and commit SHA are read from the built-in `CIRCLE_PROJECT_USERNAME`, `CIRCLE_PROJECT_REPONAME` and `CIRCLE_SHA1` environment variables; pipeline id/number are read from `CIRCLETRON_PIPELINE_ID`/`CIRCLETRON_PIPELINE_NUMBER` if set.
