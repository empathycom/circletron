import axios from 'axios'

import { getLastSuccessfulBuildRevisionOnBranch } from './circle'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const run = (
  id: string,
  {
    phase = 'ended',
    outcome = 'succeeded',
    type = 'push',
    branch = 'main',
    revision = `rev-${id}`,
  }: {
    phase?: string
    outcome?: string
    type?: string
    branch?: string
    revision?: string
  } = {},
) => ({
  id,
  attributes: { phase, current_outcome: outcome },
  references: { event: { attributes: { type, vcs: { branch, revision } } } },
})

const mockPages = (...pages: { data: unknown[]; page?: { next: string | null } }[]) => {
  pages.forEach((page) => mockedAxios.get.mockResolvedValueOnce({ data: page }))
}

describe('getLastSuccessfulBuildRevisionOnBranch', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, CIRCLE_PROJECT_ID: 'project-uuid', CIRCLE_TOKEN: 'token' }
    mockedAxios.get.mockReset()
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('queries the v3 runs API for the project with a bearer token', async () => {
    mockPages({ data: [run('done')], page: { next: null } })

    await getLastSuccessfulBuildRevisionOnBranch('main')

    expect(mockedAxios.get).toHaveBeenCalledWith('https://circleci.com/api/v3/runs', {
      headers: { Authorization: 'Bearer token' },
      params: { 'filter[project_id]': 'project-uuid', 'page[limit]': 20 },
    })
  })

  it('returns the revision of the newest run on the branch that ended successfully', async () => {
    mockPages({
      data: [
        run('running', { phase: 'started', outcome: '' }),
        run('failed', { outcome: 'failed' }),
        run('other-branch', { branch: 'feature' }),
        run('done'),
        run('older'),
      ],
    })

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBe('rev-done')
  })

  it('skips scheduled runs', async () => {
    mockPages({ data: [run('scheduled', { type: 'schedule' }), run('done')] })

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBe('rev-done')
  })

  it('skips runs without a revision', async () => {
    mockPages({ data: [run('no-revision', { revision: '' }), run('done')] })

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBe('rev-done')
  })

  it('follows the page cursor until a run qualifies', async () => {
    mockPages(
      { data: [run('running', { phase: 'started' })], page: { next: 'cursor-2' } },
      { data: [run('done')], page: { next: null } },
    )

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBe('rev-done')
    expect(mockedAxios.get.mock.calls[1][1]?.params).toMatchObject({ 'page[cursor]': 'cursor-2' })
  })

  it('returns undefined when no run qualifies', async () => {
    mockPages({ data: [run('failed', { outcome: 'failed' })], page: { next: null } })

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBeUndefined()
  })

  it('returns undefined when the API call fails', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('boom'))

    await expect(getLastSuccessfulBuildRevisionOnBranch('main')).resolves.toBeUndefined()
  })
})
