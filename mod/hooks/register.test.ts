import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

// Stands in for the engine and the overlay: records each reaction the mod posts.
function world(on: On, { isOverlayUp = true, isToolError = false } = {}) {
  const sent: string[] = []
  const launched: string[][] = []
  const checkIns: boolean[] = []
  const busy: boolean[] = []
  mock.clock(on)
  on('http.fetch', ($, e) => {
    if (!isOverlayUp) throw new Error('connection refused')
    if (e.url.endsWith('/event')) sent.push(JSON.parse(String(e.init?.body)).kind)
    if (e.url.endsWith('/session')) checkIns.push(JSON.parse(String(e.init?.body)).open)
    if (e.url.endsWith('/busy')) busy.push(JSON.parse(String(e.init?.body)).busy)
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  on('process.run', ($, e) => {
    launched.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('turn.start', ($, e) => ({ text: e.text, turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('classic.StopFailure', () => ({}) as never)
  on('classic.PermissionRequest', () => ({}) as never)
  on('tool.call', () => ({ result: { interrupted: false }, text: 'ok', isError: isToolError }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  return { sent, launched, checkIns, busy }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const turn = (reason: 'answer' | 'error' | 'aborted', durationMs: number, agentId?: string) =>
  ({ reason, durationMs, answer: '', isAborted: reason === 'aborted', turnId: 't1', agentId }) as never

describe('waifufy', () => {
  test('a long answered turn is a success', async ($, on) => {
    const { sent } = world(on)
    await $.turn.complete(turn('answer', 20_000))
    await settle()
    expect(sent).toEqual(['success'])
  })

  test('a quick reply, an interrupt and a subagent turn stay quiet', async ($, on) => {
    const { sent } = world(on)
    await $.turn.complete(turn('answer', 1_000))
    await $.turn.complete(turn('aborted', 20_000))
    await $.turn.complete(turn('answer', 20_000, 'sub-1'))
    await settle()
    expect(sent).toEqual([])
  })

  test('an API error is one failure, not two', async ($, on) => {
    const { sent } = world(on)
    await $.turn.complete(turn('error', 20_000))
    await $.classic.StopFailure({ error: 'server_error' } as never)
    await settle()
    expect(sent).toEqual(['fail'])
  })

  test('permission prompts and questions ask for confirmation', async ($, on) => {
    const { sent } = world(on)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } } as never)
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
    await settle()
    expect(sent).toEqual(['confirm', 'confirm'])
  })

  test('toggles turn a reaction off', { options: { onSuccess: false } }, async ($, on) => {
    const { sent } = world(on)
    await $.turn.complete(turn('answer', 20_000))
    await settle()
    expect(sent).toEqual([])
  })

  test('a missing overlay gets launched', async ($, on) => {
    const { launched } = world(on, { isOverlayUp: false })
    await $.turn.complete(turn('answer', 20_000))
    await settle()
    expect(launched[0]?.slice(0, 3)).toEqual(['cmd', '/c', 'start'])
  })

  const start = (surface: 'terminal' | 'desktop' | null, isInteractive: boolean) =>
    ({ cwd: 'C:/', surface, isInteractive }) as never
  const end = (reason: string) => ({ reason, sessionId: 's1', resume: {} }) as never

  test('a CLI session checks in, then checks out when it exits', async ($, on) => {
    const { checkIns } = world(on)
    await $.session.start(start('terminal', true))
    await settle()
    await $.session.end(end('prompt_input_exit'))
    await settle()
    expect(checkIns).toEqual([true, false])
  })

  test('/clear and /resume keep the CLI session checked in', async ($, on) => {
    const { checkIns } = world(on)
    await $.session.start(start('terminal', true))
    await settle()
    await $.session.end(end('clear'))
    await $.session.end(end('resume'))
    await settle()
    expect(checkIns).toEqual([true])
  })

  test('desktop and -p sessions never check in', async ($, on) => {
    const { checkIns } = world(on)
    await $.session.start(start('desktop', true))
    await $.session.start(start(null, false))
    await settle()
    await $.session.end(end('other'))
    await settle()
    expect(checkIns).toEqual([])
  })

  const shell = (command: string, tool = 'Bash') => ({ tool, command }) as never

  test('a git push that goes through is reported', async ($, on) => {
    const { sent } = world(on)
    await $.tool.call(shell('git push -u origin main'))
    await $.tool.call(shell('git push', 'PowerShell'))
    await $.tool.call(shell('git status'))
    await settle()
    expect(sent).toEqual(['push', 'push'])
  })

  test('a failed git push stays quiet', async ($, on) => {
    const { sent } = world(on, { isToolError: true })
    await $.tool.call(shell('git push'))
    await settle()
    expect(sent).toEqual([])
  })

  test('destructive commands get a warning', async ($, on) => {
    const { sent } = world(on)
    for (const command of ['git reset --hard HEAD~1', 'git clean -fd', 'git branch -D old', 'rm -rf build', 'git checkout -- .']) {
      await $.tool.call(shell(command))
      await settle()
    }
    await $.tool.call(shell('git reset --soft HEAD~1'))
    await $.tool.call(shell('rm notes.txt'))
    await settle()
    // The overlay dedupes repeats; the mod reports each one.
    expect(sent).toEqual(['danger', 'danger', 'danger', 'danger', 'danger'])
  })

  test('a main-loop turn marks the session busy until it completes', async ($, on) => {
    const { busy } = world(on)
    await $.turn.start({ text: 'hi', turnId: 't1' } as never)
    await $.turn.start({ text: '', turnId: 't2', agentId: 'sub-1' } as never)
    await $.turn.complete(turn('answer', 1_000))
    await settle()
    expect(busy).toEqual([true, false])
  })
})
