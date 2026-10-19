import { Ticker } from 'pixi.js'
import { MotionPriority } from 'untitled-pixi-live2d-engine/cubism'
import { listen } from '@tauri-apps/api/event'
import { DEFAULT_FOCUS, FULL_VIEW, REF_H, REF_W, loadStage, type Kind, type View } from './stage'

// Higher wins: a confirmation interrupts a success line, never the reverse.
const PRIORITY: Record<Kind, number> = { success: 1, fail: 2, confirm: 3 }
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

// The engine aims from the middle of the model's canvas and always turns fully. Aim from her head
// instead, and scale the turn with distance so a cursor near her face reads as looking straight on.
function lookAt(x: number, y: number) {
  const focus = { ...DEFAULT_FOCUS, ...config.focus }
  const { crop, size } = currentView
  const dx = x - (focus.x - crop.x) * REF_W * size
  const dy = y - (focus.y - crop.y) * REF_H * size
  const distance = Math.hypot(dx, dy)
  if (distance < 1) return model.internalModel.focusController.focus(0, 0)
  const strength = Math.min(1, distance / focus.radius)
  model.internalModel.focusController.focus((dx / distance) * strength, (-dy / distance) * strength)
}
applyView(config.view ?? FULL_VIEW)
await listen<View>('waifu-view', (e) => applyView(e.payload))
// The window is resized from Rust before the view event; keep the canvas matched either way.
window.addEventListener('resize', () => app.renderer.resize(window.innerWidth, window.innerHeight))

let muted = false
let playing: Kind | undefined
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
  playing = kind
  lastPlayed[kind] = Date.now()
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
  if (!(kind in PRIORITY)) return
  if (Date.now() - (lastPlayed[kind] ?? 0) < DEDUPE_MS) return
  if (playing === undefined) return play(kind)
  if (PRIORITY[kind] > PRIORITY[playing]) return play(kind)
  if (!queue.includes(kind) && queue.length < MAX_QUEUE) queue.push(kind)
}

// Rendering stops entirely while hidden; voices still play.
function setVisible(isVisible: boolean) {
  isVisible ? Ticker.shared.start() : Ticker.shared.stop()
}

await listen<{ kind: Kind }>('waifu-event', (e) => onEvent(e.payload.kind))
// Head, eyes and body turn toward the cursor; the engine eases the movement.
await listen<[number, number]>('waifu-cursor', (e) => lookAt(e.payload[0], e.payload[1]))
await listen<boolean>('waifu-visible', (e) => setVisible(e.payload))
await listen<boolean>('waifu-mute', (e) => {
  muted = e.payload
  if (muted) model.stopSpeaking()
})
document.addEventListener('visibilitychange', () => setVisible(!document.hidden))

idle()
