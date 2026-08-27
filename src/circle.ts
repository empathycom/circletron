import axios from 'axios'

import { requireEnv } from './env'

const CIRCLE_API_URL = 'https://circleci.com/api/v2'

interface CirclePipelineError {
  type: string
  message: string
}

interface CirclePipelineVCSInfo {
  provider_name: 'GitHub' | 'Bitbucket'
  revision: string
}

enum CirclePipelineState {
  Created = 'created',
  Errored = 'errored',
  SetupPending = 'setup-pending',
  Setup = 'setup',
  Pending = 'pending',
}

interface CirclePipelineItem {
  id: string
  errors: CirclePipelineError[]
  state: CirclePipelineState
  vcs: CirclePipelineVCSInfo
}

interface CirclePipelines {
  items: CirclePipelineItem[]
}

enum CircleWorkflowStatus {
  Success = 'success',
  Running = 'running',
  NotRun = 'not_run',
  Failed = 'failed',
  Error = 'error',
  Failing = 'failing',
  OnHold = 'on_hold',
  Canceled = 'canceled',
  Unauthorized = 'unauthorized',
}

interface CircleWorkflowItem {
  id: string
  status: CircleWorkflowStatus
}

interface CircleWorkflows {
  items: CircleWorkflowItem[]
}

const CHANGE_BASE_WORKFLOW_STATUSES = [
  CircleWorkflowStatus.Success,
  CircleWorkflowStatus.OnHold,
  CircleWorkflowStatus.Running,
]

export const hasChangeBaseWorkflows = (statuses: CircleWorkflowStatus[]): boolean =>
  statuses.length > 0 &&
  statuses.every((status) => CHANGE_BASE_WORKFLOW_STATUSES.includes(status))

async function find<I>(
  items: I[],
  asyncCallback: (input: I) => Promise<boolean>,
): Promise<I | null> {
  for (const element of items) {
    const shouldReturn: boolean = await asyncCallback(element)
    if (shouldReturn) return element
  }

  return null
}

/**
 * Determines, for the current branch, the commit hash to diff against: the most
 * recent commit whose pipeline has not failed. A pipeline still in flight counts
 * — it already builds everything its own commit changed.
 *
 * @returns the commit to look for changes since, or undefined
 */
export async function getLastSuccessfulBuildRevisionOnBranch(
  branch: string,
): Promise<string | undefined> {
  try {
    // the build URL is of the form https://circleci.com/{project_slug}/{build_number}
    const buildUrl = requireEnv('CIRCLE_BUILD_URL')
    const slugAndBuildNumber: string | undefined = /circleci\.com\/(.*\/.*\/.*)\//.exec(
      buildUrl,
    )?.[1]

    // to access the API the user must specify an access token which is provided in the
    // 'Circle-Token' header
    const circleToken = requireEnv('CIRCLE_TOKEN')
    const headers = { 'Circle-Token': circleToken }

    if (slugAndBuildNumber) {
      // call the API for pipelines, this does not reveal which workflows within the pipelines
      // were successful or not
      const { data: pipelineData } = await axios.get<CirclePipelines>(
        `${CIRCLE_API_URL}/project/${slugAndBuildNumber}/pipeline`,
        {
          headers,
          params: {
            branch,
          },
        },
      )

      const currentPipelineId = process.env.CIRCLETRON_PIPELINE_ID
      const currentRevision = process.env.CIRCLE_SHA1

      const changeBaseBuild = await find(pipelineData.items, async (item) => {
        if (item.id === currentPipelineId || item.vcs.revision === currentRevision) {
          return false
        }

        if (item.state === CirclePipelineState.Errored) {
          return false
        }

        // no workflows to consult until the setup job continues the pipeline
        if (item.state !== CirclePipelineState.Created) {
          return true
        }

        const { data: workflowData } = await axios.get<CircleWorkflows>(
          `${CIRCLE_API_URL}/pipeline/${item.id}/workflow`,
          { headers },
        )

        return hasChangeBaseWorkflows(workflowData.items.map((workflow) => workflow.status))
      })

      return changeBaseBuild?.vcs.revision
    }
  } catch (e) {
    console.log(`Failed to call Circle API v2 with error: ${e.message}`)
  }
}
