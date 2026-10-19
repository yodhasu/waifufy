import { invoke } from '@tauri-apps/api/core'
import { FULL_VIEW, REF_H, REF_W, loadStage, type Crop, type View } from './stage'

const MIN_PX = 40
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type Handle = (typeof HANDLES)[number]

document.head.insertAdjacentHTML(
  'beforeend',
  `<style>
    body { background: #1b1d23; color: #e7e9ee; font: 13px/1.4 "Segoe UI", system-ui, sans-serif; overflow: hidden; }
    h1 { font-size: 15px; font-weight: 600; margin: 14px 20px 10px; }
    .frame { position: relative; width: ${REF_W}px; height: ${REF_H}px; margin: 0 20px; overflow: hidden;
      background: repeating-conic-gradient(#2a2d35 0 25%, #23262d 0 50%) 0 0 / 20px 20px; border-radius: 4px; }
    .frame canvas { position: absolute; inset: 0; }
    .crop { position: absolute; box-sizing: border-box; border: 1px solid #fff; cursor: move;
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, .55); }
    .crop::before, .crop::after { content: ""; position: absolute; border: 0 dashed rgba(255,255,255,.35); pointer-events: none; }
    .crop::before { inset: 33.3% 0; border-width: 1px 0; }
    .crop::after { inset: 0 33.3%; border-width: 0 1px; }
    .h { position: absolute; width: 10px; height: 10px; background: #fff; border: 1px solid #555; margin: -5px 0 0 -5px; }
    .h.nw { left: 0; top: 0; cursor: nwse-resize } .h.n { left: 50%; top: 0; cursor: ns-resize }
    .h.ne { left: 100%; top: 0; cursor: nesw-resize } .h.e { left: 100%; top: 50%; cursor: ew-resize }
    .h.se { left: 100%; top: 100%; cursor: nwse-resize } .h.s { left: 50%; top: 100%; cursor: ns-resize }
    .h.sw { left: 0; top: 100%; cursor: nesw-resize } .h.w { left: 0; top: 50%; cursor: ew-resize }
    .controls { display: flex; align-items: center; gap: 10px; margin: 14px 20px; }
    .controls input { flex: 1; accent-color: #e0457b; }
    .out { min-width: 72px; text-align: right; color: #9aa0ad; font-variant-numeric: tabular-nums; }
    .buttons { display: flex; gap: 10px; margin: 0 20px; }
    button { flex: 1; padding: 8px 0; border: 0; border-radius: 4px; font: inherit; font-weight: 600; cursor: pointer; }
    .set { background: #f0b429; color: #1b1d23 } .cancel { background: #3a3e48; color: #e7e9ee }
    .reset { flex: 0 0 auto; padding: 8px 12px; background: transparent; color: #9aa0ad }
  </style>`,
)
document.body.innerHTML = `
  <h1>Choose display area</h1>
  <div class="frame"><div class="crop">${HANDLES.map((h) => `<div class="h ${h}" data-h="${h}"></div>`).join('')}</div></div>
  <div class="controls"><span>Size</span><input type="range" min="0.4" max="3" step="0.05"><span class="out"></span></div>
  <div class="buttons"><button class="reset">Reset</button><button class="cancel">Cancel</button><button class="set">Set display</button></div>`

const frame = document.querySelector<HTMLElement>('.frame')!
const box = document.querySelector<HTMLElement>('.crop')!
const slider = document.querySelector<HTMLInputElement>('input')!
const out = document.querySelector<HTMLElement>('.out')!

const { config, layout } = await loadStage(frame, REF_W, REF_H)
layout(FULL_VIEW, 1)
frame.appendChild(box) // keep the crop box above the canvas

const initial = config.view ?? FULL_VIEW
// The crop in frame pixels while editing.
let rect = { x: initial.crop.x * REF_W, y: initial.crop.y * REF_H, w: initial.crop.w * REF_W, h: initial.crop.h * REF_H }
slider.value = String(initial.size)

function draw() {
  Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` })
  const size = Number(slider.value)
  out.textContent = `${Math.round(rect.w * size)}×${Math.round(rect.h * size)}`
}
draw()
slider.addEventListener('input', draw)

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

box.addEventListener('pointerdown', (down) => {
  down.preventDefault()
  box.setPointerCapture(down.pointerId)
  const handle = (down.target as HTMLElement).dataset.h as Handle | undefined
  const start = { ...rect }
  const move = (e: PointerEvent) => {
    const dx = e.clientX - down.clientX
    const dy = e.clientY - down.clientY
    if (!handle) {
      rect.x = clamp(start.x + dx, 0, REF_W - start.w)
      rect.y = clamp(start.y + dy, 0, REF_H - start.h)
      return draw()
    }
    let { x, y, w, h } = start
    if (handle.includes('w')) (x = clamp(start.x + dx, 0, start.x + start.w - MIN_PX)), (w = start.x + start.w - x)
    if (handle.includes('e')) w = clamp(start.w + dx, MIN_PX, REF_W - start.x)
    if (handle.includes('n')) (y = clamp(start.y + dy, 0, start.y + start.h - MIN_PX)), (h = start.y + start.h - y)
    if (handle.includes('s')) h = clamp(start.h + dy, MIN_PX, REF_H - start.y)
    rect = { x, y, w, h }
    draw()
  }
  const up = () => {
    box.removeEventListener('pointermove', move)
    box.removeEventListener('pointerup', up)
  }
  box.addEventListener('pointermove', move)
  box.addEventListener('pointerup', up)
})

document.querySelector('.reset')!.addEventListener('click', () => {
  rect = { x: 0, y: 0, w: REF_W, h: REF_H }
  slider.value = '1'
  draw()
})
document.querySelector('.cancel')!.addEventListener('click', () => invoke('close_editor'))
document.querySelector('.set')!.addEventListener('click', () => {
  const crop: Crop = { x: rect.x / REF_W, y: rect.y / REF_H, w: rect.w / REF_W, h: rect.h / REF_H }
  const view: View = { crop, size: Number(slider.value) }
  void invoke('save_view', { view })
})
