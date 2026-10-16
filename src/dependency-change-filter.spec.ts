import { decideFilteredPackages, parseDependencyChangeFilter } from './dependency-change-filter'

const filter = {
  packages: /-e2e$/,
  ignoreChanges: ['**/*.spec.ts', '**/tests/**', '**/.eslintrc*', '**/circle.yml'],
}

const packages = [
  { name: 'server', location: 'packages/server', circleDependencies: [] },
  { name: 'web', location: 'packages/web', circleDependencies: [] },
  { name: 'lib', location: 'packages/lib', circleDependencies: [] },
  { name: 'other', location: 'packages/other', circleDependencies: [] },
  { name: 'app-e2e', location: 'packages/app-e2e', circleDependencies: ['server', 'web'] },
  { name: 'other-e2e', location: 'packages/other-e2e', circleDependencies: ['other'] },
]

const workspaceDependencies = {
  server: ['lib', 'express'],
  web: ['react'],
  lib: [],
  other: [],
  'app-e2e': ['cypress'],
  'other-e2e': [],
}

const decide = (changedFiles: string[], candidates = ['app-e2e', 'other-e2e', 'server']) =>
  decideFilteredPackages(
    filter,
    packages,
    workspaceDependencies,
    changedFiles,
    ['**/*.md'],
    new Set(candidates),
  )

describe('decideFilteredPackages', () => {
  it('skips a package whose dependencies changed only in ignored files', () => {
    expect(
      decide(['packages/server/src/user.spec.ts', 'packages/server/tests/factories.ts']),
    ).toEqual([
      {
        pkg: 'app-e2e',
        trigger: false,
        reason:
          'dependencies changed only in files matching ignoreChanges: server: ' +
          'packages/server/src/user.spec.ts, packages/server/tests/factories.ts',
      },
      {
        pkg: 'other-e2e',
        trigger: true,
        reason: 'affected according to lerna, but no matching changed files were found',
      },
    ])
  })

  it('runs a package when a dependency changed app code', () => {
    const [decision] = decide(['packages/server/src/user.spec.ts', 'packages/server/src/user.ts'])
    expect(decision).toEqual({
      pkg: 'app-e2e',
      trigger: true,
      reason: 'server: packages/server/src/user.ts',
      dependencyChanges: [{ pkg: 'server', files: ['packages/server/src/user.ts'] }],
    })
  })

  it('follows workspace dependencies transitively', () => {
    const [decision] = decide(['packages/lib/index.ts'])
    expect(decision).toEqual({
      pkg: 'app-e2e',
      trigger: true,
      reason: 'lib: packages/lib/index.ts',
      dependencyChanges: [{ pkg: 'lib', files: ['packages/lib/index.ts'] }],
    })
  })

  it('always runs a package on changes in its own directory, ignored or not', () => {
    const [decision] = decide(['packages/app-e2e/.eslintrc.json'])
    expect(decision).toEqual({
      pkg: 'app-e2e',
      trigger: true,
      reason: 'own changes: packages/app-e2e/.eslintrc.json',
    })
  })

  it('does not count lerna.json ignoreChanges as own changes', () => {
    const [decision] = decide(['packages/app-e2e/README.md', 'packages/web/Button.spec.ts'])
    expect(decision.trigger).toBe(false)
  })

  it('only decides for affected packages matching the filter', () => {
    expect(decide(['packages/server/src/user.ts'], ['server', 'web']).map((d) => d.pkg)).toEqual(
      [],
    )
  })

  it('does not treat a sibling directory with a shared prefix as the package', () => {
    const [decision] = decide(['packages/server-tools/src/index.ts'], ['app-e2e'])
    expect(decision.trigger).toBe(true)
    expect(decision.reason).toMatch(/no matching changed files/)
  })

  it('lists at most five files per package', () => {
    const files = Array.from({ length: 7 }, (_, i) => `packages/web/src/f${i}.ts`)
    const [decision] = decide(files)
    expect(decision.reason).toMatch(/f4\.ts \(\+2 more\)$/)
  })
})

describe('parseDependencyChangeFilter', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  afterAll(() => warn.mockRestore())

  it('is disabled when not configured', () => {
    expect(parseDependencyChangeFilter(undefined)).toBeUndefined()
  })

  it('parses the regex and globs', () => {
    expect(
      parseDependencyChangeFilter({ packages: '-e2e$', ignoreChanges: ['*.spec.ts'] }),
    ).toEqual({ packages: /-e2e$/, ignoreChanges: ['*.spec.ts'] })
  })

  it.each([
    null,
    { packages: '-e2e$' },
    { packages: '-e2e$', ignoreChanges: [] },
    { packages: '-e2e$', ignoreChanges: [''] },
    { packages: '(', ignoreChanges: ['*.spec.ts'] },
  ])('ignores an invalid filter: %p', (raw) => {
    expect(parseDependencyChangeFilter(raw)).toBeUndefined()
  })
})
