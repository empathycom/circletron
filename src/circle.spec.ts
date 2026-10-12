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

  it('follows the page cursor until a run on the branch ended successfully', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({
        data: { data: [run('pr', 'feature', 'ended', 'succeeded')], page: { next: 'cursor-2' } },
      })
      .mockResolvedValueOnce({
        data: { data: [run('done', 'main', 'ended', 'succeeded')], page: { next: 'cursor-3' } },
      })

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBe('done')
    expect(mockedAxios.get).toHaveBeenCalledTimes(2)
    expect(mockedAxios.get.mock.calls[1][1]?.params).toEqual({
      'filter[project_id]': 'project-uuid',
      'page[limit]': 20,
      'page[cursor]': 'cursor-2',
    })
  })

  it('stops after five pages', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { data: [run('pr', 'feature', 'ended', 'succeeded')], page: { next: 'more' } },
    })

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBeUndefined()
    expect(mockedAxios.get).toHaveBeenCalledTimes(5)
  })

  it('returns undefined when no run on the branch ended successfully', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { data: [run('failed', 'main', 'ended', 'failed')], page: { next: null } },
    })

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBeUndefined()
    expect(mockedAxios.get).toHaveBeenCalledTimes(1)
  })
})
