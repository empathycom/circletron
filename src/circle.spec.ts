import axios from 'axios'

import { getLastSuccessfulBuildRevisionOnBranch } from './circle'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const pipeline = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  errors: [],
  state: 'created',
  trigger: { type: 'webhook' },
  vcs: { provider_name: 'GitHub', revision: `rev-${id}` },
  ...extra,
})

const mockApi = (items: unknown[], workflowStatuses: Record<string, string[]>) => {
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/pipeline')) return { data: { items } }
    const pipelineId = /pipeline\/(.*)\/workflow$/.exec(url)?.[1] ?? ''
    return {
      data: {
        items: (workflowStatuses[pipelineId] ?? []).map((status) => ({ id: 'w', status })),
      },
    }
  })
}

describe('getLastSuccessfulBuildRevisionOnBranch', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CIRCLE_BUILD_URL: 'https://circleci.com/gh/empathycom/empathy-monorepo/123',
      CIRCLE_TOKEN: 'token',
    }
    mockedAxios.get.mockReset()
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('returns the revision of the newest pipeline whose workflows all succeeded', async () => {
    mockApi([pipeline('running'), pipeline('done')], {
      running: ['running', 'success'],
      done: ['success', 'on_hold'],
    })

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBe('rev-done')
  })

  it('skips pipelines without a vcs revision', async () => {
    mockApi([pipeline('no-vcs', { vcs: undefined }), pipeline('done')], {
      'no-vcs': ['success'],
      done: ['success'],
    })

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBe('rev-done')
  })

  it('skips scheduled pipelines', async () => {
    mockApi(
      [pipeline('scheduled', { trigger: { type: 'scheduled_pipeline' } }), pipeline('done')],
      {
        scheduled: ['success'],
        done: ['success'],
      },
    )

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBe('rev-done')
  })

  it('returns undefined when no pipeline qualifies', async () => {
    mockApi([pipeline('no-vcs', { vcs: undefined })], { 'no-vcs': ['success'] })

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBeUndefined()
  })
})
