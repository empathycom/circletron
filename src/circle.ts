import axios from 'axios'

import { requireEnv } from './env'

const CIRCLE_API_V3_URL = 'https://circleci.com/api/v3'
const RUNS_PAGE_LIMIT = 20
const MAX_RUN_PAGES = 5

interface CircleRunVcs {
  branch?: string
  revision?: string
}

interface CircleRun {
  id: string
  attributes: {
    phase: string
    current_outcome?: string
  }
  references?: {
    event?: {
      attributes?: {
        type?: string
        vcs?: CircleRunVcs
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

// scheduled runs only build the scheduled job's packages, so their success says nothing about
// the rest of the monorepo at that revision
const isFullSuccessfulRunOnBranch = (run: CircleRun, branch: string): boolean => {
  const event = run.references?.event?.attributes
  return (
    run.attributes.phase === 'ended' &&
    run.attributes.current_outcome === 'succeeded' &&
    event?.type !== 'schedule' &&
    event?.vcs?.branch === branch &&
    Boolean(event?.vcs?.revision)
  )
}

/**
 * Finds the commit of the newest run on `branch` that ended successfully, using the runs API
 * (v3). Unlike the v2 pipelines API it reports the revision for GitHub App pipelines as well as
 * GitHub OAuth ones.
 *
 * @returns last commit built successfully in Circle CI on the branch, or undefined
 */
export async function getLastSuccessfulBuildRevisionOnBranch(
  branch: string,
): Promise<string | undefined> {
  try {
    const projectId = requireEnv('CIRCLE_PROJECT_ID')
    const headers = { Authorization: `Bearer ${requireEnv('CIRCLE_TOKEN')}` }

    let cursor: string | undefined
    for (let page = 0; page < MAX_RUN_PAGES; ++page) {
      const { data: runs } = await axios.get<CircleRuns>(`${CIRCLE_API_V3_URL}/runs`, {
        headers,
        params: {
          'filter[project_id]': projectId,
          'page[limit]': RUNS_PAGE_LIMIT,
          ...(cursor && { 'page[cursor]': cursor }),
        },
      })

      const lastSuccessfulRun = runs.data.find((run) => isFullSuccessfulRunOnBranch(run, branch))
      if (lastSuccessfulRun) return lastSuccessfulRun.references?.event?.attributes?.vcs?.revision

      cursor = runs.page?.next ?? undefined
      if (!cursor) break
    }
  } catch (e) {
    console.log(`Failed to call Circle API v3 with error: ${e.message}`)
  }
}
