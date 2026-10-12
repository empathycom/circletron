import axios from 'axios'

import { requireEnv } from './env'

const CIRCLE_API_URL = 'https://circleci.com/api/v2'
const SCHEDULED_PIPELINE_TRIGGER = 'scheduled_pipeline'

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

interface CirclePipelineTrigger {
  type: string
}

// some pipelines, e.g. scheduled ones, carry no `vcs` block
interface CirclePipelineItem {
  id: string
  errors: CirclePipelineError[]
  state: CirclePipelineState
  trigger?: CirclePipelineTrigger
  vcs?: CirclePipelineVCSInfo
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
 * This method determines, for the current branch, the commit hash of the last
 * build executed within Circle CI, by calling the API.
 *
 * @returns last commit built in Circle CI on the current branch, or undefined
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

      // for each pipeline, fetch the workflows and find the first one where all the workflows have a
      // 'success' or 'on hold' status.
      const lastSuccessfulBuild = await find(pipelineData.items, async (item) => {
        // scheduled pipelines only run the scheduled job's packages, so their success says
        // nothing about the rest of the monorepo at that revision
        if (
          item.state === CirclePipelineState.Created &&
          item.vcs?.revision &&
          item.trigger?.type !== SCHEDULED_PIPELINE_TRIGGER
        ) {
          const { data: workflowData } = await axios.get<CircleWorkflows>(
            `${CIRCLE_API_URL}/pipeline/${item.id}/workflow`,
            { headers },
          )

          return workflowData.items.every((item) =>
            [CircleWorkflowStatus.Success, CircleWorkflowStatus.OnHold].includes(item.status),
          )
        } else {
          return false
        }
      })

      return lastSuccessfulBuild?.vcs?.revision
    }
  } catch (e) {
    console.log(`Failed to call Circle API v2 with error: ${e.message}`)
  }
}
