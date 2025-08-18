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
  name: string
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
 * Determines which workflow should be preferred when deduplicating by name.
 * Prefers workflows with better status (success > on_hold > running > others).
 */
function shouldPreferWorkflow(candidate: CircleWorkflowItem, existing: CircleWorkflowItem): boolean {
  const statusPriority = {
    [CircleWorkflowStatus.Success]: 5,
    [CircleWorkflowStatus.OnHold]: 4,
    [CircleWorkflowStatus.Running]: 3,
    [CircleWorkflowStatus.NotRun]: 2,
    [CircleWorkflowStatus.Failed]: 1,
    [CircleWorkflowStatus.Error]: 1,
    [CircleWorkflowStatus.Failing]: 1,
    [CircleWorkflowStatus.Canceled]: 1,
    [CircleWorkflowStatus.Unauthorized]: 0,
  }

  const candidatePriority = statusPriority[candidate.status] || 0
  const existingPriority = statusPriority[existing.status] || 0

  return candidatePriority > existingPriority
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

      // for each pipeline, fetch the workflows and find the first one where after deduplication
      // by workflow name, at least one workflow from each type has 'success' or 'on hold' status.
      const lastSuccessfulBuild = await find(pipelineData.items, async (pipeline: CirclePipelineItem) => {
        if (pipeline.state === CirclePipelineState.Created) {
          const { data: workflowData } = await axios.get<CircleWorkflows>(
            `${CIRCLE_API_URL}/pipeline/${pipeline.id}/workflow`,
            { headers },
          )

          // Deduplicate workflows by name, keeping the one with the latest/best status
          const workflowMap = new Map<string, CircleWorkflowItem>()
          for (const workflow of workflowData.items) {
            const existing = workflowMap.get(workflow.name)
            if (!existing || shouldPreferWorkflow(workflow, existing)) {
              workflowMap.set(workflow.name, workflow)
            }
          }

          // Check if at least one workflow from each type passed (success or on hold)
          const uniqueWorkflows = Array.from(workflowMap.values())
          const successfulWorkflows = uniqueWorkflows.filter((workflow) =>
            [CircleWorkflowStatus.Success, CircleWorkflowStatus.OnHold].includes(workflow.status),
          )

          // At least one workflow from each unique type should pass
          return successfulWorkflows.length > 0 && successfulWorkflows.length === uniqueWorkflows.length
        } else {
          return false
        }
      })

      return lastSuccessfulBuild?.vcs.revision
    }
  } catch (e) {
    console.log(`Failed to call Circle API v2 with error: ${e.message}`)
  }
}
