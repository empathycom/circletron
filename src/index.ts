#!/usr/bin/env node

import { readFile } from 'fs'
import { promisify } from 'util'
import axios from 'axios'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { join as pathJoin } from 'path'

import { getLastSuccessfulBuildRevisionOnBranch } from './circle'
import { requireEnv } from './env'
import { getBranchpointCommitAndTargetBranch } from './git'
import { spawnGetStdout } from './command'
import {
  GITHUB_CHECKS_APP_ID_VAR,
  GITHUB_CHECKS_APP_PRIVATE_KEY_VAR,
  GITHUB_CHECKS_TOKEN_VAR,
  postSkippedCheckRun,
  postSkippedCommitStatus,
  resolveCheckRunTarget,
  runReportSkipCli,
  writeSkipsArtifact,
} from './report-skip'

const CONTINUATION_API_URL = `https://circleci.com/api/v2/pipeline/continue`
const DEFAULT_CONFIG_VERSION = 2.1
const DEFAULT_TARGET_BRANCHES_REGEX = /^(release\/|develop$|main$|master$)/
const DEFAULT_RUN_ONLY_CHANGED_ON_TARGET_BRANCHES = false
const DEFAULT_SKIP = 'jobs'

const pReadFile = promisify(readFile)

interface CircleConfig {
  dependencies?: string[]
  workflows?: Record<string, unknown>
  [k: string]: unknown
}

interface Package {
  name: string
  circleConfig: CircleConfig
}

interface CircletronConfig {
  runOnlyChangedOnTargetBranches: boolean
  targetBranchesRegex: RegExp
  passTargetBranch: boolean
  skip: 'workflows' | 'jobs' | 'check-runs'
  // required-check name per workflow, when it differs from the workflow name
  checkNames: Record<string, string>
}

async function getPackages(): Promise<Package[]> {
  const packageOutput = await spawnGetStdout('lerna', ['list', '--parseable', '--all', '--long'])
  const allPackages = await Promise.all(
    packageOutput
      .trim()
      .split('\n')
      .map(async (line) => {
        const [fullPath, name] = line.split(':')
        let circleConfig: CircleConfig | undefined
        try {
          circleConfig = yamlParse((await pReadFile(pathJoin(fullPath, 'circle.yml'))).toString())
        } catch (e) {
          // no circle config, filter below
        }

        return { circleConfig, name }
      }),
  )

  function hasConfig(pkg: { circleConfig?: CircleConfig }): pkg is Package {
    return !!pkg.circleConfig
  }
  return allPackages.filter(hasConfig)
}

/**
 * Get the names of the packages which builds should be triggered for by
 * determing which packages have changed in this branch and consulting
 * .circleci/circletron.yml to packages that should be run due to a dependency
 * changing.
 */
const getTriggerPackages = async (
  packages: Package[],
  config: CircletronConfig,
  branch: string,
  isTargetBranch: boolean,
  scheduleJobToRun: string,
): Promise<{
  triggerPackages: Set<string>
  targetBranch: string
  filteredPackages: Package[]
}> => {
  const changedPackages = new Set<string>()
  const allPackageNames = new Set(packages.map((pkg) => pkg.name))

  if (scheduleJobToRun !== 'default') {
    const scheduledJobPackages = Array.from(packages).filter((pkg) =>
      pkg.name.includes(scheduleJobToRun),
    )
    console.log('Running only relevant pipelines for scheduled job', {
      branch,
      scheduledJobPackages,
      allPackageNames,
    })
    return {
      triggerPackages: new Set(scheduledJobPackages.map((pkg) => pkg.name)),
      targetBranch: branch,
      filteredPackages: scheduledJobPackages,
    }
  }

  let changesSinceCommit: string
  let targetBranch: string | undefined = branch

  if (isTargetBranch) {
    if (config.runOnlyChangedOnTargetBranches) {
      const lastBuildCommit: string | undefined = await getLastSuccessfulBuildRevisionOnBranch(
        branch,
      )

      if (!lastBuildCommit) {
        console.log(`Could not find a previous build on ${branch}, running all pipelines`)
        return { triggerPackages: allPackageNames, targetBranch, filteredPackages: packages }
      }

      changesSinceCommit = lastBuildCommit
    } else {
      console.log(`Detected a push from ${branch}, running all pipelines`)
      return { triggerPackages: allPackageNames, targetBranch, filteredPackages: packages }
    }
  } else {
    ;({ commit: changesSinceCommit, targetBranch } = await getBranchpointCommitAndTargetBranch(
      config.targetBranchesRegex,
    ))
  }

  console.log("Looking for changes since `%s'", changesSinceCommit)
  const changeOutput = (
    await spawnGetStdout('lerna', [
      'list',
      '--parseable',
      '--all',
      '--long',
      '--since',
      changesSinceCommit,
    ])
  ).trim()

  if (!changeOutput) {
    console.log('Found no changed packages')
  } else {
    for (const pkg of changeOutput.split('\n')) {
      changedPackages.add(pkg.split(':', 2)[1])
    }

    console.log('Found changes: %O', changedPackages)
  }

  return {
    triggerPackages: new Set(
      Array.from(changedPackages)
        .flatMap((changedPackage) => [
          changedPackage,
          ...packages
            .filter((pkg) => pkg.circleConfig.dependencies?.includes(changedPackage))
            .map((pkg) => pkg.name),
        ])
        .filter((pkg) => allPackageNames.has(pkg)),
    ),
    targetBranch: targetBranch ?? branch,
    filteredPackages: packages,
  }
}

const SKIP_WORKFLOW = {
  jobs: ['skip'],
}

const SKIP_JOB = {
  docker: [{ image: 'busybox:stable' }],
  steps: [
    {
      run: {
        name: 'Jobs not required',
        command: 'echo "Jobs not required"',
      },
    },
  ],
}

const getSkippedWorkflows = (packages: Package[], triggerPackages: Set<string>): string[] =>
  packages
    .filter((pkg) => !triggerPackages.has(pkg.name))
    .flatMap((pkg) => Object.keys(pkg.circleConfig.workflows ?? {}))

export async function buildConfiguration(
  packages: Package[],
  triggerPackages: Set<string>,
  circletronConfig: CircletronConfig,
  fallbackWorkflows: Set<string> = new Set(),
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: Record<string, any> = {}
  try {
    config = yamlParse((await pReadFile('circle.yml')).toString())
  } catch (e) {
    // the root config does not have to exist
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mergeObject = (path: string, projectYaml: any): void => {
    for (const [name, value] of Object.entries(projectYaml[path] ?? {})) {
      if (!config[path]) {
        config[path] = {}
      } else if (config[path][name]) {
        throw new Error(`Two ${path} with the same name: ${name}`)
      }
      config[path][name] = value
    }
  }
  if (!config.jobs) {
    config.jobs = {}
  }
  if (!config.workflows) {
    config.workflows = {}
  }
  if (!config.version) {
    config.version = DEFAULT_CONFIG_VERSION
  }
  const jobsConfig = config.jobs

  for (const pkg of packages) {
    const { circleConfig } = pkg

    mergeObject('orbs', circleConfig)
    mergeObject('executors', circleConfig)
    mergeObject('commands', circleConfig)

    // jobs may be missing from circle config if all workflow jobs are from orbs
    const jobs = circleConfig.jobs as Record<
      string,
      { conditional?: boolean; parameters?: Record<string, any> }
    >
    for (const [jobName, jobData] of Object.entries(jobs ?? {})) {
      if (jobsConfig[jobName]) {
        throw new Error(`Two jobs with the same name: ${jobName}`)
      }
      if ('conditional' in jobData) {
        const { conditional } = jobData
        delete jobData.conditional
        if (conditional === false) {
          // these jobs are triggered no matter what
          jobsConfig[jobName] = jobData
          continue
        }
      }
      if (circletronConfig.skip === 'jobs') {
        jobsConfig[jobName] = triggerPackages.has(pkg.name)
          ? jobData
          : { ...SKIP_JOB, parameters: jobData.parameters }
      } else {
        if (triggerPackages.has(pkg.name)) {
          jobsConfig[jobName] = jobData
        }
      }
    }
    if (circletronConfig.skip === 'workflows' || circletronConfig.skip === 'check-runs') {
      if (circletronConfig.skip === 'workflows') {
        config.jobs['skip'] = SKIP_JOB
      }
      if (triggerPackages.has(pkg.name)) {
        mergeObject('workflows', circleConfig)
      } else if (circleConfig.workflows) {
        // in check-runs mode a skipped workflow is omitted entirely; it only
        // degrades to a skip workflow when its check run could not be posted
        Object.keys(circleConfig.workflows).forEach((workflowName) => {
          if (circletronConfig.skip === 'workflows' || fallbackWorkflows.has(workflowName)) {
            config.jobs['skip'] = SKIP_JOB
            config.workflows[workflowName] = SKIP_WORKFLOW
          }
        })
      }
    } else {
      mergeObject('workflows', circleConfig)
    }
  }

  // the continuation API rejects a configuration without workflows, so when
  // everything is skipped run a single no-op skip workflow
  if (Object.keys(config.workflows).length === 0) {
    config.jobs['skip'] = SKIP_JOB
    config.workflows['skip'] = SKIP_WORKFLOW
  }
  return yamlStringify(config)
}

export async function getCircletronConfig(): Promise<CircletronConfig> {
  let rawConfig: {
    targetBranches?: string
    runOnlyChangedOnTargetBranches?: boolean
    passTargetBranch?: boolean
    skip?: string
    checkNames?: Record<string, string>
  } = {}
  try {
    rawConfig = yamlParse((await pReadFile(pathJoin('.circleci', 'circletron.yml'))).toString())
  } catch (e) {
    // circletron.yml is not mandatory
  }

  const skip: string = rawConfig.skip ?? DEFAULT_SKIP
  if (skip !== 'jobs' && skip !== 'workflows' && skip !== 'check-runs') {
    throw new Error(`Skip must be 'jobs', 'workflows' or 'check-runs' - got ${skip}`)
  }

  return {
    runOnlyChangedOnTargetBranches:
      rawConfig.runOnlyChangedOnTargetBranches ?? DEFAULT_RUN_ONLY_CHANGED_ON_TARGET_BRANCHES,
    targetBranchesRegex: rawConfig.targetBranches
      ? new RegExp(rawConfig.targetBranches)
      : DEFAULT_TARGET_BRANCHES_REGEX,
    passTargetBranch: Boolean(rawConfig.passTargetBranch),
    skip: skip,
    checkNames: rawConfig.checkNames ?? {},
  }
}

export async function triggerCiJobs(
  branch: string,
  continuationKey: string,
  scheduleJobToRun: string,
): Promise<void> {
  const circletronConfig = await getCircletronConfig()
  const packages = await getPackages()
  // run all jobs on target branches
  const isTargetBranch = circletronConfig.targetBranchesRegex.test(branch)
  const { filteredPackages, triggerPackages, targetBranch } = await getTriggerPackages(
    packages,
    circletronConfig,
    branch,
    isTargetBranch,
    scheduleJobToRun,
  )

  const skippedWorkflows = getSkippedWorkflows(filteredPackages, triggerPackages)
  // one artifact per pipeline listing every skipped workflow, uploaded via the
  // orb's store_artifacts step
  await writeSkipsArtifact(skippedWorkflows)

  let fallbackWorkflows = new Set<string>()
  if (circletronConfig.skip === 'check-runs' && skippedWorkflows.length > 0) {
    const target = await resolveCheckRunTarget()
    if (!target) {
      console.warn(
        `Warning: no GitHub credentials (${GITHUB_CHECKS_TOKEN_VAR}, or ` +
          `${GITHUB_CHECKS_APP_ID_VAR} with ${GITHUB_CHECKS_APP_PRIVATE_KEY_VAR}) or the ` +
          'CircleCI project environment variables are not set, falling back to skip workflows',
      )
      fallbackWorkflows = new Set(skippedWorkflows)
    } else {
      const results = await Promise.all(
        skippedWorkflows.map(async (workflow) => {
          const checkName = circletronConfig.checkNames[workflow] ?? workflow
          // tokens without Checks API access (e.g. personal access tokens)
          // fall back to a classic commit status under the same context
          const posted =
            (await postSkippedCheckRun(target, checkName, workflow)) ||
            (await postSkippedCommitStatus(target, checkName, workflow))
          return { workflow, posted }
        }),
      )
      fallbackWorkflows = new Set(results.filter((r) => !r.posted).map((r) => r.workflow))
    }
  }

  const configuration = await buildConfiguration(
    filteredPackages,
    triggerPackages,
    circletronConfig,
    fallbackWorkflows,
  )
  const body: {
    'continuation-key': string
    configuration: string
    parameters?: Record<string, string | boolean>
  } = { 'continuation-key': continuationKey, configuration }
  if (circletronConfig.passTargetBranch) {
    body.parameters = { 'target-branch': targetBranch, 'on-target-branch': isTargetBranch }
  }
  console.log('CircleCI configuration:')
  console.log(configuration)

  const response = await axios.post(CONTINUATION_API_URL, body)
  console.log('CircleCI response: %O', response.data)
}

if (require.main === module) {
  const [command, ...commandArgs] = process.argv.slice(2)

  if (command === 'report-skip') {
    runReportSkipCli(commandArgs).catch((err) => {
      console.warn('Got error: %O', err)
      process.exit(1)
    })
  } else {
    const branch = requireEnv('CIRCLE_BRANCH')
    const continuationKey = requireEnv('CIRCLE_CONTINUATION_KEY')
    const scheduleJobToRun = requireEnv('TRIGGER_SCHEDULED_JOB')
    console.log('scheduleJobToRun', scheduleJobToRun)

    triggerCiJobs(branch, continuationKey, scheduleJobToRun).catch((err) => {
      console.warn('Got error: %O', err)
      process.exit(1)
    })
  }
}
