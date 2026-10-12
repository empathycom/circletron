import axios from 'axios'

import { requireEnv } from './env'

const CIRCLE_API_URL = 'https://circleci.com/api/v3'
const RUNS_PAGE_LIMIT = 20
const MAX_RUN_PAGES = 5

interface CircleRun {
  attributes: {
    phase: string
    current_outcome?: string
  }
  references?: {
    event?: {
      attributes?: {
        vcs?: {
          branch?: string
          revision?: string
        }
      }
    }
  }
}

interface CircleRuns {
  data: CircleRun[]
  page?: {
    next?: string | null
  }
}

/**
 * This method determines, for the current branch, the commit hash of the last
 * build executed within Circle CI, by calling the API.
 *
 * @returns last commit built in Circle CI on the current branch, or undefined
 */
export async function getLastSuccessfulBuildRevisionOnBranch(
  branch: string,
): Promise<string | undefined> {
  try {
    const projectId = requireEnv('CIRCLE_PROJECT_ID')
    const circleToken = requireEnv('CIRCLE_TOKEN')

    // the v2 pipelines API omits the `vcs` block for GitHub App pipelines, runs (v3) carry it
    // for every pipeline type. Runs can't be filtered by branch, so page through them.
    let cursor: string | undefined
    for (let page = 0; page < MAX_RUN_PAGES; ++page) {
      const { data: runs } = await axios.get<CircleRuns>(`${CIRCLE_API_URL}/runs`, {
        headers: { Authorization: `Bearer ${circleToken}` },
        params: {
          'filter[project_id]': projectId,
          'page[limit]': RUNS_PAGE_LIMIT,
          ...(cursor && { 'page[cursor]': cursor }),
        },
      })

      const lastSuccessfulRun = runs.data.find(
        (run) =>
          run.references?.event?.attributes?.vcs?.branch === branch &&
          run.attributes.phase === 'ended' &&
          run.attributes.current_outcome === 'succeeded',
      )
      if (lastSuccessfulRun) return lastSuccessfulRun.references?.event?.attributes?.vcs?.revision

      cursor = runs.page?.next ?? undefined
      if (!cursor) break
    }
  } catch (e) {
    console.log(`Failed to call Circle API v3 with error: ${e.message}`)
  }
}
