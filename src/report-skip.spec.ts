import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import axios from 'axios'

import {
  buildCheckRunPayload,
  buildSkipArtifact,
  getCheckRunTarget,
  postSkippedCheckRun,
  postSkippedCommitStatus,
  reportSkip,
  writeSkipsArtifact,
} from './report-skip'

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

describe('getCheckRunTarget', () => {
  it('returns the target when the token and project variables are set', () => {
    expect(getCheckRunTarget({ ...testEnv, GITHUB_CHECKS_TOKEN: 'gh-token' })).toEqual({
      owner: 'empathycom',
      repo: 'circletron',
      headSha: 'abc123',
      token: 'gh-token',
    })
  })

  it('returns undefined when the token or a project variable is missing', () => {
    expect(getCheckRunTarget(testEnv)).toBeUndefined()
    expect(
      getCheckRunTarget({ ...testEnv, GITHUB_CHECKS_TOKEN: 'gh-token', CIRCLE_SHA1: undefined }),
    ).toBeUndefined()
  })
})

describe('postSkippedCheckRun', () => {
  const target = { owner: 'empathycom', repo: 'circletron', headSha: 'abc123', token: 'gh-token' }

  beforeEach(() => {
    mockedAxios.post.mockReset()
    mockedAxios.post.mockResolvedValue({ data: {} })
  })

  it('posts a skipped check run under the exact required check name', async () => {
    await expect(
      postSkippedCheckRun(target, 'ci/circleci: my-workflow', 'my-workflow'),
    ).resolves.toBe(true)

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.github.com/repos/empathycom/circletron/check-runs',
      {
        name: 'ci/circleci: my-workflow',
        head_sha: 'abc123',
        status: 'completed',
        conclusion: 'skipped',
        output: {
          title: 'Workflow skipped: unaffected',
          summary:
            'The workflow `my-workflow` was skipped by circletron because the package was unaffected by the changes on this branch.',
        },
      },
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer gh-token',
        },
      },
    )
  })

  it('returns false and warns when the request fails', async () => {
    mockedAxios.post.mockRejectedValue(new Error('boom'))
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation()
    try {
      await expect(postSkippedCheckRun(target, 'my-workflow', 'my-workflow')).resolves.toBe(false)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to create check run 'my-workflow'"),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('postSkippedCommitStatus', () => {
  const target = { owner: 'empathycom', repo: 'circletron', headSha: 'abc123', token: 'gh-token' }

  beforeEach(() => {
    mockedAxios.post.mockReset()
    mockedAxios.post.mockResolvedValue({ data: {} })
  })

  it('posts a successful commit status under the exact required check context', async () => {
    await expect(
      postSkippedCommitStatus(target, 'ci/circleci: my-workflow', 'my-workflow'),
    ).resolves.toBe(true)

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.github.com/repos/empathycom/circletron/statuses/abc123',
      {
        state: 'success',
        context: 'ci/circleci: my-workflow',
        description: 'Skipped by circletron: workflow my-workflow unaffected',
      },
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer gh-token',
        },
      },
    )
  })

  it('returns false and warns when the request fails', async () => {
    mockedAxios.post.mockRejectedValue(new Error('boom'))
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation()
    try {
      await expect(postSkippedCommitStatus(target, 'my-workflow', 'my-workflow')).resolves.toBe(
        false,
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to create commit status 'my-workflow'"),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('writeSkipsArtifact', () => {
  const artifactPath = join(tmpdir(), `circletron-test-${process.pid}`, 'skips.json')

  it('writes every skipped workflow together with the pipeline metadata', async () => {
    await writeSkipsArtifact(['workflow-a', 'workflow-b'], artifactPath, testEnv)
    expect(JSON.parse(readFileSync(artifactPath).toString())).toEqual({
      skippedWorkflows: ['workflow-a', 'workflow-b'],
      pipelineId: 'pipeline-id',
      pipelineNumber: '42',
      commitSha: 'abc123',
      branch: 'main',
    })
  })

  it('warns instead of throwing when the artifact cannot be written', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation()
    try {
      // /dev/null is not a directory so creating the artifact directory fails
      await expect(
        writeSkipsArtifact([], join('/dev/null', 'sub', 'skips.json'), testEnv),
      ).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to write skips artifact'),
      )
    } finally {
      warnSpy.mockRestore()
    }
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

  it('warns and still attempts the check run when writing the artifact fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation()
    try {
      // /dev/null is not a directory so creating the artifact directory fails
      await expect(
        reportSkip('my-package', 'unaffected', join('/dev/null', 'sub', 'skip.json'), {
          ...testEnv,
          GITHUB_CHECKS_TOKEN: 'gh-token',
        }),
      ).resolves.toBeUndefined()

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to write skip artifact'),
      )
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.github.com/repos/empathycom/circletron/check-runs',
        buildCheckRunPayload('my-package', 'unaffected', 'abc123'),
        expect.anything(),
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
