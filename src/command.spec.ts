import { spawnGetStdout } from './command'

describe('spawnGetStdout', () => {
  it('keeps a multibyte character split across output chunks', async () => {
    const script = [
      "const bytes = Buffer.from('packages/café-e2e/src/index.ts')",
      'const split = bytes.indexOf(0xc3) + 1',
      'process.stdout.write(bytes.subarray(0, split))',
      'setTimeout(() => process.stdout.write(bytes.subarray(split)), 50)',
    ].join(';')

    await expect(spawnGetStdout(process.execPath, ['-e', script])).resolves.toBe(
      'packages/café-e2e/src/index.ts',
    )
  })

  it('rejects with stderr on a non-zero exit', async () => {
    await expect(
      spawnGetStdout(process.execPath, ['-e', "process.stderr.write('boom'); process.exit(2)"]),
    ).rejects.toBe('boom')
  })
})
