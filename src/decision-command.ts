import { spawn } from 'child_process'

import type { FilterDecision } from './dependency-change-filter'

export interface DecisionCommand {
  run: string
  timeoutSeconds: number
}

export interface DecisionCommandInput {
  sinceCommit: string
  packages: { name: string; dependencyChanges: { pkg: string; files: string[] }[] }[]
}

type CommandDecisions = Record<string, { skip: boolean; reason: string }>

const DEFAULT_TIMEOUT_SECONDS = 180
const MAX_OUTPUT_BYTES = 1024 * 1024

export function parseDecisionCommand(raw: unknown): DecisionCommand | undefined {
  if (raw === undefined) {
    return undefined
  }
  const { run, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS } = (raw ?? {}) as {
    run?: unknown
    timeoutSeconds?: unknown
  }
  if (typeof run !== 'string' || !run.trim()) {
    throw new Error('dependencyChangeFilter.command.run must be a non-empty string')
  }
  if (typeof timeoutSeconds !== 'number' || !(timeoutSeconds > 0)) {
    throw new Error('dependencyChangeFilter.command.timeoutSeconds must be a positive number')
  }
  return { run, timeoutSeconds }
}

export function runDecisionCommand(
  command: DecisionCommand,
  input: DecisionCommandInput,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // the command's stderr is its log: pass it through to the job output
    const proc = spawn('sh', ['-c', command.run], {
      stdio: ['pipe', 'pipe', 'inherit'],
      // own process group, so a timeout also kills what the shell started
      detached: true,
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        try {
          process.kill(-(proc.pid as number), 'SIGKILL')
        } catch (e) {
          // the group already exited
        }
        reject(error)
      } else {
        resolve(Buffer.concat(chunks).toString())
      }
    }
    const timer = setTimeout(
      () => settle(new Error(`timed out after ${command.timeoutSeconds}s`)),
      command.timeoutSeconds * 1000,
    )

    proc.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT_BYTES) {
        settle(new Error(`printed more than ${MAX_OUTPUT_BYTES} bytes`))
      } else {
        chunks.push(chunk)
      }
    })
    proc.on('error', (e) => settle(e))
    proc.on('close', (code, signal) =>
      code === 0 ? settle() : settle(new Error(`exited with ${signal ?? `code ${code}`}`)),
    )
    proc.stdin.on('error', () => undefined)
    proc.stdin.end(JSON.stringify(input))
  })
}

export function parseCommandOutput(output: string, asked: Set<string>): CommandDecisions {
  const parsed = JSON.parse(output) as { decisions?: unknown }
  const decisions = parsed?.decisions
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
    throw new Error('output has no `decisions` object')
  }
  const valid: CommandDecisions = {}
  for (const [name, value] of Object.entries(decisions as Record<string, unknown>)) {
    const { skip, reason } = (value ?? {}) as { skip?: unknown; reason?: unknown }
    // only an explicit, explained skip of a package it was asked about counts
    if (asked.has(name) && typeof skip === 'boolean' && typeof reason === 'string' && reason) {
      valid[name] = { skip, reason }
    }
  }
  return valid
}

/**
 * Ask the command whether packages triggered only by dependency changes can
 * be skipped. Any failure leaves every decision as it was.
 */
export async function applyDecisionCommand(
  command: DecisionCommand,
  decisions: FilterDecision[],
  sinceCommit: string,
): Promise<void> {
  const candidates = decisions.filter((d) => d.trigger && d.dependencyChanges?.length)
  if (!candidates.length) {
    return
  }
  const input: DecisionCommandInput = {
    sinceCommit,
    packages: candidates.map((d) => ({
      name: d.pkg,
      dependencyChanges: d.dependencyChanges ?? [],
    })),
  }
  console.log(
    `dependencyChangeFilter: asking \`${command.run}\` about ${candidates.length} packages`,
  )
  let answers: CommandDecisions
  try {
    answers = parseCommandOutput(
      await runDecisionCommand(command, input),
      new Set(candidates.map((d) => d.pkg)),
    )
  } catch (e) {
    console.warn(
      `Warning: dependencyChangeFilter command failed, running every affected package: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return
  }
  for (const decision of candidates) {
    const answer = answers[decision.pkg]
    if (!answer) {
      decision.reason += ' (command gave no decision)'
    } else if (answer.skip) {
      decision.trigger = false
      decision.reason = answer.reason
    } else {
      decision.reason = answer.reason
    }
  }
}
