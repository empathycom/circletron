import {
  applyDecisionCommand,
  parseCommandOutput,
  parseDecisionCommand,
} from './decision-command'
import type { FilterDecision } from './dependency-change-filter'

const makeDecisions = (): FilterDecision[] => [
  {
    pkg: 'a-e2e',
    trigger: true,
    reason: 'server: packages/server/a.ts',
    dependencyChanges: [{ pkg: 'server', files: ['packages/server/a.ts'] }],
  },
  {
    pkg: 'b-e2e',
    trigger: true,
    reason: 'server: packages/server/a.ts',
    dependencyChanges: [{ pkg: 'server', files: ['packages/server/a.ts'] }],
  },
  { pkg: 'c-e2e', trigger: true, reason: 'own changes: packages/c-e2e/x.cy.ts' },
]

const command = (script: string, timeoutSeconds = 10) => ({
  run: `node -e '${script}'`,
  timeoutSeconds,
})

describe('applyDecisionCommand', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  afterAll(() => {
    warn.mockRestore()
    log.mockRestore()
  })

  it('skips only what the command explicitly skips', async () => {
    const decisions = makeDecisions()
    await applyDecisionCommand(
      command(
        'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);' +
          'if(i.sinceCommit!=="abc"||i.packages.length!==2)process.exit(3);' +
          'console.log(JSON.stringify({decisions:{"a-e2e":{skip:true,reason:"not exercised"},' +
          '"c-e2e":{skip:true,reason:"not asked"}}}))})',
      ),
      decisions,
      'abc',
    )
    expect(decisions.map((d) => [d.pkg, d.trigger, d.reason])).toEqual([
      ['a-e2e', false, 'not exercised'],
      ['b-e2e', true, 'server: packages/server/a.ts (command gave no decision)'],
      ['c-e2e', true, 'own changes: packages/c-e2e/x.cy.ts'],
    ])
  })

  it.each([
    ['a failing exit', command('process.exit(1)')],
    ['invalid output', command('console.log("nope")')],
    ['a timeout', command('setTimeout(()=>{},60000)', 0.2)],
  ])('keeps every decision on %s', async (_, failing) => {
    const decisions = makeDecisions()
    await applyDecisionCommand(failing, decisions, 'abc')
    expect(decisions).toEqual(makeDecisions())
    expect(warn).toHaveBeenCalled()
  })

  it('does not run the command when nothing is triggered by dependencies only', async () => {
    const decisions = [makeDecisions()[2]]
    await applyDecisionCommand(command('process.exit(1)'), decisions, 'abc')
    expect(decisions).toEqual([makeDecisions()[2]])
  })
})

describe('parseCommandOutput', () => {
  it('ignores decisions without a reason or with a non-boolean skip', () => {
    expect(
      parseCommandOutput(
        JSON.stringify({
          decisions: {
            a: { skip: true, reason: '' },
            b: { skip: 'yes', reason: 'x' },
            c: { skip: false, reason: 'runs' },
          },
        }),
        new Set(['a', 'b', 'c']),
      ),
    ).toEqual({ c: { skip: false, reason: 'runs' } })
  })
})

describe('parseDecisionCommand', () => {
  it('defaults the timeout', () => {
    expect(parseDecisionCommand({ run: 'gate' })).toEqual({ run: 'gate', timeoutSeconds: 180 })
  })

  it.each([{}, { run: ' ' }, { run: 'gate', timeoutSeconds: 0 }])('rejects %p', (raw) => {
    expect(() => parseDecisionCommand(raw)).toThrow()
  })
})
