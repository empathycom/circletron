import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import axios from 'axios'

import { buildCheckRunPayload, buildSkipArtifact, reportSkip } from './report-skip'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const testEnv = {
  CIRCLE_PROJECT_USERNAME: 'empathycom',
  CIRCLE_PROJECT_REPONAME: 'circletron',
  CIRCLE_SHA1: 'abc123',
  CIRCLE_BRANCH: 'main',
  CIRCLETRON_PIPELINE_ID: 'pipeline-id',
  CIRCLETRON_PIPELINE_NUMBER: '42',
}

describe('buildCheckRunPayload', () => {
  it('builds a skipped check run payload distinct from CircleCI check names', () => {
    const payload = buildCheckRunPayload('my-package', 'unaffected', 'abc123')
    expect(payload).toEqual({
      name: 'my-package (circletron: skipped — unaffected)',
      head_sha: 'abc123',
      status: 'completed',
      conclusion: 'skipped',
      output: {
        title: 'Workflow skipped: unaffected',
        summary: 'The package was unaffected by the changes on this branch.',
      },
    })
  })

  it('includes custom reasons in the name and summary', () => {
    const payload = buildCheckRunPayload('my-package', 'halted-on-branch', 'abc123')
    expect(payload.name).toEqual('my-package (circletron: skipped — halted-on-branch)')
    expect(payload.output.summary).toEqual(
      'The workflow `my-package` was skipped by circletron (reason: halted-on-branch).',
    )
  })
})

describe('buildSkipArtifact', () => {
  it('builds the artifact from CircleCI environment variables', () => {
    expect(buildSkipArtifact('my-package', 'unaffected', testEnv)).toEqual({
      workflow: 'my-package',
      status: 'skipped-unaffected',
      pipelineId: 'pipeline-id',
      pipelineNumber: '42',
      commitSha: 'abc123',
      branch: 'main',
    })
  })
})

describe('reportSkip', () => {
  const artifactPath = join(tmpdir(), `circletron-test-${process.pid}`, 'skip.json')

  beforeEach(() => {
    mockedAxios.post.mockReset()
    mockedAxios.post.mockResolvedValue({ data: {} })
  })

  it('writes the artifact and posts a check run when a token is available', async () => {
    await reportSkip('my-package', 'unaffected', artifactPath, {
      ...testEnv,
      GITHUB_CHECKS_TOKEN: 'gh-token',
    })

    expect(JSON.parse(readFileSync(artifactPath).toString())).toEqual({
      workflow: 'my-package',
      status: 'skipped-unaffected',
      pipelineId: 'pipeline-id',
      pipelineNumber: '42',
      commitSha: 'abc123',
      branch: 'main',
    })

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.github.com/repos/empathycom/circletron/check-runs',
      buildCheckRunPayload('my-package', 'unaffected', 'abc123'),
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${'gh-token'}`,
        },
      },
    )
  })

  it('warns and still succeeds when no token is configured', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation()
    try {
      await reportSkip('my-package', 'unaffected', artifactPath, testEnv)

      expect(mockedAxios.post).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GITHUB_CHECKS_TOKEN'))
      // the artifact is still written
      expect(JSON.parse(readFileSync(artifactPath).toString()).status).toEqual(
        'skipped-unaffected',
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('warns and still succeeds when the check run request fails', async () => {
    mockedAxios.post.mockRejectedValue(new Error('boom'))
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation()
    try {
      await expect(
        reportSkip('my-package', 'unaffected', artifactPath, {
          ...testEnv,
          GITHUB_CHECKS_TOKEN: 'gh-token',
        }),
      ).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed to create'))
    } finally {
      warnSpy.mockRestore()
    }
  })
})
