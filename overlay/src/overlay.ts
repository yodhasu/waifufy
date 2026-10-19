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
  isVisible ? Ticker.shared.start() : Ticker.shared.stop()
}

// She never talks over a reaction or her own line: a pat while she speaks doesn't count.
async function pat() {
  const headpat = config.headpat
  if (!headpat || playing !== undefined) return
  if (Date.now() - lastPatAt > headpat.resetSeconds * 1000) patCount = 0
  patCount++
  lastPatAt = Date.now()
  const isBusy = headpat.busy !== undefined && (await invoke<boolean>('is_busy').catch(() => false))
  const tier = headpat.tiers.filter((t) => patCount >= t.from).at(-1)
  const reaction = isBusy ? headpat.busy : tier
  if (reaction && playing === undefined) perform('pat', reaction)
}

// The window passes clicks through except over her head, where a click is a pat.
function trackHead(x: number, y: number) {
  if (!config.headpat) return
  const isOver = fromHead(x, y).distance < config.headpat.radius * currentView.size
  if (isOver === isOverHead) return
  isOverHead = isOver
  document.body.style.cursor = isOver ? 'pointer' : ''
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
  if (e.button === 0 && isOverHead) void pat()
})
await listen<boolean>('waifu-visible', (e) => setVisible(e.payload))
await listen<boolean>('waifu-mute', (e) => {
  muted = e.payload
  if (muted) model.stopSpeaking()
})
document.addEventListener('visibilitychange', () => setVisible(!document.hidden))

idle()
