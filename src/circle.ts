import axios from 'axios'

import { requireEnv } from './env'

const CIRCLE_API_URL = 'https://circleci.com/api/v3'

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
    // for every pipeline type
    const { data: runs } = await axios.get<CircleRuns>(`${CIRCLE_API_URL}/runs`, {
      headers: { Authorization: `Bearer ${circleToken}` },
      params: { 'filter[project_id]': projectId, 'page[limit]': 20 },
    })

    const lastSuccessfulRun = runs.data.find(
      (run) =>
        run.references?.event?.attributes?.vcs?.branch === branch &&
        run.attributes.phase === 'ended' &&
        run.attributes.current_outcome === 'succeeded',
    )

    return lastSuccessfulRun?.references?.event?.attributes?.vcs?.revision
  } catch (e) {
    console.log(`Failed to call Circle API v3 with error: ${e.message}`)
  }
}
