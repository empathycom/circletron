import axios from 'axios'

import { getLastSuccessfulBuildRevisionOnBranch, hasChangeBaseWorkflows } from './circle'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const CURRENT_PIPELINE_ID = 'pipeline-current'
const CURRENT_SHA = 'sha-current'

interface TestPipeline {
  id: string
  revision: string
  state?: string
  workflowStatuses?: string[]
}

const mockPipelines = (pipelines: TestPipeline[]) => {
  mockedAxios.get.mockImplementation((url: string) => {
    if (url.endsWith('/pipeline')) {
      return Promise.resolve({
        data: {
          items: pipelines.map(({ id, revision, state = 'created' }) => ({
            id,
            errors: [],
            state,
            vcs: { provider_name: 'GitHub', revision },
          })),
        },
      })
    }

    const pipelineId = /\/pipeline\/(.*)\/workflow/.exec(url)?.[1]
    const pipeline = pipelines.find(({ id }) => id === pipelineId)
    return Promise.resolve({
      data: {
        items: (pipeline?.workflowStatuses ?? []).map((status, idx) => ({
          id: `${pipelineId}-workflow-${idx}`,
          status,
        })),
      },
    })
  })
}

describe('hasChangeBaseWorkflows', () => {
  it('accepts pipelines that have not failed', () => {
    expect(hasChangeBaseWorkflows(['success', 'on_hold', 'running'] as never)).toBe(true)
  })

  it.each(['failed', 'error', 'failing', 'canceled', 'unauthorized', 'not_run'])(
    'rejects a pipeline containing a %s workflow',
    (status) => {
      expect(hasChangeBaseWorkflows(['success', status] as never)).toBe(false)
    },
  )

  it('rejects a pipeline with no workflows', () => {
    expect(hasChangeBaseWorkflows([])).toBe(false)
  })
})

describe('getLastSuccessfulBuildRevisionOnBranch', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.resetAllMocks()
    process.env = {
      ...originalEnv,
      CIRCLE_BUILD_URL: 'https://circleci.com/gh/empathycom/empathy-monorepo/1234',
      CIRCLE_TOKEN: 'circle-token',
      CIRCLE_SHA1: CURRENT_SHA,
      CIRCLETRON_PIPELINE_ID: CURRENT_PIPELINE_ID,
    }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('uses a pipeline that is still running rather than walking past it', async () => {
    mockPipelines([
      { id: CURRENT_PIPELINE_ID, revision: CURRENT_SHA, workflowStatuses: ['running'] },
      { id: 'pipeline-in-flight', revision: 'sha-in-flight', workflowStatuses: ['running'] },
      { id: 'pipeline-green', revision: 'sha-green', workflowStatuses: ['success'] },
    ])

    expect(await getLastSuccessfulBuildRevisionOnBranch('main')).toEqual('sha-in-flight')
  })

  it('uses a pipeline whose setup job has not continued it yet', async () => {
    mockPipelines([
      { id: CURRENT_PIPELINE_ID, revision: CURRENT_SHA, state: 'setup' },
      { id: 'pipeline-in-setup', revision: 'sha-in-setup', state: 'setup-pending' },
      { id: 'pipeline-green', revision: 'sha-green', workflowStatuses: ['success'] },
    ])

    expect(await getLastSuccessfulBuildRevisionOnBranch('main')).toEqual('sha-in-setup')
  })

  it('walks past failed and errored pipelines', async () => {
    mockPipelines([
      { id: CURRENT_PIPELINE_ID, revision: CURRENT_SHA, workflowStatuses: ['running'] },
      { id: 'pipeline-failed', revision: 'sha-failed', workflowStatuses: ['success', 'failed'] },
      { id: 'pipeline-errored', revision: 'sha-errored', state: 'errored' },
      { id: 'pipeline-green', revision: 'sha-green', workflowStatuses: ['success', 'on_hold'] },
    ])

    expect(await getLastSuccessfulBuildRevisionOnBranch('main')).toEqual('sha-green')
  })

  it('never uses the pipeline it is running in', async () => {
    mockPipelines([
      { id: CURRENT_PIPELINE_ID, revision: CURRENT_SHA, workflowStatuses: ['success'] },
      { id: 'pipeline-green', revision: 'sha-green', workflowStatuses: ['success'] },
    ])

    expect(await getLastSuccessfulBuildRevisionOnBranch('main')).toEqual('sha-green')
  })

  it('never uses another pipeline built from the current commit', async () => {
    mockPipelines([
      { id: CURRENT_PIPELINE_ID, revision: CURRENT_SHA, workflowStatuses: ['running'] },
      { id: 'pipeline-rebuild', revision: CURRENT_SHA, workflowStatuses: ['success'] },
      { id: 'pipeline-green', revision: 'sha-green', workflowStatuses: ['success'] },
    ])

    expect(await getLastSuccessfulBuildRevisionOnBranch('main')).toEqual('sha-green')
  })

  it('returns undefined when every pipeline failed', async () => {
    mockPipelines([
      { id: CURRENT_PIPELINE_ID, revision: CURRENT_SHA, workflowStatuses: ['running'] },
      { id: 'pipeline-failed', revision: 'sha-failed', workflowStatuses: ['failed'] },
    ])

    expect(await getLastSuccessfulBuildRevisionOnBranch('main')).toBeUndefined()
  })

  it('returns undefined when the API call fails', async () => {
    mockedAxios.get.mockRejectedValue(new Error('boom'))

    expect(await getLastSuccessfulBuildRevisionOnBranch('main')).toBeUndefined()
  })
})
