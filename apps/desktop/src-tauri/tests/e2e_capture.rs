//! End-to-end smoke test of the capture flow: the capture key opens the region
//! overlay, a mouse drag copies exactly the dragged pixels to the clipboard and
//! shows the preview, and Esc cancels without touching the clipboard.
//!
//! It drives the real desktop (mouse, keyboard, clipboard), so it is ignored by
//! default; run it with `pnpm e2e:capture`.
#![cfg(windows)]
// The casts below turn small, known-good sizes into the integer types Win32 wants.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::borrow_as_ptr
)]
// The Win32 calls below drive the test machine's desktop; each unsafe block is a
// plain call with valid arguments.
#![allow(unsafe_code)]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::str::FromStr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ::windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use ::windows::Win32::Graphics::Dwm::{
    DWM_WINDOW_CORNER_PREFERENCE, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
    DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND, DwmSetWindowAttribute,
};
use ::windows::Win32::Graphics::Gdi::{
    CreateSolidBrush, GetMonitorInfoW, MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromPoint,
};
use ::windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
    RegisterClipboardFormatW,
};
use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
use ::windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use ::windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP,
    MOUSE_EVENT_FLAGS, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEINPUT,
    SendInput, VIRTUAL_KEY, VK_CONTROL, VK_ESCAPE, VK_F9, VK_MENU, VK_SHIFT,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, FindWindowExW, GetCursorPos,
    GetForegroundWindow, GetWindowThreadProcessId, IsWindowVisible, MSG, PM_REMOVE, PeekMessageW,
    RegisterClassW, SetCursorPos, TranslateMessage, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};
use ::windows::core::{PCWSTR, w};

/// A key no one else is likely to hold, so the test runs while the user's own
/// Cropa keeps `Alt+Shift+S`.
const CAPTURE_KEY: &str = "Ctrl+Alt+Shift+F9";

/// The dragged region. Odd sizes on purpose, so a rounding error shows.
const REGION_LEFT: i32 = 200;
const REGION_TOP: i32 = 260;
const REGION_WIDTH: u32 = 301;
const REGION_HEIGHT: u32 = 187;

const BACKDROP: (u8, u8, u8) = (20, 20, 20);
const TARGET: (u8, u8, u8) = (30, 170, 90);

type Log = Arc<Mutex<Vec<String>>>;

#[test]
#[ignore = "drives the real desktop with the mouse, keyboard and clipboard; run with `pnpm e2e:capture`"]
fn capture_copies_the_dragged_region_and_esc_leaves_the_clipboard_alone() {
    // Every coordinate below is physical, like the ones the app works in.
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
        .expect("could not make the test DPI aware");
    assert!(
        tauri_plugin_global_shortcut::Shortcut::from_str(CAPTURE_KEY).is_ok(),
        "{CAPTURE_KEY} is not a valid accelerator"
    );

    let dir = write_settings();

    // A known screen state: a dark backdrop with a green target exactly on the
    // region, so a crop shifted by one pixel puts the backdrop colour in a corner.
    let monitor = primary_monitor();
    let left = monitor.left + REGION_LEFT;
    let top = monitor.top + REGION_TOP;
    let (width, height) = (REGION_WIDTH as i32, REGION_HEIGHT as i32);
    let margin = 24;
    let mut guard = Guard {
        child: None,
        windows: Vec::new(),
        dir: dir.clone(),
        log: Log::default(),
    };
    guard.windows.push(solid_window(
        "CropaE2eBackdrop",
        BACKDROP,
        (
            left - margin,
            top - margin,
            width + 2 * margin,
            height + 2 * margin,
        ),
    ));
    guard.windows.push(solid_window(
        "CropaE2eTarget",
        TARGET,
        (left, top, width, height),
    ));
    for window in &guard.windows {
        square_corners(*window);
    }
    pump(Duration::from_millis(300));

    // The screen capture may include the cursor, so park it away from the region.
    park_cursor(left + width + margin + 60, top + height + margin + 60);

    spawn_app(&mut guard);

    let ready = wait_for_log(
        &mut guard,
        0,
        "ready, capture key ",
        Duration::from_secs(60),
    );
    assert!(
        !ready.contains("not registered"),
        "the test capture key {CAPTURE_KEY} is taken by another app; free it and run again"
    );

    // First capture: the overlay opens, a drag selects the region.
    let mark = guard.lines();
    press_capture_key();
    wait_for_log(
        &mut guard,
        mark,
        "region overlay shown",
        Duration::from_secs(10),
    );
    assert!(
        find_window(w!("CropaRegionOverlay")).is_some(),
        "no overlay window"
    );

    let mark = guard.lines();
    drag(left, top, left + width - 1, top + height - 1);
    wait_for_log(
        &mut guard,
        mark,
        "copied to the clipboard",
        Duration::from_secs(10),
    );

    let png = read_clipboard_png();
    let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
        .expect("the clipboard PNG does not decode")
        .to_rgba8();
    assert_eq!(
        (image.width(), image.height()),
        (REGION_WIDTH, REGION_HEIGHT),
        "the copied image has the wrong size"
    );
    assert_region_pixels(&image);

    // The preview shows, and does not take the focus.
    wait_for_log(&mut guard, mark, "preview shown", Duration::from_secs(10));
    let preview = find_window(w!("CropaPreview")).expect("no preview window");
    assert!(
        unsafe { IsWindowVisible(preview) }.as_bool(),
        "the preview is hidden"
    );
    assert_ne!(
        unsafe { GetForegroundWindow() },
        preview,
        "the preview took the focus"
    );

    esc_cancels_and_keeps_the_clipboard(&mut guard);
}

/// Owns everything the test starts and cleans it up, also when an assertion
/// fails. On a failure it prints the app's log so CI shows it.
struct Guard {
    child: Option<Child>,
    windows: Vec<HWND>,
    dir: PathBuf,
    log: Log,
}

impl Guard {
    fn lines(&self) -> usize {
        self.log.lock().unwrap().len()
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        for window in &self.windows {
            let _ = unsafe { DestroyWindow(*window) };
        }
        let _ = std::fs::remove_dir_all(&self.dir);
        if std::thread::panicking() {
            eprintln!("--- Cropa log ---");
            for line in self.log.lock().unwrap().iter() {
                eprintln!("{line}");
            }
        }
    }
}

/// Wait for a log line containing `needle`, ignoring the first `from` lines so
/// a line of an earlier step is not mistaken for this one.
fn wait_for_log(guard: &mut Guard, from: usize, needle: &str, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    loop {
        let found = guard
            .log
            .lock()
            .unwrap()
            .iter()
            .skip(from)
            .find(|line| line.contains(needle))
            .cloned();
        if let Some(line) = found {
            return line;
        }
        if let Some(status) = guard
            .child
            .as_mut()
            .and_then(|c| c.try_wait().ok().flatten())
        {
            panic!(
                "Cropa exited ({status}) before `{needle}`; another Cropa E2E instance may still \
                 be running (the `cropa-e2e` single-instance lock): end `cropa-desktop.exe` in \
                 Task Manager"
            );
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for `{needle}` in the Cropa log"
        );
        pump(Duration::from_millis(20));
    }
}

fn wait_until(timeout: Duration, message: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !done() {
        assert!(Instant::now() < deadline, "{message}");
        pump(Duration::from_millis(20));
    }
}

/// Handle our own windows' messages for `duration`, so they are painted.
fn pump(duration: Duration) {
    let deadline = Instant::now() + duration;
    loop {
        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

/// A topmost window without focus or taskbar button, filled with one colour.
fn solid_window(
    class: &str,
    colour: (u8, u8, u8),
    (x, y, width, height): (i32, i32, i32, i32),
) -> HWND {
    let class: Vec<u16> = class.encode_utf16().chain(Some(0)).collect();
    let class = PCWSTR(class.as_ptr());
    let instance: HINSTANCE = unsafe { GetModuleHandleW(None) }.unwrap().into();
    let brush = unsafe {
        CreateSolidBrush(::windows::Win32::Foundation::COLORREF(
            u32::from(colour.0) | u32::from(colour.1) << 8 | u32::from(colour.2) << 16,
        ))
    };
    let window_class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance,
        lpszClassName: class,
        hbrBackground: brush,
        ..Default::default()
    };
    assert_ne!(
        unsafe { RegisterClassW(&window_class) },
        0,
        "could not register a window class"
    );
    unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class,
            None,
            WS_POPUP | WS_VISIBLE,
            x,
            y,
            width,
            height,
            None,
            None,
            Some(instance),
            None,
        )
    }
    .expect("could not create a test window")
}

fn primary_monitor() -> RECT {
    let monitor = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    assert!(
        unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool(),
        "no primary monitor"
    );
    info.rcMonitor
}

/// The process id of the app under test, so a window of the user's own Cropa
/// (same window classes) is never mistaken for the test instance's.
static APP_PID: AtomicU32 = AtomicU32::new(0);

/// A top-level window of class `class` that belongs to the app under test.
fn find_window(class: PCWSTR) -> Option<HWND> {
    let pid = APP_PID.load(Ordering::SeqCst);
    let mut previous = None;
    loop {
        let window = unsafe { FindWindowExW(None, previous, class, None) }.ok()?;
        if window.is_invalid() {
            return None;
        }
        let mut owner = 0;
        unsafe { GetWindowThreadProcessId(window, Some(&mut owner)) };
        if owner == pid {
            return Some(window);
        }
        previous = Some(window);
    }
}

/// Square, borderless corners on Windows 11, where the system otherwise rounds
/// and outlines windows and the corner pixels would not be the fill colour.
/// Windows 10 refuses the attributes; that is fine.
fn square_corners(window: HWND) {
    let preference = DWMWCP_DONOTROUND;
    let border = DWMWA_COLOR_NONE;
    unsafe {
        let _ = DwmSetWindowAttribute(
            window,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            (&raw const preference).cast(),
            size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            window,
            DWMWA_BORDER_COLOR,
            (&raw const border).cast(),
            size_of::<u32>() as u32,
        );
    }
}

fn park_cursor(x: i32, y: i32) {
    unsafe { SetCursorPos(x, y) }.expect("could not move the cursor");
}

fn send(inputs: &[INPUT]) {
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    assert_eq!(sent as usize, inputs.len(), "Windows dropped some input");
}

fn key(code: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: code,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}

fn mouse(flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}

/// Press the keys in order, then release them in reverse.
fn press_keys(codes: &[VIRTUAL_KEY]) {
    for code in codes {
        send(&[key(*code, KEYBD_EVENT_FLAGS(0))]);
    }
    for code in codes.iter().rev() {
        send(&[key(*code, KEYEVENTF_KEYUP)]);
    }
}

fn press_capture_key() {
    press_keys(&[VK_CONTROL, VK_MENU, VK_SHIFT, VK_F9]);
}

/// Move to `(x, y)`. `SetCursorPos` places the cursor on the exact pixel, which
/// absolute `SendInput` coordinates (normalised to 0..65535) can round away from;
/// the zero relative move after it is what makes the move reach the app as input.
fn move_cursor(x: i32, y: i32) {
    unsafe { SetCursorPos(x, y) }.expect("could not move the cursor");
    send(&[mouse(MOUSEEVENTF_MOVE)]);
}

/// Press at `from`, move to `to` in steps and release there.
fn drag(from_x: i32, from_y: i32, to_x: i32, to_y: i32) {
    move_cursor(from_x, from_y);
    pump(Duration::from_millis(50));
    send(&[mouse(MOUSEEVENTF_LEFTDOWN)]);
    let steps = 10;
    for step in 1..=steps {
        move_cursor(
            from_x + (to_x - from_x) * step / steps,
            from_y + (to_y - from_y) * step / steps,
        );
        pump(Duration::from_millis(15));
    }
    let mut at = POINT::default();
    unsafe { GetCursorPos(&mut at) }.expect("could not read the cursor");
    assert_eq!(
        (at.x, at.y),
        (to_x, to_y),
        "the cursor is not on the end point"
    );
    send(&[mouse(MOUSEEVENTF_LEFTUP)]);
}

fn read_clipboard_png() -> Vec<u8> {
    let format = unsafe { RegisterClipboardFormatW(w!("PNG")) };
    assert_ne!(format, 0, "could not look up the PNG clipboard format");
    let mut opened = false;
    for _ in 0..50 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            opened = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(opened, "could not open the clipboard");
    let bytes = (|| {
        let handle = unsafe { GetClipboardData(format) }.ok()?;
        let memory = ::windows::Win32::Foundation::HGLOBAL(handle.0);
        let size = unsafe { GlobalSize(memory) };
        let data = unsafe { GlobalLock(memory) };
        if data.is_null() {
            return None;
        }
        let bytes = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), size) }.to_vec();
        let _ = unsafe { GlobalUnlock(memory) };
        Some(bytes)
    })();
    let _ = unsafe { CloseClipboard() };
    bytes.expect("the clipboard has no PNG")
}

/// Start the app as a test instance and collect its output into the guard's log.
fn spawn_app(guard: &mut Guard) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_cropa-desktop"))
        .env("CROPA_E2E_DIR", &guard.dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("could not start cropa-desktop");
    for pipe in [
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let log = Arc::clone(&guard.log);
        // Keeps draining until EOF: a full pipe would block the app's logging.
        std::thread::spawn(move || {
            // Not `lines()`: it stops at the first line that is not UTF-8.
            for line in BufReader::new(pipe).split(b'\n').map_while(Result::ok) {
                let line = String::from_utf8_lossy(&line);
                log.lock()
                    .unwrap()
                    .push(line.trim_end_matches('\r').to_owned());
            }
        });
    }
    APP_PID.store(child.id(), Ordering::SeqCst);
    guard.child = Some(child);
}

/// The four corners and four edge midpoints must all be the target colour.
fn assert_region_pixels(image: &image::RgbaImage) {
    let (last_x, last_y) = (REGION_WIDTH - 1, REGION_HEIGHT - 1);
    for (x, y) in [
        (0, 0),
        (last_x, 0),
        (0, last_y),
        (last_x, last_y),
        (last_x / 2, 0),
        (last_x / 2, last_y),
        (0, last_y / 2),
        (last_x, last_y / 2),
    ] {
        let pixel = image.get_pixel(x, y).0;
        let close = [pixel[0], pixel[1], pixel[2]]
            .iter()
            .zip([TARGET.0, TARGET.1, TARGET.2])
            .all(|(got, want)| got.abs_diff(want) <= 2);
        assert!(
            close,
            "pixel ({x}, {y}) is {:?} but the region is {TARGET:?} (the backdrop is {BACKDROP:?}); the crop is off",
            &pixel[..3]
        );
    }
}

/// A fresh test folder with a settings file that moves the capture key.
fn write_settings() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cropa-e2e-capture-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("config")).unwrap();
    std::fs::write(
        dir.join("config").join("settings.json"),
        format!(r#"{{"version": 4, "captureShortcut": "{CAPTURE_KEY}", "autostartAsked": true}}"#),
    )
    .unwrap();
    dir
}

/// A second capture cancelled with Esc leaves the clipboard as it was.
fn esc_cancels_and_keeps_the_clipboard(guard: &mut Guard) {
    let sequence = unsafe { GetClipboardSequenceNumber() };
    let mark = guard.lines();
    press_capture_key();
    wait_for_log(guard, mark, "region overlay shown", Duration::from_secs(10));
    press_keys(&[VK_ESCAPE]);
    wait_for_log(guard, mark, "capture cancelled", Duration::from_secs(10));
    wait_until(Duration::from_secs(5), "the overlay did not close", || {
        find_window(w!("CropaRegionOverlay")).is_none()
    });
    assert_eq!(
        unsafe { GetClipboardSequenceNumber() },
        sequence,
        "Esc changed the clipboard"
    );
    let png = read_clipboard_png();
    let kept = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
        .expect("the clipboard PNG does not decode after Esc");
    assert_eq!((kept.width(), kept.height()), (REGION_WIDTH, REGION_HEIGHT));
}
