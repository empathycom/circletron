import { mkdir, writeFile } from 'fs'
import { promisify } from 'util'
import { dirname } from 'path'
import axios from 'axios'

const pMkdir = promisify(mkdir)
const pWriteFile = promisify(writeFile)

const GITHUB_API_URL = 'https://api.github.com'

export const GITHUB_CHECKS_TOKEN_VAR = 'GITHUB_CHECKS_TOKEN'
export const DEFAULT_SKIP_ARTIFACT_PATH = '/tmp/circletron/skip.json'
export const DEFAULT_SKIPS_ARTIFACT_PATH = '/tmp/circletron/skips.json'

export interface SkipArtifact {
  workflow: string
  status: string
  pipelineId?: string
  pipelineNumber?: string
  commitSha?: string
  branch?: string
}

export interface CheckRunPayload {
  name: string
  head_sha: string
  status: 'completed'
  conclusion: 'skipped'
  output: {
    title: string
    summary: string
  }
}

export interface CheckRunTarget {
  owner: string
  repo: string
  headSha: string
  token: string
}

const REASON_SUMMARIES: Record<string, string> = {
  unaffected: 'The package was unaffected by the changes on this branch.',
}

export function getCheckRunTarget(
  env: NodeJS.ProcessEnv = process.env,
): CheckRunTarget | undefined {
  const token = env[GITHUB_CHECKS_TOKEN_VAR]
  const owner = env.CIRCLE_PROJECT_USERNAME
  const repo = env.CIRCLE_PROJECT_REPONAME
  const headSha = env.CIRCLE_SHA1
  if (!token || !owner || !repo || !headSha) {
    return undefined
  }
  return { owner, repo, headSha, token }
}

async function postCheckRun(target: CheckRunTarget, payload: CheckRunPayload): Promise<void> {
  await axios.post(`${GITHUB_API_URL}/repos/${target.owner}/${target.repo}/check-runs`, payload, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${target.token}`,
    },
  })
}

/**
 * Fallback for tokens that cannot use the Checks API (e.g. personal access
 * tokens): post a classic commit status under the required check's context.
 * Statuses have no `skipped` state so it reports `success` with a
 * description marking the skip.
 */
export async function postSkippedCommitStatus(
  target: CheckRunTarget,
  checkName: string,
  workflow: string,
): Promise<boolean> {
  try {
    await axios.post(
      `${GITHUB_API_URL}/repos/${target.owner}/${target.repo}/statuses/${target.headSha}`,
      {
        state: 'success',
        context: checkName,
        description: `Skipped by circletron: workflow ${workflow} unaffected`.slice(0, 140),
      },
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${target.token}`,
        },
      },
    )
    console.log(`Created skipped commit status '${checkName}'`)
    return true
  } catch (e) {
    console.warn(
      `Warning: failed to create commit status '${checkName}': ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return false
  }
}

/**
 * Unlike buildCheckRunPayload the name must exactly match the required check
 * it stands in for: branch protection accepts a `skipped` conclusion as
 * passing, so no skip workflow has to run at all.
 */
export async function postSkippedCheckRun(
  target: CheckRunTarget,
  checkName: string,
  workflow: string,
): Promise<boolean> {
  try {
    await postCheckRun(target, {
      name: checkName,
      head_sha: target.headSha,
      status: 'completed',
      conclusion: 'skipped',
      output: {
        title: 'Workflow skipped: unaffected',
        summary: `The workflow \`${workflow}\` was skipped by circletron because the package was unaffected by the changes on this branch.`,
      },
    })
    console.log(`Created skipped check run '${checkName}'`)
    return true
  } catch (e) {
    console.warn(
      `Warning: failed to create check run '${checkName}': ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return false
  }
}

export async function writeSkipsArtifact(
  skippedWorkflows: string[],
  artifactPath: string = DEFAULT_SKIPS_ARTIFACT_PATH,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const artifact = {
    skippedWorkflows,
    pipelineId: env.CIRCLETRON_PIPELINE_ID,
    pipelineNumber: env.CIRCLETRON_PIPELINE_NUMBER,
    commitSha: env.CIRCLE_SHA1,
    branch: env.CIRCLE_BRANCH,
  }
  try {
    await pMkdir(dirname(artifactPath), { recursive: true })
    await pWriteFile(artifactPath, JSON.stringify(artifact, undefined, 2))
    console.log(`Wrote skips artifact to ${artifactPath}`)
  } catch (e) {
    // best-effort: a missing artifact must never fail the setup job
    console.warn(
      `Warning: failed to write skips artifact to ${artifactPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }
}

export function buildSkipArtifact(
  workflow: string,
  reason: string,
  env: NodeJS.ProcessEnv = process.env,
): SkipArtifact {
  return {
    workflow,
    status: `skipped-${reason}`,
    pipelineId: env.CIRCLETRON_PIPELINE_ID,
    pipelineNumber: env.CIRCLETRON_PIPELINE_NUMBER,
    commitSha: env.CIRCLE_SHA1,
    branch: env.CIRCLE_BRANCH,
  }
}

export function buildCheckRunPayload(
  workflow: string,
  reason: string,
  headSha: string,
): CheckRunPayload {
  const summary =
    REASON_SUMMARIES[reason] ??
    `The workflow \`${workflow}\` was skipped by circletron (reason: ${reason}).`
  return {
    name: `${workflow} (circletron: skipped — ${reason})`,
    head_sha: headSha,
    status: 'completed',
    conclusion: 'skipped',
    output: {
      title: `Workflow skipped: ${reason}`,
      summary,
    },
  }
}

export async function reportSkip(
  workflow: string,
  reason: string,
  artifactPath: string = DEFAULT_SKIP_ARTIFACT_PATH,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const artifact = buildSkipArtifact(workflow, reason, env)
  try {
    await pMkdir(dirname(artifactPath), { recursive: true })
    await pWriteFile(artifactPath, JSON.stringify(artifact, undefined, 2))
    console.log(`Wrote skip artifact to ${artifactPath}`)
  } catch (e) {
    // never fail the skip job: a missing artifact must not break required status checks
    console.warn(
      `Warning: failed to write skip artifact to ${artifactPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }

  const target = getCheckRunTarget(env)
  if (!target) {
    console.warn(
      `Warning: ${GITHUB_CHECKS_TOKEN_VAR}, CIRCLE_PROJECT_USERNAME, CIRCLE_PROJECT_REPONAME ` +
        'or CIRCLE_SHA1 is not set, skipping GitHub check run creation. Provide a GitHub App ' +
        'installation token or fine-grained PAT with checks: write permission to publish a ' +
        '"skipped" check run for skipped workflows.',
    )
    return
  }

  const payload = buildCheckRunPayload(workflow, reason, target.headSha)
  try {
    await postCheckRun(target, payload)
    console.log(`Created check run '${payload.name}'`)
  } catch (e) {
    console.warn(
      `Warning: failed to create GitHub check run: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

export async function runReportSkipCli(args: string[]): Promise<void> {
  let workflow: string | undefined
  let reason = 'unaffected'
  for (let i = 0; i < args.length; ++i) {
    if (args[i] === '--workflow' || args[i] === '--reason') {
      if (i + 1 >= args.length) {
        throw new Error(`Missing value for ${args[i]}`)
      }
      if (args[i] === '--workflow') {
        workflow = args[++i]
      } else {
        reason = args[++i]
      }
    } else {
      throw new Error(`Unknown argument: ${args[i]}`)
    }
  }
  if (!workflow) {
    throw new Error('report-skip requires a --workflow argument')
  }
  await reportSkip(workflow, reason)
}
