import { readFile } from 'fs'
import { promisify } from 'util'
import minimatch = require('minimatch')

import { spawnGetStdout } from './command'
import { applyDecisionCommand, DecisionCommand, parseDecisionCommand } from './decision-command'

const pReadFile = promisify(readFile)

export interface DependencyChangeFilter {
  packages: RegExp
  ignoreChanges: string[]
  command?: DecisionCommand
}

export interface FilterPackage {
  name: string
  // repository-relative directory, without a trailing slash
  location: string
  circleDependencies: string[]
}

export interface FilterDecision {
  pkg: string
  trigger: boolean
  reason: string
  // set when only changes in dependencies trigger the package
  dependencyChanges?: { pkg: string; files: string[] }[]
}

const MAX_LISTED_FILES = 5

// the same options lerna uses for lerna.json `ignoreChanges`
const matchesAny = (file: string, patterns: string[]): boolean =>
  patterns.some((pattern) => minimatch(file, pattern, { matchBase: true, dot: true }))

export function parseDependencyChangeFilter(raw: unknown): DependencyChangeFilter | undefined {
  if (raw === undefined) {
    return undefined
  }
  const { packages, ignoreChanges, command } = (raw ?? {}) as {
    packages?: unknown
    ignoreChanges?: unknown
    command?: unknown
  }
  if (
    typeof packages !== 'string' ||
    !Array.isArray(ignoreChanges) ||
    ignoreChanges.length === 0 ||
    !ignoreChanges.every((pattern) => typeof pattern === 'string' && pattern.length > 0)
  ) {
    console.warn(
      'Warning: dependencyChangeFilter needs a `packages` regex and a non-empty `ignoreChanges` ' +
        'list of globs, ignoring it',
    )
    return undefined
  }
  try {
    return {
      packages: new RegExp(packages),
      ignoreChanges,
      command: parseDecisionCommand(command),
    }
  } catch (e) {
    console.warn(`Warning: invalid dependencyChangeFilter, ignoring it: ${e}`)
    return undefined
  }
}

const filesIn = (location: string, files: string[]): string[] =>
  files.filter((file) => file.startsWith(`${location}/`))

const collectRelevantPackages = (
  start: FilterPackage,
  byName: Map<string, FilterPackage>,
  workspaceDependencies: Record<string, string[]>,
): Set<string> => {
  const relevant = new Set<string>()
  const queue = [...(workspaceDependencies[start.name] ?? []), ...start.circleDependencies]
  while (queue.length) {
    const name = queue.pop() as string
    if (relevant.has(name) || name === start.name || !byName.has(name)) {
      continue
    }
    relevant.add(name)
    queue.push(...(workspaceDependencies[name] ?? []))
  }
  return relevant
}

const listFiles = (files: string[]): string => {
  const listed = files.slice(0, MAX_LISTED_FILES).join(', ')
  return files.length > MAX_LISTED_FILES
    ? `${listed} (+${files.length - MAX_LISTED_FILES} more)`
    : listed
}

/**
 * Decide, for each package matching the filter, whether it still has to run:
 * a change in its own directory always counts, a change in a package it
 * depends on (workspace dependencies, transitively, and circle.yml
 * `dependencies`) counts only for files outside `ignoreChanges`.
 * `baseIgnoreChanges` is lerna.json's `ignoreChanges`, which lerna already
 * applies to every package.
 */
export function decideFilteredPackages(
  filter: DependencyChangeFilter,
  packages: FilterPackage[],
  workspaceDependencies: Record<string, string[]>,
  changedFiles: string[],
  baseIgnoreChanges: string[],
  candidates: Set<string>,
): FilterDecision[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const relevantFiles = changedFiles.filter((file) => !matchesAny(file, baseIgnoreChanges))
  const countedFiles = relevantFiles.filter((file) => !matchesAny(file, filter.ignoreChanges))

  return packages
    .filter((pkg) => candidates.has(pkg.name) && filter.packages.test(pkg.name))
    .map((pkg) => {
      const ownFiles = filesIn(pkg.location, relevantFiles)
      if (ownFiles.length) {
        return {
          pkg: pkg.name,
          trigger: true,
          reason: `own changes: ${listFiles(ownFiles)}`,
        }
      }

      const relevant = Array.from(collectRelevantPackages(pkg, byName, workspaceDependencies))
      const counted = relevant
        .map((name) => ({
          name,
          files: filesIn((byName.get(name) as FilterPackage).location, countedFiles),
        }))
        .filter(({ files }) => files.length)
      if (counted.length) {
        return {
          pkg: pkg.name,
          trigger: true,
          reason: counted.map(({ name, files }) => `${name}: ${listFiles(files)}`).join('; '),
          dependencyChanges: counted.map(({ name, files }) => ({ pkg: name, files })),
        }
      }

      const ignored = relevant
        .map((name) => ({
          name,
          files: filesIn((byName.get(name) as FilterPackage).location, relevantFiles),
        }))
        .filter(({ files }) => files.length)
      if (!ignored.length) {
        // lerna saw a change this filter cannot place, so keep the workflow
        return {
          pkg: pkg.name,
          trigger: true,
          reason: 'affected according to lerna, but no matching changed files were found',
        }
      }
      return {
        pkg: pkg.name,
        trigger: false,
        reason: `dependencies changed only in files matching ignoreChanges: ${ignored
          .map(({ name, files }) => `${name}: ${listFiles(files)}`)
          .join('; ')}`,
      }
    })
}

export interface FilterResult {
  triggerPackages: Set<string>
  skipReasons: Record<string, string>
}

/**
 * Remove filtered packages from `triggerPackages` when the filter decides they
 * don't have to run. Any failure keeps `triggerPackages` unchanged.
 */
export async function applyDependencyChangeFilter(
  filter: DependencyChangeFilter,
  packages: FilterPackage[],
  triggerPackages: Set<string>,
  changesSinceCommit: string,
): Promise<FilterResult> {
  try {
    const [diffOutput, graphOutput, baseIgnoreChanges] = await Promise.all([
      spawnGetStdout('git', ['diff', '--name-only', '--no-renames', '-z', changesSinceCommit]),
      spawnGetStdout('lerna', ['list', '--graph', '--all']),
      readLernaIgnoreChanges(),
    ])
    // NUL-separated, so git never quotes paths with special characters
    const changedFiles = diffOutput.split('\0').filter(Boolean)
    const decisions = decideFilteredPackages(
      filter,
      packages,
      JSON.parse(graphOutput),
      changedFiles,
      baseIgnoreChanges,
      triggerPackages,
    )

    if (filter.command) {
      await applyDecisionCommand(filter.command, decisions, changesSinceCommit)
    }

    const filtered = new Set(triggerPackages)
    const skipReasons: Record<string, string> = {}
    console.log('dependencyChangeFilter decisions:')
    for (const { pkg, trigger, reason } of decisions) {
      console.log(`  ${trigger ? 'RUN ' : 'SKIP'} ${pkg}: ${reason}`)
      if (!trigger) {
        filtered.delete(pkg)
        skipReasons[pkg] = reason
      }
    }
    return { triggerPackages: filtered, skipReasons }
  } catch (e) {
    console.warn(
      `Warning: dependencyChangeFilter failed, running every affected package: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return { triggerPackages, skipReasons: {} }
  }
}

async function readLernaIgnoreChanges(): Promise<string[]> {
  const lernaJson = JSON.parse((await pReadFile('lerna.json')).toString())
  const ignoreChanges = lernaJson.ignoreChanges ?? []
  if (!Array.isArray(ignoreChanges)) {
    throw new Error('lerna.json ignoreChanges is not a list')
  }
  return ignoreChanges
}
