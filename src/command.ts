import { spawn } from 'child_process'

export const spawnGetStdout = (cmd: string, args: string[]): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

    proc.on('close', (code) => {
      if (!code) {
        resolve(Buffer.concat(stdout).toString())
      } else {
        reject(Buffer.concat(stderr).toString())
      }
    })
  })
}
