# Waifufy

A Live2D character sits in the bottom-right corner of your screen and reacts to Claude Code with a motion and a voice line:

| Event | When |
|---|---|
| `success` | a main-agent turn finishes normally and took at least `minTurnSeconds` (default 5 s) |
| `fail` | a turn dies on an API error (`turn.complete` error / `StopFailure`) |
| `confirm` | a permission dialog, an `AskUserQuestion`, or a plan approval (`ExitPlanMode`) |

## Fork it, make it yours

This repo is meant to be forked. Swap in your own waifu (or husbando, or cat, or anything with a Live2D rig), your own voice lines, your own reactions. No permission needed, go wild.

The model and voices aren't in the repo (they're third-party assets and `assets/` is gitignored), so you'll bring your own anyway:

1. **Model**: drop any Live2D Cubism model folder into `assets/models/<name>/` and point `model` in `waifufy.config.json` at its `.model3.json`.
2. **Motions**: set `idle` and each entry under `reactions` to motion names from your model (file name without `.motion3.json`). `act` is the body motion, `face` is the expression motion.
3. **Voices**: put audio files in `assets/voices/` and reference them as `voice` per reaction. Leave it out for a silent reaction.
4. **Framing**: use **Choose display area…** (Ctrl+Alt+E) to crop the character; tweak `scale`, `focus` and `trackMouse` if needed.
5. **Use cases**: the events come from `mod/` hooks. Add new kinds (e.g. a reaction when tests pass or a commit lands) by posting another `kind` to `/event` from the mod and adding a matching entry under `reactions`. The overlay doesn't care what triggers it, so anything that can `curl` can make your waifu react.

If you build something fun, share it, but you don't have to.

## Pieces

- `overlay/`: Tauri 2 app (WebView2 + PixiJS v8 + `untitled-pixi-live2d-engine`).
  - The window is transparent, always on top and click-through, and stays out of Alt+Tab.
  - The tray icon toggles visibility (left-click, or **Ctrl+Alt+W**). It also has Mute voice, Start with Windows and Quit.
  - **Choose display area…** (tray, or **Ctrl+Alt+E**) opens a crop picker: drag or resize the box over the character, set the size, then **Set display**. The overlay resizes to that area, and the choice is saved as `view` in `waifufy.config.json`.
  - It listens on `127.0.0.1:47823`: `GET /health`, `POST /event {"kind":"success|fail|confirm"}`, and it serves `/config` and `/assets/*`.
- `mod/`: Claude Code plugin (hooks module) that posts events to the overlay. If the overlay isn't running, the plugin starts it.
- `waifufy.config.json`: the model, scale (1 = the body fills the frame), fps, each event's body motion, face motion and voice, and the display area.
  - Motions are named by file name, without `.motion3.json`.
  - Paths are relative to `assets/`.
  - Restart the overlay after editing.
- `assets/`: the model (`models/rem/`) and the voices (`voices/*.mp3`).

## Build and install

```powershell
cd overlay
npm install
npm run tauri build -- --no-bundle   # → overlay/src-tauri/target/release/waifufy.exe
```

`overlay/public/live2dcubismcore.min.js` comes from Live2D. It falls under the Live2D Proprietary Software License, which is why it's gitignored. Download it with:

```powershell
Invoke-WebRequest https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js -OutFile overlay/public/live2dcubismcore.min.js
```

To load the mod in every Claude Code session, add this to the `env` block of `~/.claude/settings.json`:

```json
"CLAUDE_CODE_PLUGIN_DIRS": "C:\\path\\to\\waifufy\\mod"
```

Options live in `/config` under the `waifufy` plugin: port, overlay path, minimum turn length, and a toggle for each event.

## Develop

- `cd overlay; npm run tauri dev`: runs the overlay with hot reload.
- `curl -X POST 127.0.0.1:47823/event -d '{"kind":"success"}'`: fires a reaction by hand.
- `claude plugin validate mod` and `claude plugin test mod`: check the mod.

Environment overrides for the overlay:
- `WAIFUFY_PORT`: the port it listens on.
- `WAIFUFY_HOME`: the folder holding `waifufy.config.json` and `assets/`. By default that's the repo it was built from.

## License

The code is [MIT](LICENSE): fork it, change it, ship it. This covers only the code in this repo. Live2D models, voices and the Cubism Core keep their own licenses, so check those before you share a build that bundles them.
