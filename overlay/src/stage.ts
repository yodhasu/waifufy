import { Application, Ticker, extensions } from 'pixi.js'
import { Live2DModel, Live2DPlugin, MotionPriority } from 'untitled-pixi-live2d-engine/cubism'
import { invoke } from '@tauri-apps/api/core'

export type Kind = 'success' | 'fail' | 'confirm'
export type Pose = { act: string; face: string }
export type Reaction = Pose & { voice?: string }
export type Crop = { x: number; y: number; w: number; h: number }
/** Which part of the reference frame the overlay shows (`crop`, 0–1 of it) and how big (`size`, 1 = reference). */
export type View = { crop: Crop; size: number }
export type Config = {
  model: string
  scale: number
  volume: number
  idleFps: number
  reactionFps: number
  trackMouse?: boolean
  /** Where she looks from: `x`/`y` as 0–1 of the full-body reference frame, `radius` the CSS-pixel distance of a full turn. */
  focus?: { x: number; y: number; radius: number }
  idle: Pose
  reactions: Record<Kind, Reaction>
  view?: View
}

/** The full-body frame every crop is measured in, in CSS pixels. */
export const REF_W = 320
export const REF_H = 480
export const FULL_VIEW: View = { crop: { x: 0, y: 0, w: 1, h: 1 }, size: 1 }
export const DEFAULT_FOCUS = { x: 0.5, y: 0.15, radius: 400 }

export async function loadStage(container: HTMLElement, width: number, height: number) {
  const base: string = await invoke('server_base')
  const config: Config = await (await fetch(`${base}/config`)).json()
  const asset = (path: string) => `${base}/assets/${path}`

  extensions.add(Live2DPlugin)
  const app = new Application()
  await app.init({
    width,
    height,
    backgroundAlpha: 0,
    antialias: false,
    resolution: 1,
    powerPreference: 'low-power',
    preference: 'webgl',
  })
  container.appendChild(app.canvas)
  Ticker.shared.maxFPS = config.idleFps

  const modelUrl = asset(config.model)
  const model = await Live2DModel.from(modelUrl, {
    autoFocus: false,
    autoHitTest: false,
    anchorMode: 'drawable',
    // One texture sized to what is on screen, instead of a full mipmap chain.
    textureOptions: { lod: 'single-auto' },
  })
  model.anchor.set(0.5, 1)
  app.stage.addChild(model)
  // `scale` 1 fits the character's visible body to the reference height. The engine only knows the
  // drawable bounds once the model has been drawn, so draw a couple of frames before measuring.
  for (let i = 0; i < 2; i++) {
    app.render()
    await new Promise(requestAnimationFrame)
  }
  const fitScale = (config.scale * REF_H) / model.height

  /** Lays the model out so the window shows `view.crop` of the reference frame at `view.size`. */
  const layout = (view: View, zoom = view.size) => {
    model.scale.set(fitScale * zoom)
    model.position.set((REF_W / 2 - view.crop.x * REF_W) * zoom, (REF_H - view.crop.y * REF_H) * zoom)
  }

  // Rem's model keeps every motion in one unnamed group, so poses are looked up by file name.
  const motionIndex = new Map<string, { group: string; index: number }>()
  const settings = await (await fetch(modelUrl)).json()
  for (const [group, list] of Object.entries<{ File: string }[]>(settings.FileReferences?.Motions ?? {})) {
    list.forEach((m, index) => {
      const name = m.File.split('/').pop()!.replace(/\.motion3\.json$/, '')
      motionIndex.set(name, { group, index })
    })
  }

  const pose = (p: Pose, priority: MotionPriority, loop: boolean) => {
    const list = [p.act, p.face].flatMap((name) => {
      const hit = motionIndex.get(name)
      if (!hit) console.warn(`[waifufy] unknown motion ${name}`)
      return hit ? [{ ...hit, priority, loop }] : []
    })
    return model.parallelMotion(list)
  }

  return { app, model, config, asset, layout, pose }
}
