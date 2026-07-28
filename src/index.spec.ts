import { parse as yamlParse } from 'yaml'

import { buildConfiguration } from './index'

// derive the (internal) parameter shapes from the function signature instead of
// expanding the package's public type exports
type Packages = Parameters<typeof buildConfiguration>[0]
type CircletronConfig = Parameters<typeof buildConfiguration>[2]

const SKIP_JOB = {
  docker: [{ image: 'busybox:stable' }],
  steps: [{ run: { name: 'Jobs not required', command: 'echo "Jobs not required"' } }],
}

const baseConfig: CircletronConfig = {
  runOnlyChangedOnTargetBranches: true,
  targetBranchesRegex: /^main$/,
  passTargetBranch: false,
  skip: 'workflows',
  checkNames: {},
}

const makePackages = (): Packages => [
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
  it('replaces skipped workflows with the busybox skip workflow', async () => {
    const output = await buildConfiguration(makePackages(), new Set(['pkg-a']), baseConfig)
    const config = yamlParse(output)

    // untouched workflow for the triggered package
    expect(config.workflows['workflow-a']).toEqual({ jobs: ['test-a'] })
    expect(config.jobs['test-a']).toEqual({ docker: [{ image: 'node:16' }], steps: ['checkout'] })

    expect(config.workflows['workflow-b']).toEqual({ jobs: ['skip'] })
    expect(config.jobs.skip).toEqual(SKIP_JOB)
  })

  it('does not touch non-skipped workflows', async () => {
    const output = await buildConfiguration(
      makePackages(),
      new Set(['pkg-a', 'pkg-b']),
      baseConfig,
    )
    const config = yamlParse(output)
    expect(config.workflows['workflow-a']).toEqual({ jobs: ['test-a'] })
    expect(config.workflows['workflow-b']).toEqual({ jobs: ['test-b'] })
  })
})

describe('buildConfiguration with skip: check-runs', () => {
  const checkRunsConfig: CircletronConfig = { ...baseConfig, skip: 'check-runs' }

  it('omits skipped workflows and their jobs entirely', async () => {
    const output = await buildConfiguration(makePackages(), new Set(['pkg-a']), checkRunsConfig)
    const config = yamlParse(output)

    expect(config.workflows).toEqual({ 'workflow-a': { jobs: ['test-a'] } })
    expect(config.jobs).toEqual({
      'test-a': { docker: [{ image: 'node:16' }], steps: ['checkout'] },
    })
  })

  it('degrades workflows whose check run could not be posted to skip workflows', async () => {
    const output = await buildConfiguration(
      makePackages(),
      new Set(['pkg-a']),
      checkRunsConfig,
      new Set(['workflow-b']),
    )
    const config = yamlParse(output)

    expect(config.workflows['workflow-a']).toEqual({ jobs: ['test-a'] })
    expect(config.workflows['workflow-b']).toEqual({ jobs: ['skip'] })
    expect(config.jobs.skip).toEqual(SKIP_JOB)
  })

  it('emits a single no-op skip workflow when everything is skipped', async () => {
    const output = await buildConfiguration(makePackages(), new Set(), checkRunsConfig)
    const config = yamlParse(output)

    expect(config.workflows).toEqual({ skip: { jobs: ['skip'] } })
    expect(config.jobs).toEqual({ skip: SKIP_JOB })
  })
})
