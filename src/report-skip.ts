import { mkdir, writeFile } from 'fs'
import { promisify } from 'util'
import { dirname } from 'path'
import axios from 'axios'

const pMkdir = promisify(mkdir)
const pWriteFile = promisify(writeFile)

const GITHUB_API_URL = 'https://api.github.com'

export const GITHUB_CHECKS_TOKEN_VAR = 'GITHUB_CHECKS_TOKEN'
export const DEFAULT_SKIP_ARTIFACT_PATH = '/tmp/circletron/skip.json'

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

const REASON_SUMMARIES: Record<string, string> = {
  unaffected: 'The package was unaffected by the changes on this branch.',
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
  await pMkdir(dirname(artifactPath), { recursive: true })
  await pWriteFile(artifactPath, JSON.stringify(artifact, undefined, 2))
  console.log(`Wrote skip artifact to ${artifactPath}`)

  const token = env[GITHUB_CHECKS_TOKEN_VAR]
  if (!token) {
    console.warn(
      `Warning: ${GITHUB_CHECKS_TOKEN_VAR} is not set, skipping GitHub check run creation. ` +
        'Provide a GitHub App installation token or fine-grained PAT with checks: write ' +
        'permission to publish a "skipped" check run for skipped workflows.',
    )
    return
  }

  const owner = env.CIRCLE_PROJECT_USERNAME
  const repo = env.CIRCLE_PROJECT_REPONAME
  const headSha = env.CIRCLE_SHA1
  if (!owner || !repo || !headSha) {
    console.warn(
      'Warning: CIRCLE_PROJECT_USERNAME, CIRCLE_PROJECT_REPONAME or CIRCLE_SHA1 is not set, ' +
        'skipping GitHub check run creation.',
    )
    return
  }

  const payload = buildCheckRunPayload(workflow, reason, headSha)
  try {
    await axios.post(`${GITHUB_API_URL}/repos/${owner}/${repo}/check-runs`, payload, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
      },
    })
    console.log(`Created check run '${payload.name}' for ${owner}/${repo}@${headSha}`)
  } catch (e) {
    console.warn(`Warning: failed to create GitHub check run: ${e.message}`)
  }
}

export async function runReportSkipCli(args: string[]): Promise<void> {
  let workflow: string | undefined
  let reason = 'unaffected'
  for (let i = 0; i < args.length; ++i) {
    if (args[i] === '--workflow') {
      workflow = args[++i]
    } else if (args[i] === '--reason') {
      reason = args[++i]
    } else {
      throw new Error(`Unknown argument: ${args[i]}`)
    }
  }
  if (!workflow) {
    throw new Error('report-skip requires a --workflow argument')
  }
  await reportSkip(workflow, reason)
}
