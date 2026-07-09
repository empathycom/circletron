# AGENTS.md

Guidance for coding agents working in this repository.

## What this project is

circletron is a CircleCI setup/continuation tool for lerna monorepos. It merges per-package `circle.yml` files into a single generated CircleCI configuration and skips jobs or workflows for packages unaffected by a change. It ships as an npm package, a Docker image (`circletron/circletron:<version>`) and a CircleCI orb (`orb.yml`).

## Layout

- `src/index.ts` — CLI entry point; config generation (`buildConfiguration`), `.circleci/circletron.yml` parsing (`getCircletronConfig`), pipeline continuation.
- `src/report-skip.ts` — `circletron report-skip` subcommand: GitHub check run posting and skip artifact writing.
- `src/circle.ts` — CircleCI API v2 client (last successful build lookup).
- `src/git.ts` — branchpoint/target-branch detection.
- `src/*.spec.ts` — jest tests (compiled to `dist/` before running).

## Build, test, lint

```sh
npm ci
npm run build                 # tsc -p src → dist/
npm test                      # builds, then runs jest against dist/*.spec.js
npm run lint                  # eslint 'src/*.ts'
npm run validate-prettiness   # prettier -c 'src/*.ts' '*.md'
npm run validate              # test + lint + prettier + typecheck
```

Important: jest is configured with `roots: ['<rootDir>/dist']` and `testRegex: 'spec\.js$'`. Write tests as `src/*.spec.ts` and always build before running jest — TypeScript specs are never executed directly.

## Conventions

- TypeScript strict mode; formatting enforced by prettier (`.prettierrc`), linting by eslint (`.eslintrc.yaml`). Run prettier before committing.
- Keep changes minimal and backward compatible: generated CircleCI config must stay byte-identical for consumers unless they opt into a new config option.
- New config options live in `.circleci/circletron.yml` and are parsed in `getCircletronConfig` with safe defaults.
- The generated `skip` job must always exist and exit green when workflows are skipped — consumers use it as a required status check; never rename it or let it fail.

## Releasing

- Bump `version` in `package.json`, update the executor image tag in `orb.yml`, and add a `changelog.md` entry.
- Publish with `npm run docker-build` / `docker-push` and `npm run orb-publish`.
- Publish the Docker image before (or together with) the npm package/orb: with `skipIndication` enabled the generated skip job references `circletron/circletron:<version>`, so that image tag must exist when consumers upgrade.
