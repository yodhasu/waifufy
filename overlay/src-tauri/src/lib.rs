use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, ShortcutState};
use tiny_http::{Header, Method, Response, Server};

const DEFAULT_PORT: u16 = 47823;
const KINDS: [&str; 5] = ["success", "fail", "confirm", "push", "danger"];
const TOGGLE_SHORTCUT: &str = "ctrl+alt+w";
const EDITOR_SHORTCUT: &str = "ctrl+alt+e";

fn port() -> u16 {
    std::env::var("WAIFUFY_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// The folder holding `waifufy.config.json` and `assets/`: `WAIFUFY_HOME`, else the repo this was built from.
fn home() -> PathBuf {
    let dir = std::env::var_os("WAIFUFY_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(".."));
    dir.canonicalize().unwrap_or(dir)
}

#[tauri::command]
fn server_base() -> String {
    format!("http://127.0.0.1:{}", port())
}

/// The full-body frame a view's crop is measured in, in logical pixels; matches `REF_W`/`REF_H` in stage.ts.
const REF_W: f64 = 320.0;
const REF_H: f64 = 480.0;

fn config_path() -> PathBuf {
    home().join("waifufy.config.json")
}

fn read_config() -> serde_json::Value {
    fs::read(config_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// The overlay's logical size for a view: its crop of the reference frame, times its size.
fn view_size(view: &serde_json::Value) -> LogicalSize<f64> {
    let crop = &view["crop"];
    let size = view["size"].as_f64().unwrap_or(1.0);
    let w = crop["w"].as_f64().unwrap_or(1.0) * REF_W * size;
    let h = crop["h"].as_f64().unwrap_or(1.0) * REF_H * size;
    LogicalSize::new(w.round().max(24.0), h.round().max(24.0))
}

fn apply_view(win: &WebviewWindow, view: &serde_json::Value) -> tauri::Result<()> {
    if view.is_object() {
        win.set_size(view_size(view))?;
    }
    place(win)
}

#[tauri::command]
fn save_view(app: AppHandle, view: serde_json::Value) -> Result<(), String> {
    let mut config = read_config();
    config["view"] = view.clone();
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path(), text + "\n").map_err(|e| e.to_string())?;
    if let Some(win) = app.get_webview_window("main") {
        apply_view(&win, &view).map_err(|e| e.to_string())?;
        let _ = app.emit_to("main", "waifu-view", &view);
    }
    close_editor(app);
    Ok(())
}

#[tauri::command]
fn close_editor(app: AppHandle) {
    if let Some(editor) = app.get_webview_window("editor") {
        let _ = editor.destroy();
    }
}

/// The crop picker: a normal window, built on demand and destroyed on close so it costs nothing otherwise.
fn open_editor(app: &AppHandle) -> tauri::Result<()> {
    if let Some(editor) = app.get_webview_window("editor") {
        return editor.set_focus();
    }
    let mut builder = WebviewWindowBuilder::new(app, "editor", WebviewUrl::App("index.html".into()))
        .title("Waifufy - Choose display area")
        .inner_size(REF_W + 40.0, REF_H + 150.0)
        .resizable(false)
        .maximizable(false)
        .always_on_top(true)
        .focused(true)
        .center();
    // WebView2 windows sharing a profile must be built with the same browser arguments.
    if let Some(args) = app.config().app.windows.first().and_then(|w| w.additional_browser_args.clone()) {
        builder = builder.additional_browser_args(&args);
    }
    builder.build()?.set_focus()
}

#[derive(Deserialize)]
struct EventBody {
    kind: String,
}

#[derive(Deserialize)]
struct SessionBody {
    id: String,
    #[serde(default = "default_open")]
    open: bool,
}

fn default_open() -> bool {
    true
}

#[derive(Deserialize)]
struct BusyBody {
    id: String,
    busy: bool,
}

/// Sessions whose main loop is mid-turn, with when each last said so.
type Busy = Arc<Mutex<HashMap<String, Instant>>>;

/// A busy flag nobody refreshes (the CLI heartbeat does, every 20 s) was left by a session that died mid-turn.
const BUSY_TIMEOUT: Duration = Duration::from_secs(90);

#[tauri::command]
fn is_busy(busy: tauri::State<Busy>) -> bool {
    let mut live = busy.lock().unwrap();
    live.retain(|_, seen| seen.elapsed() < BUSY_TIMEOUT);
    !live.is_empty()
}

/// Lets clicks land on the overlay while the cursor is over her head, so she can be patted;
/// everywhere else they still pass through.
#[tauri::command]
fn set_pattable(app: AppHandle, on: bool) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_ignore_cursor_events(!on);
    }
}

/// Claude Code CLI sessions alive right now, by id, with when each last checked in.
type Sessions = Arc<Mutex<HashMap<String, Instant>>>;

/// A session that misses this many heartbeats' worth of time was killed without saying goodbye.
const SESSION_TIMEOUT: Duration = Duration::from_secs(60);
const REAP_EVERY: Duration = Duration::from_secs(5);

/// Quits once every CLI session that ever checked in is gone. Until the first one does, it waits.
fn reap_sessions(app: AppHandle, sessions: Sessions) {
    let mut has_had_session = false;
    loop {
        thread::sleep(REAP_EVERY);
        let mut live = sessions.lock().unwrap();
        live.retain(|_, seen| seen.elapsed() < SESSION_TIMEOUT);
        has_had_session |= !live.is_empty();
        if has_had_session && live.is_empty() {
            app.exit(0);
            return;
        }
    }
}

type Reply = Response<std::io::Cursor<Vec<u8>>>;

fn reply(status: u16, body: Vec<u8>, mime: &str) -> Reply {
    Response::from_data(body)
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", mime).unwrap())
        .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap())
}

fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "json" => "application/json",
        "png" => "image/png",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Recounts a motion3.json's `Meta` totals from its curves. Models ripped from games often carry
/// wrong counts, and the Cubism framework sizes its buffers from them, so a wrong count fails the parse.
fn fix_motion_meta(bytes: Vec<u8>) -> Vec<u8> {
    let Ok(mut motion) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return bytes };
    let curves = motion["Curves"].as_array().cloned().unwrap_or_default();
    let (mut segments, mut points) = (0u64, 0u64);
    for curve in &curves {
        let s: Vec<f64> = curve["Segments"].as_array().map(|a| a.iter().filter_map(|v| v.as_f64()).collect()).unwrap_or_default();
        if s.len() < 2 {
            continue;
        }
        points += 1; // the curve's first point
        let mut i = 2;
        while i < s.len() {
            let (advance, added) = match s[i] as i64 {
                1 => (7, 3), // bezier: two control points and the end point
                _ => (3, 1), // linear, stepped, inverse stepped
            };
            segments += 1;
            points += added;
            i += advance;
        }
    }
    let user_data = motion["UserData"].as_array().cloned().unwrap_or_default();
    let user_data_size: usize = user_data.iter().map(|u| u["Value"].as_str().map_or(0, str::len)).sum();
    if let Some(meta) = motion["Meta"].as_object_mut() {
        meta.insert("CurveCount".into(), curves.len().into());
        meta.insert("TotalSegmentCount".into(), segments.into());
        meta.insert("TotalPointCount".into(), points.into());
        meta.insert("UserDataCount".into(), user_data.len().into());
        meta.insert("TotalUserDataSize".into(), user_data_size.into());
    }
    serde_json::to_vec(&motion).unwrap_or(bytes)
}

/// Serves a file under `root`, refusing any path that climbs out of it.
fn serve_file(root: &Path, rel: &str) -> Reply {
    let rel = PathBuf::from(percent_decode(rel));
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return reply(403, b"forbidden".to_vec(), "text/plain");
    }
    let path = root.join(rel);
    match fs::read(&path) {
        Ok(bytes) if path.to_string_lossy().ends_with(".motion3.json") => {
            reply(200, fix_motion_meta(bytes), mime_of(&path))
        }
        Ok(bytes) => reply(200, bytes, mime_of(&path)),
        Err(_) => reply(404, b"not found".to_vec(), "text/plain"),
    }
}

/// Local-only HTTP endpoint shared by every Claude Code session.
fn serve(app: AppHandle, root: PathBuf, sessions: Sessions, busy: Busy) {
    let server = match Server::http(("127.0.0.1", port())) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("waifufy: cannot listen on port {}: {e}", port());
            return;
        }
    };
    for mut req in server.incoming_requests() {
        let url = req.url().split('?').next().unwrap_or("").to_string();
        let resp = match (req.method(), url.as_str()) {
            (Method::Get, "/health") => reply(200, b"ok".to_vec(), "text/plain"),
            (Method::Post, "/event") => {
                let mut body = String::new();
                let _ = req.as_reader().take(4096).read_to_string(&mut body);
                match serde_json::from_str::<EventBody>(&body) {
                    Ok(ev) if KINDS.contains(&ev.kind.as_str()) => {
                        let _ = app.emit("waifu-event", serde_json::json!({ "kind": ev.kind }));
                        reply(204, Vec::new(), "text/plain")
                    }
                    _ => reply(400, b"bad event".to_vec(), "text/plain"),
                }
            }
            (Method::Post, "/session") => {
                let mut body = String::new();
                let _ = req.as_reader().take(4096).read_to_string(&mut body);
                match serde_json::from_str::<SessionBody>(&body) {
                    Ok(s) if !s.id.is_empty() => {
                        let mut live = sessions.lock().unwrap();
                        if s.open {
                            live.insert(s.id, Instant::now());
                        } else {
                            live.remove(&s.id);
                        }
                        reply(204, Vec::new(), "text/plain")
                    }
                    _ => reply(400, b"bad session".to_vec(), "text/plain"),
                }
            }
            (Method::Post, "/busy") => {
                let mut body = String::new();
                let _ = req.as_reader().take(4096).read_to_string(&mut body);
                match serde_json::from_str::<BusyBody>(&body) {
                    Ok(b) if !b.id.is_empty() => {
                        let mut live = busy.lock().unwrap();
                        if b.busy {
                            live.insert(b.id, Instant::now());
                        } else {
                            live.remove(&b.id);
                        }
                        reply(204, Vec::new(), "text/plain")
                    }
                    _ => reply(400, b"bad busy".to_vec(), "text/plain"),
                }
            }
            (Method::Get, "/config") => serve_file(&root, "waifufy.config.json"),
            (Method::Get, p) if p.starts_with("/assets/") => serve_file(&root.join("assets"), &p["/assets/".len()..]),
            _ => reply(404, b"not found".to_vec(), "text/plain"),
        };
        let _ = req.respond(resp);
    }
}

/// Bottom-right of the primary monitor's work area, so the taskbar stays clear.
fn place(win: &WebviewWindow) -> tauri::Result<()> {
    if let Some(monitor) = win.primary_monitor()? {
        let area = monitor.work_area();
        let size = win.outer_size()?;
        let x = area.position.x + area.size.width as i32 - size.width as i32;
        let y = area.position.y + area.size.height as i32 - size.height as i32;
        win.set_position(PhysicalPosition::new(x, y))?;
    }
    Ok(())
}

/// Clicks pass through to whatever is underneath, and the window stays out of Alt+Tab and never takes focus.
fn make_unclickable(win: &WebviewWindow) {
    let _ = win.set_ignore_cursor_events(true);
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        };
        let hwnd = hwnd.0 as _;
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let style = (style | (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) as isize) & !(WS_EX_APPWINDOW as isize);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
        }
    }
}

const CURSOR_POLL: Duration = Duration::from_millis(66);

/// The overlay ignores the mouse, so it never hears pointer events: poll the global cursor instead and
/// send its window-relative position (CSS pixels) whenever it moves while the overlay is shown.
/// The page uses it both to turn her toward the cursor and to tell when it is over her head.
fn track_cursor(app: AppHandle) {
    let mut last = (f64::NAN, f64::NAN);
    loop {
        thread::sleep(CURSOR_POLL);
        let Some(win) = app.get_webview_window("main") else { continue };
        if !win.is_visible().unwrap_or(false) {
            continue;
        }
        let (Ok(cursor), Ok(origin), Ok(scale)) = (win.cursor_position(), win.outer_position(), win.scale_factor()) else {
            continue;
        };
        let at = ((cursor.x - origin.x as f64) / scale, (cursor.y - origin.y as f64) / scale);
        if (at.0 - last.0).abs() < 1.0 && (at.1 - last.1).abs() < 1.0 {
            continue;
        }
        last = at;
        let _ = app.emit_to("main", "waifu-cursor", [at.0, at.1]);
    }
}

fn set_visible(app: &AppHandle, is_visible: bool) {
    let Some(win) = app.get_webview_window("main") else { return };
    if is_visible {
        let _ = win.show();
        make_unclickable(&win);
    } else {
        let _ = win.hide();
    }
    let _ = app.emit("waifu-visible", is_visible);
}

fn toggle(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        set_visible(app, !win.is_visible().unwrap_or(true));
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle_item = MenuItem::with_id(app, "toggle", "Show / Hide  (Ctrl+Alt+W)", true, None::<&str>)?;
    let area = MenuItem::with_id(app, "area", "Choose display area…  (Ctrl+Alt+E)", true, None::<&str>)?;
    let mute = CheckMenuItem::with_id(app, "mute", "Mute voice", true, false, None::<&str>)?;
    let is_autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, is_autostart, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Waifufy", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle_item, &area, &mute, &autostart, &quit])?;

    TrayIconBuilder::with_id("waifufy")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Waifufy")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "toggle" => toggle(app),
            "area" => {
                let _ = open_editor(app);
            }
            "mute" => {
                let _ = app.emit("waifu-mute", mute.is_checked().unwrap_or(false));
            }
            "autostart" => {
                let launcher = app.autolaunch();
                let _ = if autostart.is_checked().unwrap_or(false) { launcher.enable() } else { launcher.disable() };
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First, so a second launch from another session just exits.
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([TOGGLE_SHORTCUT, EDITOR_SHORTCUT])
                .expect("valid shortcut")
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut.key == Code::KeyE {
                        let _ = open_editor(app);
                    } else {
                        toggle(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![server_base, save_view, close_editor, is_busy, set_pattable])
        .setup(|app| {
            let sessions = Sessions::default();
            let busy = Busy::default();
            app.manage(busy.clone());
            let (handle, live) = (app.handle().clone(), sessions.clone());
            thread::spawn(move || serve(handle, home(), live, busy));
            let handle = app.handle().clone();
            thread::spawn(move || reap_sessions(handle, sessions));
            let handle = app.handle().clone();
            thread::spawn(move || track_cursor(handle));
            build_tray(app.handle())?;
            let win = app.get_webview_window("main").expect("main window");
            apply_view(&win, &read_config()["view"])?;
            set_visible(app.handle(), true);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running waifufy");
}
