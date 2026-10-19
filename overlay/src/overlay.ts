import { Ticker } from 'pixi.js'
import { MotionPriority } from 'untitled-pixi-live2d-engine/cubism'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { DEFAULT_FOCUS, FULL_VIEW, REF_H, REF_W, loadStage, type Kind, type Reaction, type View } from './stage'

// Higher wins: a confirmation interrupts a success line, never the reverse. A pat is the lowest of all.
const PRIORITY: Record<Kind | 'pat', number> = { pat: 0, success: 1, push: 1, fail: 2, confirm: 3, danger: 4 }
const DEDUPE_MS = 2000
const MIN_REACTION_MS = 3000
const MAX_QUEUE = 3
// A press on her head becomes a pat once the cursor has stroked this far (CSS pixels).
const PAT_DISTANCE = 30
// Stroking counts as nonstop while the cursor moved within this long.
const STILL_MS = 500
const PAT_TICK_MS = 200

/** One press-and-drag on her head. */
type Stroke = {
  distance: number
  last: { x: number; y: number }
  lastMoveAt: number
  isPat: boolean
  /** When the current pause between lines began, while stroking nonstop. */
  gapStart?: number
  /** Tiers this stroke has advanced past its first, which picks the next pause. */
  advances: number
  /** The tier this pat started at, and the last one it played (-1: none yet). */
  baseTier: number
  playedTier: number
  isBusy: boolean
  timer?: number
}

const { app, model, config, asset, layout, pose } = await loadStage(document.body, window.innerWidth, window.innerHeight)

let currentView = config.view ?? FULL_VIEW

function applyView(view: View) {
  currentView = view
  app.renderer.resize(window.innerWidth, window.innerHeight)
  layout(view)
}

/** Where the cursor is relative to her head, in CSS pixels. */
function fromHead(x: number, y: number) {
  const focus = { ...DEFAULT_FOCUS, ...config.focus }
  const { crop, size } = currentView
  const dx = x - (focus.x - crop.x) * REF_W * size
  const dy = y - (focus.y - crop.y) * REF_H * size
  return { dx, dy, distance: Math.hypot(dx, dy), radius: focus.radius }
}

// The engine aims from the middle of the model's canvas and always turns fully. Aim from her head
// instead, and scale the turn with distance so a cursor near her face reads as looking straight on.
function lookAt(x: number, y: number) {
  const { dx, dy, distance, radius } = fromHead(x, y)
  if (distance < 1) return model.internalModel.focusController.focus(0, 0)
  const strength = Math.min(1, distance / radius)
  model.internalModel.focusController.focus((dx / distance) * strength, (-dy / distance) * strength)
}
applyView(config.view ?? FULL_VIEW)
await listen<View>('waifu-view', (e) => applyView(e.payload))
// The window is resized from Rust before the view event; keep the canvas matched either way.
window.addEventListener('resize', () => app.renderer.resize(window.innerWidth, window.innerHeight))

let muted = false
let patCount = 0
let lastPatAt = 0
let isOverHead = false
let stroke: Stroke | undefined
let playing: Kind | 'pat' | undefined
let finishTimer: number | undefined
const queue: Kind[] = []
const lastPlayed: Partial<Record<Kind, number>> = {}

function idle() {
  playing = undefined
  Ticker.shared.maxFPS = config.idleFps
  void pose(config.idle, MotionPriority.IDLE, true)
}

function play(kind: Kind) {
  const reaction = config.reactions[kind]
  if (!reaction) return
  lastPlayed[kind] = Date.now()
  perform(kind, reaction)
}

function perform(kind: Kind | 'pat', reaction: Reaction) {
  playing = kind
  clearTimeout(finishTimer)
  model.stopSpeaking()
  Ticker.shared.maxFPS = config.reactionFps
  void pose(reaction, MotionPriority.FORCE, false)

  // Finish once both the voice has ended and the motion has had MIN_REACTION_MS.
  let isVoiceDone = muted || !reaction.voice
  let isTimeDone = false
  const finish = () => {
    if (!isVoiceDone || !isTimeDone || playing !== kind) return
    const next = queue.shift()
    next ? play(next) : idle()
  }
  finishTimer = window.setTimeout(() => ((isTimeDone = true), finish()), MIN_REACTION_MS)
  if (!isVoiceDone) {
    const voiceDone = () => ((isVoiceDone = true), finish())
    void model.speak(asset(reaction.voice!), {
      volume: config.volume,
      resetExpression: false,
      onFinish: voiceDone,
      onError: (e) => (console.warn('[waifufy] voice failed', e), voiceDone()),
    })
  }
}

function onEvent(kind: Kind) {
  if (!config.reactions[kind]) return
  if (Date.now() - (lastPlayed[kind] ?? 0) < DEDUPE_MS) return
  // A destructive command usually asks for permission next; her warning already covers that.
  if (kind === 'confirm' && playing === 'danger') return
  if (playing === undefined) return play(kind)
  if (PRIORITY[kind] > PRIORITY[playing]) return play(kind)
  if (!queue.includes(kind) && queue.length < MAX_QUEUE) queue.push(kind)
}

// Rendering stops entirely while hidden; voices still play.
function setVisible(isVisible: boolean) {
  // Showing the window makes it click-through again, head included.
  isOverHead = false
  endStroke()
  isVisible ? Ticker.shared.start() : Ticker.shared.stop()
}

const tierFor = (count: number) => Math.max(0, config.headpat!.tiers.filter((t) => count >= t.from).length - 1)

// A stroke turns into a pat once it has travelled PAT_DISTANCE. Each pat counts once toward the
// running total (separate pats in quick succession escalate). Stroking nonstop walks her through
// every remaining tier in order: each line plays to the end, then `gapSeconds` pauses before the
// next, each pause shorter than the last. Pausing the stroke restarts the pause.
async function beginPat(s: Stroke) {
  const headpat = config.headpat!
  if (Date.now() - lastPatAt > headpat.resetSeconds * 1000) patCount = 0
  patCount++
  lastPatAt = Date.now()
  s.isPat = true
  s.baseTier = tierFor(patCount)
  s.isBusy = headpat.busy !== undefined && (await invoke<boolean>('is_busy').catch(() => false))
  s.timer = window.setInterval(() => patTick(s), PAT_TICK_MS)
  patTick(s)
}

function patTick(s: Stroke) {
  const headpat = config.headpat!
  const now = Date.now()
  const isMoving = now - s.lastMoveAt < STILL_MS
  if (isMoving) lastPatAt = now
  if (playing !== undefined) return void (s.gapStart = undefined)
  // Claude is working: one telling-off per pat, no escalation.
  if (s.isBusy) {
    if (s.playedTier < 0) (s.playedTier = headpat.tiers.length), perform('pat', headpat.busy!)
    return
  }
  if (s.playedTier < 0) {
    s.playedTier = s.baseTier
  } else {
    if (s.playedTier >= headpat.tiers.length - 1) return
    if (!isMoving) return void (s.gapStart = undefined)
    s.gapStart ??= now
    const gaps = headpat.gapSeconds
    if (now - s.gapStart < (gaps[s.advances] ?? gaps.at(-1) ?? 0) * 1000) return
    s.advances++
    s.playedTier++
  }
  const tier = headpat.tiers[s.playedTier]!
  // Nonstop stroking that reaches a tier counts as that many pats, so the next pat picks up from there.
  patCount = Math.max(patCount, tier.from)
  perform('pat', tier)
}

function endStroke() {
  clearInterval(stroke?.timer)
  stroke = undefined
  document.body.style.cursor = isOverHead ? 'grab' : ''
}

// The window passes clicks through except over her head, where a press-and-drag is a pat.
function trackHead(x: number, y: number) {
  if (!config.headpat) return
  const isOver = fromHead(x, y).distance < config.headpat.radius * currentView.size
  // Mid-stroke the window stays clickable, so the cursor can wander off her head without dropping it.
  if (isOver === isOverHead || stroke) return
  isOverHead = isOver
  document.body.style.cursor = isOver ? 'grab' : ''
  void invoke('set_pattable', { on: isOver })
}

await listen<{ kind: Kind }>('waifu-event', (e) => onEvent(e.payload.kind))
// Head, eyes and body turn toward the cursor; the engine eases the movement.
await listen<[number, number]>('waifu-cursor', (e) => {
  const [x, y] = e.payload
  if (config.trackMouse !== false) lookAt(x, y)
  trackHead(x, y)
})
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !isOverHead || !config.headpat) return
  document.body.setPointerCapture(e.pointerId)
  document.body.style.cursor = 'grabbing'
  const at = { x: e.clientX, y: e.clientY }
  stroke = { distance: 0, last: at, lastMoveAt: 0, isPat: false, advances: 0, baseTier: 0, playedTier: -1, isBusy: false }
})
document.addEventListener('pointermove', (e) => {
  if (!stroke) return
  const s = stroke
  s.distance += Math.hypot(e.clientX - s.last.x, e.clientY - s.last.y)
  s.last = { x: e.clientX, y: e.clientY }
  s.lastMoveAt = Date.now()
  if (!s.isPat && s.distance >= PAT_DISTANCE) void beginPat(s)
})
document.addEventListener('pointerup', endStroke)
document.addEventListener('pointercancel', endStroke)
await listen<boolean>('waifu-visible', (e) => setVisible(e.payload))
await listen<boolean>('waifu-mute', (e) => {
  muted = e.payload
  if (muted) model.stopSpeaking()
})
document.addEventListener('visibilitychange', () => setVisible(!document.hidden))

idle()
