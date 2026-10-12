import axios from 'axios'

import { getLastSuccessfulBuildRevisionOnBranch } from './circle'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const run = (revision: string, branch: string, phase: string, outcome: string | null) => ({
  attributes: { phase, current_outcome: outcome },
  references: { event: { attributes: { vcs: { branch, revision } } } },
})

describe('getLastSuccessfulBuildRevisionOnBranch', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, CIRCLE_PROJECT_ID: 'project-uuid', CIRCLE_TOKEN: 'token' }
    mockedAxios.get.mockReset()
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('returns the revision of the newest run on the branch that ended successfully', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: [
          run('running', 'main', 'started', null),
          run('failing', 'main', 'started', 'failed'),
          run('pr', 'feature', 'ended', 'succeeded'),
          run('done', 'main', 'ended', 'succeeded'),
          run('older', 'main', 'ended', 'succeeded'),
        ],
      },
    })

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBe('done')
    expect(mockedAxios.get).toHaveBeenCalledWith('https://circleci.com/api/v3/runs', {
      headers: { Authorization: 'Bearer token' },
      params: { 'filter[project_id]': 'project-uuid', 'page[limit]': 20 },
    })
  })

  it('returns undefined when no run on the branch ended successfully', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { data: [run('failed', 'main', 'ended', 'failed')] },
    })

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBeUndefined()
  })
})
