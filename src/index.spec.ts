import { parse as yamlParse } from 'yaml'

import { buildConfiguration, CircletronConfig, Package } from './index'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json')

const baseConfig: CircletronConfig = {
  runOnlyChangedOnTargetBranches: true,
  targetBranchesRegex: /^main$/,
  passTargetBranch: false,
  skip: 'workflows',
  skipIndication: false,
}

const makePackages = (): Package[] => [
  {
    name: 'pkg-a',
    circleConfig: {
      jobs: {
        'test-a': { docker: [{ image: 'node:16' }], steps: ['checkout'] },
      },
      workflows: {
        'workflow-a': { jobs: ['test-a'] },
      },
    },
  },
  {
    name: 'pkg-b',
    circleConfig: {
      jobs: {
        'test-b': { docker: [{ image: 'node:16' }], steps: ['checkout'] },
      },
      workflows: {
        'workflow-b': { jobs: ['test-b'] },
      },
    },
  },
]

describe('buildConfiguration with skip: workflows', () => {
  it('replaces skipped workflows with the plain skip job when skipIndication is off', async () => {
    const output = await buildConfiguration(makePackages(), new Set(['pkg-a']), baseConfig)
    const config = yamlParse(output)

    expect(config.workflows['workflow-a']).toEqual({ jobs: ['test-a'] })
    expect(config.workflows['workflow-b']).toEqual({ jobs: ['skip'] })
    expect(config.jobs.skip).toEqual({
      docker: [{ image: 'busybox:stable' }],
      steps: [
        {
          run: {
            name: 'Jobs not required',
            command: 'echo "Jobs not required"',
          },
        },
      ],
    })
  })

  it('produces identical output when skipIndication is explicitly false', async () => {
    const withoutOption = await buildConfiguration(makePackages(), new Set(['pkg-a']), baseConfig)
    const withFalseOption = await buildConfiguration(makePackages(), new Set(['pkg-a']), {
      ...baseConfig,
      skipIndication: false,
    })
    expect(withFalseOption).toEqual(withoutOption)
  })

  it('generates a skip job that reports skips when skipIndication is on', async () => {
    const output = await buildConfiguration(makePackages(), new Set(['pkg-a']), {
      ...baseConfig,
      skipIndication: true,
    })
    const config = yamlParse(output)

    // untouched workflow for the triggered package
    expect(config.workflows['workflow-a']).toEqual({ jobs: ['test-a'] })
    expect(config.jobs['test-a']).toEqual({ docker: [{ image: 'node:16' }], steps: ['checkout'] })

    // the skipped workflow passes its name to the skip job
    expect(config.workflows['workflow-b']).toEqual({
      jobs: [{ skip: { 'workflow-name': 'workflow-b' } }],
    })

    const skipJob = config.jobs.skip
    expect(skipJob.parameters).toEqual({
      'workflow-name': { type: 'string', default: '' },
    })
    expect(skipJob.docker).toEqual([{ image: `circletron/circletron:${version}` }])
    expect(skipJob.environment).toEqual({
      CIRCLETRON_PIPELINE_ID: '<< pipeline.id >>',
      CIRCLETRON_PIPELINE_NUMBER: '<< pipeline.number >>',
    })
    expect(skipJob.steps).toEqual([
      {
        run: {
          name: 'Jobs not required',
          command:
            'circletron report-skip --workflow "<< parameters.workflow-name >>" --reason unaffected',
        },
      },
      {
        store_artifacts: {
          path: '/tmp/circletron/skip.json',
          destination: 'circletron/skip.json',
        },
      },
    ])
  })

  it('does not touch non-skipped workflows when skipIndication is on', async () => {
    const output = await buildConfiguration(makePackages(), new Set(['pkg-a', 'pkg-b']), {
      ...baseConfig,
      skipIndication: true,
    })
    const config = yamlParse(output)
    expect(config.workflows['workflow-a']).toEqual({ jobs: ['test-a'] })
    expect(config.workflows['workflow-b']).toEqual({ jobs: ['test-b'] })
  })
})
