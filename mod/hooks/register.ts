import type { EngineInterface as Engine, PluginOptions, Register, Timer } from 'claude-code'

type Kind = 'success' | 'fail' | 'confirm'

const RETRY_MS = 2500
// A turn that dies on an API error raises both turn.complete and StopFailure.
const FAIL_DEDUPE_MS = 3000
const TOGGLE: Record<Kind, string> = { success: 'onSuccess', fail: 'onFail', confirm: 'onConfirm' }
// Well inside the overlay's 60 s timeout, so a live CLI session never lapses.
const HEARTBEAT_MS = 20_000
// The process carries on after these, so the overlay should stay.
const KEEPS_PROCESS = new Set(['clear', 'resume'])

let lastFailAt = 0
// This CLI process, as the overlay counts it; a reload picks a new one and the old one times out.
const sessionKey = Math.random().toString(36).slice(2)
let heartbeat: Timer | undefined

function baseUrl(options: PluginOptions) {
  return `http://127.0.0.1:${options.port}`
}

function launch($: Engine, options: PluginOptions) {
  return $.process.run(['cmd', '/c', 'start', '', String(options.overlayExe)], { timeoutMs: 5000 }).catch(() => undefined)
}

async function post($: Engine, options: PluginOptions, kind: Kind) {
  const res = await $.http.fetch(`${baseUrl(options)}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind }),
  })
  if (!res.ok) throw new Error(`overlay answered ${res.status}`)
}

// Tells the overlay this CLI session is open or gone; it quits when the last one goes.
function checkIn($: Engine, options: PluginOptions, open: boolean) {
  return $.http
    .fetch(`${baseUrl(options)}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: sessionKey, open }),
    })
    .catch(() => undefined)
}

// Never awaited by a hook: the overlay is a nicety and must not slow or break a session.
function send($: Engine, options: PluginOptions, kind: Kind) {
  if (options[TOGGLE[kind]] !== true) return
  if (kind === 'fail') {
    if (Date.now() - lastFailAt < FAIL_DEDUPE_MS) return
    lastFailAt = Date.now()
  }
  void post($, options, kind).catch(async () => {
    await launch($, options)
    $.clock.after(RETRY_MS, () => void post($, options, kind).catch(() => undefined))
  })
}

export const register: Register = (on, options) => {
  on('session.start', ($, e, next) => {
    const isCli = e.surface === 'terminal' && e.isInteractive
    void $.http
      .fetch(`${baseUrl(options)}/health`)
      .then(() => (isCli ? checkIn($, options, true) : undefined))
      .catch(async () => {
        await launch($, options)
        if (isCli) $.clock.after(RETRY_MS, () => void checkIn($, options, true))
      })
    if (isCli) {
      heartbeat?.cancel()
      heartbeat = $.clock.every(HEARTBEAT_MS, () => void checkIn($, options, true))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (heartbeat && !KEEPS_PROCESS.has(e.reason)) {
      heartbeat.cancel()
      heartbeat = undefined
      await checkIn($, options, false)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      const isTask = e.durationMs >= Number(options.minTurnSeconds) * 1000
      if (e.reason === 'answer' && isTask) send($, options, 'success')
      if (e.reason === 'error') send($, options, 'fail')
    }
    return next(e)
  })

  // The .catch on each hook below keeps a failure of ours from blocking the call it watches.
  on('classic.StopFailure', ($, e, next) => {
    send($, options, 'fail')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', ($, e, next) => {
    send($, options, 'confirm')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) => {
    send($, options, 'confirm')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'ExitPlanMode' }, ($, e, next) => {
    send($, options, 'confirm')
    return next(e)
  }).catch(($, e, next) => next(e))
}
