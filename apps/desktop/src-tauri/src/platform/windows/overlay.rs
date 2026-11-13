//! Capture selection on Windows: one borderless topmost window per monitor shows
//! that monitor's frozen capture, dimmed, drawn with Direct2D. A small mode bar
//! (Region, Window, Full screen, Cancel) sits at the top of one monitor. In region
//! mode the user drags a rectangle that shows at full brightness with a size
//! readout and a magnifier; in window mode the window under the pointer is
//! highlighted and a click picks it; in full-screen mode a click picks the
//! monitor under the pointer.
//!
//! Every window is created and pumped on the calling thread, which runs its own
//! message loop until the user releases the mouse or cancels. Nothing here
//! touches Tauri.
// Pixel maths moves between u32 pixels, i32 desktop coordinates and f32
// drawing units; every value is a screen coordinate, far inside each range.
// Windows APIs take plain references where clippy asks for raw pointers.
#![allow(
    clippy::borrow_as_ptr,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap
)]

use std::cell::RefCell;
use std::sync::{Mutex, PoisonError};
use std::time::Instant;

use ::windows::Win32::Foundation::{
    ERROR_CLASS_ALREADY_EXISTS, GetLastError, HWND, LPARAM, LRESULT, POINT, WPARAM,
};
use ::windows::Win32::Graphics::Direct2D::Common::{
    D2D_RECT_F, D2D_SIZE_U, D2D1_ALPHA_MODE_IGNORE, D2D1_ALPHA_MODE_UNKNOWN, D2D1_COLOR_F,
    D2D1_PIXEL_FORMAT,
};
use ::windows::Win32::Graphics::Direct2D::{
    D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR, D2D1_BITMAP_PROPERTIES,
    D2D1_DRAW_TEXT_OPTIONS_NONE, D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_FEATURE_LEVEL_DEFAULT,
    D2D1_HWND_RENDER_TARGET_PROPERTIES, D2D1_PRESENT_OPTIONS_NONE, D2D1_RENDER_TARGET_PROPERTIES,
    D2D1_RENDER_TARGET_TYPE_DEFAULT, D2D1_RENDER_TARGET_USAGE_NONE, D2D1_ROUNDED_RECT,
    D2D1CreateFactory, ID2D1Bitmap, ID2D1Factory, ID2D1HwndRenderTarget, ID2D1SolidColorBrush,
    ID2D1StrokeStyle,
};
use ::windows::Win32::Graphics::DirectWrite::{
    DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL,
    DWRITE_FONT_WEIGHT_NORMAL, DWRITE_MEASURING_MODE_NATURAL, DWRITE_TEXT_METRICS,
    DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, IDWriteTextFormat,
    IDWriteTextLayout,
};
use ::windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_UNKNOWN};
use ::windows::Win32::Graphics::Gdi::{
    BeginPaint, EndPaint, InvalidateRect, PAINTSTRUCT, UpdateWindow,
};
use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    ReleaseCapture, SetCapture, SetFocus, VK_ESCAPE, VK_F, VK_R, VK_W,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW,
    IDC_ARROW, IDC_CROSS, LoadCursorW, MSG, PostQuitMessage, RegisterClassExW, SW_SHOW, SetCursor,
    SetForegroundWindow, ShowWindow, TranslateMessage, WM_ACTIVATEAPP, WM_CAPTURECHANGED, WM_CHAR,
    WM_CLOSE, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_PAINT,
    WM_RBUTTONUP, WM_SETCURSOR, WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};
use ::windows::core::{HRESULT, w};

use super::super::geometry::{
    BarButton, ModeBarLayout, Point, bar_button_at, client_point_to_desktop, crop_rect,
    mode_bar_layout, monitor_at, to_local,
};
use super::super::window_pick::{ListedWindow, MonitorView, Pick, pick};
use super::super::{
    CaptureMode, MonitorInfo, PixelRect, PlatformError, Result, RgbaImage, Selection,
};
use super::dpi::DpiGuard;
use super::window_list;
use crate::i18n::{CaptureText, Lang, capture_text};

const CLASS_NAME: ::windows::core::PCWSTR = w!("CropaRegionOverlay");
/// `D2DERR_RECREATE_TARGET`: the graphics device was lost.
const D2DERR_RECREATE_TARGET: HRESULT = HRESULT(0x8899_000Cu32 as i32);
/// Side of the magnified area, in capture pixels.
const LOUPE_CELLS: u32 = 15;
const LOUPE_ZOOM: f32 = 9.0;

/// The mode the next overlay opens in: the one the user last switched to.
/// Not persisted, so every app run starts in region mode.
static LAST_MODE: Mutex<CaptureMode> = Mutex::new(CaptureMode::Region);

#[allow(clippy::needless_pass_by_value)]
fn os_error(err: impl ToString) -> PlatformError {
    PlatformError::Os(err.to_string())
}

fn rect(left: f32, top: f32, right: f32, bottom: f32) -> D2D_RECT_F {
    D2D_RECT_F {
        left,
        top,
        right,
        bottom,
    }
}

fn color(r: f32, g: f32, b: f32, a: f32) -> D2D1_COLOR_F {
    D2D1_COLOR_F { r, g, b, a }
}

/// One overlay window and everything it draws with.
struct Win {
    hwnd: HWND,
    monitor: MonitorInfo,
    capture_width: u32,
    capture_height: u32,
    target: ID2D1HwndRenderTarget,
    bitmap: ID2D1Bitmap,
    format: IDWriteTextFormat,
    dim: ID2D1SolidColorBrush,
    border: ID2D1SolidColorBrush,
    shadow: ID2D1SolidColorBrush,
    label_bg: ID2D1SolidColorBrush,
    text: ID2D1SolidColorBrush,
    bar_bg: ID2D1SolidColorBrush,
    bar_active: ID2D1SolidColorBrush,
    bar_hover: ID2D1SolidColorBrush,
    bar: ModeBarLayout,
    /// Measured width and height of the four bar labels, in button order.
    label_sizes: [(f32, f32); 4],
}

impl Win {
    fn width(&self) -> f32 {
        self.monitor.width as f32
    }

    fn height(&self) -> f32 {
        self.monitor.height as f32
    }

    fn scale(&self) -> f32 {
        self.monitor.scale_factor
    }
}

struct Drag {
    monitor: usize,
    start: Point,
    current: Point,
}

struct Session {
    wins: Vec<Win>,
    dwrite: IDWriteFactory,
    text: CaptureText,
    mode: CaptureMode,
    /// The windows on screen, topmost first, in desktop pixels.
    windows: Vec<ListedWindow>,
    /// The monitors and their capture sizes, in the order of `wins`.
    views: Vec<MonitorView>,
    /// The monitor that shows the mode bar.
    bar_monitor: usize,
    bar_hover: Option<BarButton>,
    /// What window and full-screen mode would pick under the pointer.
    hover: Option<Pick>,
    /// A click in window or full-screen mode is waiting for its release.
    pressed: bool,
    /// A press on the Cancel button is waiting for its release.
    cancel_pressed: bool,
    drag: Option<Drag>,
    /// Where the magnifier is drawn: a monitor index and a desktop point.
    cursor: Option<(usize, Point)>,
    focused: HWND,
    /// True once the overlay has been the active application.
    active: bool,
    outcome: Option<Result<Option<Selection>>>,
}

impl Session {
    fn index_of(&self, hwnd: HWND) -> Option<usize> {
        self.wins.iter().position(|w| w.hwnd == hwnd)
    }

    fn all_hwnds(&self) -> Vec<HWND> {
        self.wins.iter().map(|w| w.hwnd).collect()
    }

    fn desktop_point(&self, index: usize, lparam: LPARAM) -> Point {
        client_point_to_desktop(&self.wins[index].monitor, lparam.0)
    }

    /// True when `point` is on the bar's monitor, so the bar can be hit there.
    fn on_bar_monitor(&self, point: Point) -> bool {
        monitor_at(self.wins.iter().map(|w| &w.monitor), point) == Some(self.bar_monitor)
    }

    /// The bar button under a desktop point.
    fn bar_button(&self, point: Point) -> Option<BarButton> {
        if !self.on_bar_monitor(point) {
            return None;
        }
        let win = &self.wins[self.bar_monitor];
        bar_button_at(&win.bar, point.x - win.monitor.x, point.y - win.monitor.y)
    }

    fn over_bar(&self, point: Point) -> bool {
        let win = &self.wins[self.bar_monitor];
        self.on_bar_monitor(point)
            && win
                .bar
                .bar
                .contains(point.x - win.monitor.x, point.y - win.monitor.y)
    }

    /// What window and full-screen mode would pick at `point`. The bar is
    /// never a target.
    fn hover_at(&self, point: Point) -> Option<Pick> {
        if self.over_bar(point) {
            return None;
        }
        pick(self.mode, &self.views, &self.windows, point)
    }

    /// The capture the user picked by releasing at `point` in window or
    /// full-screen mode.
    fn pick_at(&self, point: Point, released_at: Instant) -> Option<Selection> {
        let picked = self.hover_at(point)?;
        Some(Selection {
            monitor: picked.monitor,
            rect: picked.crop,
            mode: self.mode,
            released_at,
        })
    }
}

fn last_mode() -> CaptureMode {
    *LAST_MODE.lock().unwrap_or_else(PoisonError::into_inner)
}

thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

/// Run `f` on the session. `None` when there is no session or it is already
/// borrowed further up the stack; callers then fall back to default handling.
fn with<R>(f: impl FnOnce(&mut Session) -> Option<R>) -> Option<R> {
    SESSION.with(|cell| {
        let mut guard = cell.try_borrow_mut().ok()?;
        f(guard.as_mut()?)
    })
}

fn invalidate(hwnds: &[HWND]) {
    for &hwnd in hwnds {
        // SAFETY: `hwnd` is one of our live windows; a null rectangle repaints all of it.
        unsafe {
            let _ = InvalidateRect(Some(hwnd), None, false);
        }
    }
}

/// Record the result and stop the message loop.
fn finish(result: Result<Option<Selection>>) {
    let stored = with(|s| {
        if s.outcome.is_none() {
            s.outcome = Some(result);
        }
        Some(())
    });
    if stored.is_some() {
        // SAFETY: posts WM_QUIT to this thread's queue.
        unsafe { PostQuitMessage(0) };
    }
}

/// Owns the windows created so far. Dropping it ends the session and destroys
/// them, so no error path can leave a topmost window on screen.
#[derive(Default)]
struct Windows(Vec<HWND>);

impl Drop for Windows {
    fn drop(&mut self) {
        // Release the Direct2D objects before their windows go away.
        SESSION.with(|cell| {
            if let Ok(mut guard) = cell.try_borrow_mut() {
                guard.take();
            }
        });
        for &hwnd in &self.0 {
            // SAFETY: each window was created by this thread and is destroyed once.
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
        }
    }
}

fn register_class() -> Result<()> {
    // SAFETY: a null module name returns this executable's handle.
    let instance = unsafe { GetModuleHandleW(None) }.map_err(os_error)?;
    // SAFETY: loads a stock system cursor.
    let cursor = unsafe { LoadCursorW(None, IDC_CROSS) }.map_err(os_error)?;
    let class = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(wnd_proc),
        hInstance: instance.into(),
        hCursor: cursor,
        lpszClassName: CLASS_NAME,
        ..Default::default()
    };
    // SAFETY: `class` is fully initialised and its name is a static literal.
    if unsafe { RegisterClassExW(&class) } == 0 {
        // SAFETY: reads this thread's last error right after the failed call.
        let error = unsafe { GetLastError() };
        if error != ERROR_CLASS_ALREADY_EXISTS {
            return Err(os_error(::windows::core::Error::from(error)));
        }
    }
    Ok(())
}

fn bgra_pixels(image: &RgbaImage) -> Vec<u8> {
    let mut pixels = Vec::with_capacity(image.as_raw().len());
    for pixel in image.pixels() {
        let [r, g, b, _] = pixel.0;
        pixels.extend_from_slice(&[b, g, r, 255]);
    }
    pixels
}

/// The 14 pt label font at `scale`.
fn text_format(dwrite: &IDWriteFactory, scale: f32) -> Result<IDWriteTextFormat> {
    // SAFETY: the family and locale are static literals; no custom font collection.
    unsafe {
        dwrite.CreateTextFormat(
            w!("Segoe UI"),
            None::<&IDWriteFontCollection>,
            DWRITE_FONT_WEIGHT_NORMAL,
            DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL,
            14.0 * scale,
            w!("en-us"),
        )
    }
    .map_err(os_error)
}

/// The mode bar layout for `monitor`, with the measured size of each label.
fn build_bar(
    dwrite: &IDWriteFactory,
    format: &IDWriteTextFormat,
    monitor: &MonitorInfo,
    text: &CaptureText,
) -> Result<(ModeBarLayout, [(f32, f32); 4])> {
    let labels = [text.region, text.window, text.full_screen, text.cancel];
    let mut sizes = [(0.0, 0.0); 4];
    for (size, label) in sizes.iter_mut().zip(labels) {
        *size = measure_text(dwrite, format, label).map_err(os_error)?;
    }
    let tallest = sizes.iter().fold(0.0, |tallest, &(_, h)| h.max(tallest));
    let layout = mode_bar_layout(
        monitor.width,
        monitor.scale_factor,
        sizes.map(|(width, _)| width),
        tallest,
    );
    Ok((layout, sizes))
}

fn create_window(
    d2d: &ID2D1Factory,
    dwrite: &IDWriteFactory,
    monitor: &MonitorInfo,
    capture: &RgbaImage,
    text: &CaptureText,
    windows: &mut Windows,
) -> Result<Win> {
    // SAFETY: the class is registered, the window is a plain popup with no parent, and it
    // is not shown yet.
    let hwnd = unsafe {
        let instance = GetModuleHandleW(None).map_err(os_error)?;
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            CLASS_NAME,
            w!(""),
            WS_POPUP,
            monitor.x,
            monitor.y,
            monitor.width as i32,
            monitor.height as i32,
            None,
            None,
            Some(instance.into()),
            None,
        )
    }
    .map_err(os_error)?;
    windows.0.push(hwnd);

    let target_properties = D2D1_RENDER_TARGET_PROPERTIES {
        r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_UNKNOWN,
            alphaMode: D2D1_ALPHA_MODE_UNKNOWN,
        },
        // 96 dpi makes one drawing unit one physical pixel.
        dpiX: 96.0,
        dpiY: 96.0,
        usage: D2D1_RENDER_TARGET_USAGE_NONE,
        minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
    };
    let window_properties = D2D1_HWND_RENDER_TARGET_PROPERTIES {
        hwnd,
        pixelSize: D2D_SIZE_U {
            width: monitor.width,
            height: monitor.height,
        },
        presentOptions: D2D1_PRESENT_OPTIONS_NONE,
    };
    // SAFETY: both property structs are fully initialised and outlive the call.
    let target = unsafe { d2d.CreateHwndRenderTarget(&target_properties, &window_properties) }
        .map_err(os_error)?;

    let pixels = bgra_pixels(capture);
    let bitmap_properties = D2D1_BITMAP_PROPERTIES {
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_IGNORE,
        },
        dpiX: 96.0,
        dpiY: 96.0,
    };
    // SAFETY: `pixels` holds width * height * 4 bytes, matching the size and pitch given.
    let bitmap = unsafe {
        target.CreateBitmap(
            D2D_SIZE_U {
                width: capture.width(),
                height: capture.height(),
            },
            Some(pixels.as_ptr().cast()),
            capture.width() * 4,
            &bitmap_properties,
        )
    }
    .map_err(os_error)?;

    let brush = |c: D2D1_COLOR_F| -> Result<ID2D1SolidColorBrush> {
        // SAFETY: `c` outlives the call; no brush properties.
        unsafe { target.CreateSolidColorBrush(&c, None) }.map_err(os_error)
    };
    let dim = brush(color(0.0, 0.0, 0.0, 0.5))?;
    let border = brush(color(1.0, 1.0, 1.0, 1.0))?;
    let shadow = brush(color(0.0, 0.0, 0.0, 0.85))?;
    let label_bg = brush(color(0.0, 0.0, 0.0, 0.75))?;
    let text_brush = brush(color(1.0, 1.0, 1.0, 1.0))?;
    let bar_bg = brush(color(32.0 / 255.0, 32.0 / 255.0, 32.0 / 255.0, 0.92))?;
    let bar_active = brush(color(1.0, 1.0, 1.0, 0.22))?;
    let bar_hover = brush(color(1.0, 1.0, 1.0, 0.10))?;

    let format = text_format(dwrite, monitor.scale_factor)?;
    let (bar, label_sizes) = build_bar(dwrite, &format, monitor, text)?;

    Ok(Win {
        hwnd,
        monitor: monitor.clone(),
        capture_width: capture.width(),
        capture_height: capture.height(),
        target,
        bitmap,
        format,
        dim,
        border,
        shadow,
        label_bg,
        text: text_brush,
        bar_bg,
        bar_active,
        bar_hover,
        bar,
        label_sizes,
    })
}

/// Run this thread's message loop until `WM_QUIT`; an error if it breaks.
fn pump_messages() -> Option<PlatformError> {
    let mut message = MSG::default();
    loop {
        // SAFETY: `message` is a valid out pointer; this thread owns the windows.
        let status = unsafe { GetMessageW(&mut message, None, 0, 0) };
        match status.0 {
            0 => return None,
            -1 => return Some(os_error(::windows::core::Error::from_thread())),
            _ => {
                // SAFETY: `message` was filled by GetMessageW.
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        }
    }
}

/// Each monitor with the size of its capture.
fn monitor_views(shots: &[(MonitorInfo, RgbaImage)]) -> Vec<MonitorView> {
    shots
        .iter()
        .map(|(monitor, capture)| MonitorView {
            monitor: monitor.clone(),
            capture_width: capture.width(),
            capture_height: capture.height(),
        })
        .collect()
}

/// The pickable windows. The thread is per-monitor DPI aware by now, so the
/// bounds are physical. A failure leaves window mode with nothing to pick; the
/// capture itself still works.
fn list_windows() -> Vec<ListedWindow> {
    let listed = Instant::now();
    let windows = window_list::listed_on_screen().unwrap_or_else(|err| {
        log::warn!("could not list the windows to pick: {err}");
        Vec::new()
    });
    log::info!(
        "listed {} window(s) in {} ms",
        windows.len(),
        listed.elapsed().as_millis()
    );
    windows
}

pub fn select_region(shots: &[(MonitorInfo, RgbaImage)]) -> Result<Option<Selection>> {
    let started = Instant::now();
    if shots.is_empty() {
        return Err(os_error("there is no monitor to cover"));
    }
    let _dpi = DpiGuard::per_monitor();
    // First, so the bounds are as close as possible to the frozen capture.
    let windows_on_screen = list_windows();

    // SAFETY: creates single-threaded factories used only on this thread.
    let d2d: ID2D1Factory =
        unsafe { D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None) }.map_err(os_error)?;
    // SAFETY: as above.
    let dwrite: IDWriteFactory =
        unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) }.map_err(os_error)?;
    register_class()?;

    let text = capture_text(Lang::detect());

    // Declared before the windows are created so it is dropped after the
    // message loop, or on any error below.
    let mut windows = Windows::default();
    let mut wins = Vec::with_capacity(shots.len());
    for (monitor, capture) in shots {
        wins.push(create_window(
            &d2d,
            &dwrite,
            monitor,
            capture,
            &text,
            &mut windows,
        )?);
    }

    let monitors: Vec<&MonitorInfo> = shots.iter().map(|(m, _)| m).collect();
    let mut cursor_at = POINT::default();
    // SAFETY: `cursor_at` is a valid out pointer.
    let have_cursor = unsafe { GetCursorPos(&mut cursor_at) }.is_ok();
    let cursor_point = Point {
        x: cursor_at.x,
        y: cursor_at.y,
    };
    let under_cursor = if have_cursor {
        monitor_at(monitors.iter().copied(), cursor_point)
    } else {
        None
    };
    let first = under_cursor.unwrap_or(0);
    let focus_target = wins[first].hwnd;
    let all: Vec<HWND> = wins.iter().map(|w| w.hwnd).collect();

    let mut session = Session {
        wins,
        dwrite,
        text,
        mode: last_mode(),
        windows: windows_on_screen,
        views: monitor_views(shots),
        bar_monitor: first,
        bar_hover: None,
        hover: None,
        pressed: false,
        cancel_pressed: false,
        drag: None,
        cursor: under_cursor.map(|i| (i, cursor_point)),
        focused: focus_target,
        active: false,
        outcome: None,
    };
    // Window and full-screen mode show their highlight before the first move.
    if have_cursor {
        session.hover = session.hover_at(cursor_point);
    }
    SESSION.with(|cell| *cell.borrow_mut() = Some(session));

    for &hwnd in &all {
        // SAFETY: our own live window; UpdateWindow paints it once, synchronously.
        // No session borrow is held across these calls.
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = UpdateWindow(hwnd);
        }
    }
    // SAFETY: our own live window.
    if !unsafe { SetForegroundWindow(focus_target) }.as_bool() {
        log::warn!("Windows did not give the region overlay the keyboard focus");
    }
    // SAFETY: as above.
    if let Err(err) = unsafe { SetFocus(Some(focus_target)) } {
        log::warn!("could not focus the region overlay: {err}");
    }
    log::info!(
        "region overlay shown on {} monitor(s) in {} ms",
        all.len(),
        started.elapsed().as_millis()
    );

    let loop_error = pump_messages();

    let outcome = with(|s| s.outcome.take());
    drop(windows);
    match (loop_error, outcome) {
        (Some(err), _) => Err(err),
        (None, Some(result)) => result,
        (None, None) => Ok(None),
    }
}

/// Extra measured text and its box, drawn at a position chosen from the box size.
fn draw_label(
    win: &Win,
    dwrite: &IDWriteFactory,
    text: &str,
    place: impl FnOnce(f32, f32) -> (f32, f32),
) -> ::windows::core::Result<()> {
    let wide: Vec<u16> = text.encode_utf16().collect();
    // SAFETY: `wide` and the format outlive the call.
    let layout: IDWriteTextLayout =
        unsafe { dwrite.CreateTextLayout(&wide, &win.format, 4000.0, 200.0) }?;
    let mut metrics = DWRITE_TEXT_METRICS::default();
    // SAFETY: `metrics` is a valid out pointer.
    unsafe { layout.GetMetrics(&mut metrics) }?;

    let s = win.scale();
    let (pad_x, pad_y) = (8.0 * s, 4.0 * s);
    let (box_w, box_h) = (metrics.width + 2.0 * pad_x, metrics.height + 2.0 * pad_y);
    let (x, y) = place(box_w, box_h);
    let x = x.clamp(0.0, (win.width() - box_w).max(0.0));
    let y = y.clamp(0.0, (win.height() - box_h).max(0.0));
    let rounded = D2D1_ROUNDED_RECT {
        rect: rect(x, y, x + box_w, y + box_h),
        radiusX: 4.0 * s,
        radiusY: 4.0 * s,
    };
    // SAFETY: drawing between BeginDraw and EndDraw with live resources.
    unsafe {
        win.target.FillRoundedRectangle(&rounded, &win.label_bg);
        win.target.DrawText(
            &wide,
            &win.format,
            &rect(
                x + pad_x,
                y + pad_y,
                x + pad_x + metrics.width + 1.0,
                y + pad_y + metrics.height + 1.0,
            ),
            &win.text,
            D2D1_DRAW_TEXT_OPTIONS_NONE,
            DWRITE_MEASURING_MODE_NATURAL,
        );
    }
    Ok(())
}

/// A 15 x 15 capture-pixel area around `local` (monitor pixels), magnified.
fn draw_magnifier(win: &Win, local: (u32, u32)) {
    let (cw, ch) = (win.capture_width, win.capture_height);
    let (mw, mh) = (win.monitor.width.max(1), win.monitor.height.max(1));
    if cw < LOUPE_CELLS || ch < LOUPE_CELLS {
        return;
    }
    let s = win.scale();
    let zoom = (LOUPE_ZOOM * s).round().max(1.0);
    let size = LOUPE_CELLS as f32 * zoom;

    // The capture pixel under the cursor, then a window of cells kept inside the bitmap.
    let cx = ((u64::from(local.0.min(mw - 1)) * u64::from(cw)) / u64::from(mw)) as u32;
    let cy = ((u64::from(local.1.min(mh - 1)) * u64::from(ch)) / u64::from(mh)) as u32;
    let x0 = cx.saturating_sub(LOUPE_CELLS / 2).min(cw - LOUPE_CELLS);
    let y0 = cy.saturating_sub(LOUPE_CELLS / 2).min(ch - LOUPE_CELLS);
    let source = rect(
        x0 as f32,
        y0 as f32,
        (x0 + LOUPE_CELLS) as f32,
        (y0 + LOUPE_CELLS) as f32,
    );

    let offset = 24.0 * s;
    let (px, py) = (local.0 as f32, local.1 as f32);
    let mut left = px + offset;
    if left + size > win.width() {
        left = px - offset - size;
    }
    let mut top = py + offset;
    if top + size > win.height() {
        top = py - offset - size;
    }
    let (left, top) = (left.max(0.0), top.max(0.0));
    let dest = rect(left, top, left + size, top + size);

    let cell_left = left + (cx - x0) as f32 * zoom;
    let cell_top = top + (cy - y0) as f32 * zoom;
    let cell = rect(cell_left, cell_top, cell_left + zoom, cell_top + zoom);
    let cell_outer = rect(
        cell.left - 1.0,
        cell.top - 1.0,
        cell.right + 1.0,
        cell.bottom + 1.0,
    );
    let frame = rect(left - 1.0, top - 1.0, left + size + 1.0, top + size + 1.0);

    // SAFETY: drawing between BeginDraw and EndDraw with live resources.
    unsafe {
        win.target.DrawBitmap(
            &win.bitmap,
            Some(&dest),
            1.0,
            D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
            Some(&source),
        );
        win.target
            .DrawRectangle(&frame, &win.border, 1.0, None::<&ID2D1StrokeStyle>);
        win.target
            .DrawRectangle(&cell_outer, &win.shadow, 1.0, None::<&ID2D1StrokeStyle>);
        win.target
            .DrawRectangle(&cell, &win.border, 1.0, None::<&ID2D1StrokeStyle>);
    }
}

/// The width and height of `text` set in `format`.
fn measure_text(
    dwrite: &IDWriteFactory,
    format: &IDWriteTextFormat,
    text: &str,
) -> ::windows::core::Result<(f32, f32)> {
    let wide: Vec<u16> = text.encode_utf16().collect();
    // SAFETY: `wide` and the format outlive the call.
    let layout: IDWriteTextLayout =
        unsafe { dwrite.CreateTextLayout(&wide, format, 4000.0, 200.0) }?;
    let mut metrics = DWRITE_TEXT_METRICS::default();
    // SAFETY: `metrics` is a valid out pointer.
    unsafe { layout.GetMetrics(&mut metrics) }?;
    Ok((metrics.width, metrics.height))
}

/// Draw the pixels `source` of the capture at full brightness into `dest`
/// (monitor pixels), outlined, with a size readout next to it.
fn draw_highlight(
    win: &Win,
    dwrite: &IDWriteFactory,
    dest: D2D_RECT_F,
    source: PixelRect,
) -> ::windows::core::Result<()> {
    let s = win.scale();
    let (left, top, bottom) = (dest.left, dest.top, dest.bottom);
    let source_rect = rect(
        source.x as f32,
        source.y as f32,
        (source.x + source.width) as f32,
        (source.y + source.height) as f32,
    );
    let outline = rect(left - 0.5, top - 0.5, dest.right + 0.5, bottom + 0.5);
    // SAFETY: drawing between BeginDraw and EndDraw with live resources.
    unsafe {
        win.target.DrawBitmap(
            &win.bitmap,
            Some(&dest),
            1.0,
            D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
            Some(&source_rect),
        );
        win.target
            .DrawRectangle(&outline, &win.border, 1.0, None::<&ID2D1StrokeStyle>);
    }
    let readout = format!("{} × {}", source.width, source.height);
    draw_label(win, dwrite, &readout, |_, box_h| {
        let gap = 6.0 * s;
        if bottom + gap + box_h <= win.height() {
            (left, bottom + gap)
        } else if top - gap - box_h >= 0.0 {
            (left, top - gap - box_h)
        } else {
            (left + gap, top + gap)
        }
    })
}

/// The mode bar: a rounded panel with one label per button, the current mode
/// filled and the hovered button lightly filled.
fn draw_bar(session: &Session, win: &Win) {
    let texts = [
        session.text.region,
        session.text.window,
        session.text.full_screen,
        session.text.cancel,
    ];
    let to_rect = |r: super::super::geometry::LocalRect| {
        rect(
            r.x as f32,
            r.y as f32,
            (r.x + r.width) as f32,
            (r.y + r.height) as f32,
        )
    };
    let panel = D2D1_ROUNDED_RECT {
        rect: to_rect(win.bar.bar),
        radiusX: win.bar.radius,
        radiusY: win.bar.radius,
    };
    // SAFETY: drawing between BeginDraw and EndDraw with live resources.
    unsafe { win.target.FillRoundedRectangle(&panel, &win.bar_bg) };

    for (((button, button_rect), text), (label_w, label_h)) in
        win.bar.buttons.iter().zip(texts).zip(win.label_sizes)
    {
        let selected = matches!(
            (button, session.mode),
            (BarButton::Region, CaptureMode::Region)
                | (BarButton::Window, CaptureMode::Window)
                | (BarButton::FullScreen, CaptureMode::FullScreen)
        );
        let fill = if selected {
            Some(&win.bar_active)
        } else if session.bar_hover == Some(*button) {
            Some(&win.bar_hover)
        } else {
            None
        };
        let area = to_rect(*button_rect);
        let wide: Vec<u16> = text.encode_utf16().collect();
        let left = area.left + (area.right - area.left - label_w) / 2.0;
        let top = area.top + (area.bottom - area.top - label_h) / 2.0;
        // SAFETY: drawing between BeginDraw and EndDraw with live resources.
        unsafe {
            if let Some(fill) = fill {
                let rounded = D2D1_ROUNDED_RECT {
                    rect: area,
                    radiusX: win.bar.button_radius,
                    radiusY: win.bar.button_radius,
                };
                win.target.FillRoundedRectangle(&rounded, fill);
            }
            win.target.DrawText(
                &wide,
                &win.format,
                &rect(left, top, left + label_w + 1.0, top + label_h + 1.0),
                &win.text,
                D2D1_DRAW_TEXT_OPTIONS_NONE,
                DWRITE_MEASURING_MODE_NATURAL,
            );
        }
    }
}

/// The hint line for the current mode, with the key shortcuts after it.
fn hint_text(session: &Session) -> String {
    let mode_hint = match session.mode {
        CaptureMode::Region => session.text.hint,
        CaptureMode::Window => session.text.window_hint,
        CaptureMode::FullScreen => session.text.full_screen_hint,
    };
    format!("{mode_hint} · {}", session.text.keys_hint)
}

/// Draw window `index` completely: the frozen capture, the dim, the selection or
/// highlight, the mode bar, the hint or the readout, and the magnifier.
fn draw(session: &Session, index: usize) -> ::windows::core::Result<()> {
    let win = &session.wins[index];
    let full = rect(0.0, 0.0, win.width(), win.height());

    // SAFETY: drawing between BeginDraw and EndDraw with live resources.
    unsafe {
        win.target.DrawBitmap(
            &win.bitmap,
            Some(&full),
            1.0,
            D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
            None,
        );
        win.target.FillRectangle(&full, &win.dim);
    }

    match session.mode {
        CaptureMode::Region => {
            if let Some(drag) = &session.drag
                && drag.monitor == index
            {
                let selection = crop_rect(
                    &win.monitor,
                    win.capture_width,
                    win.capture_height,
                    drag.start,
                    drag.current,
                );
                if let Some(selection) = selection {
                    let (sx, sy) = to_local(&win.monitor, drag.start);
                    let (ex, ey) = to_local(&win.monitor, drag.current);
                    let dest = rect(
                        sx.min(ex) as f32,
                        sy.min(ey) as f32,
                        (sx.max(ex) + 1) as f32,
                        (sy.max(ey) + 1) as f32,
                    );
                    draw_highlight(win, &session.dwrite, dest, selection)?;
                }
            }
        }
        CaptureMode::Window => {
            if let Some(hover) = session.hover
                && hover.monitor == index
            {
                let local = hover.local;
                let dest = rect(
                    local.x as f32,
                    local.y as f32,
                    (local.x + local.width) as f32,
                    (local.y + local.height) as f32,
                );
                draw_highlight(win, &session.dwrite, dest, hover.crop)?;
            }
        }
        CaptureMode::FullScreen => {
            if session.hover.is_some_and(|h| h.monitor == index) {
                let inset = rect(1.5, 1.5, win.width() - 1.5, win.height() - 1.5);
                // SAFETY: drawing between BeginDraw and EndDraw with live resources.
                unsafe {
                    win.target.DrawBitmap(
                        &win.bitmap,
                        Some(&full),
                        1.0,
                        D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
                        None,
                    );
                    win.target
                        .DrawRectangle(&inset, &win.border, 1.0, None::<&ID2D1StrokeStyle>);
                }
            }
        }
    }

    if index == session.bar_monitor {
        draw_bar(session, win);
    }

    if session.drag.is_none() {
        let hint = hint_text(session);
        let below_bar = (win.bar.bar.y + win.bar.bar.height) as f32 + 8.0 * win.scale();
        draw_label(win, &session.dwrite, &hint, |box_w, _| {
            ((win.width() - box_w) / 2.0, below_bar)
        })?;
    }

    if session.mode == CaptureMode::Region
        && let Some((monitor, point)) = session.cursor
        && monitor == index
    {
        draw_magnifier(win, to_local(&win.monitor, point));
    }
    Ok(())
}

fn paint(hwnd: HWND) {
    let mut ps = PAINTSTRUCT::default();
    // SAFETY: `ps` is a valid out pointer for our own window.
    unsafe { BeginPaint(hwnd, &mut ps) };
    let result = with(|s| {
        let index = s.index_of(hwnd)?;
        // SAFETY: the render target belongs to this window and this thread.
        unsafe { s.wins[index].target.BeginDraw() };
        let drawn = draw(s, index);
        // SAFETY: pairs with the BeginDraw above.
        let ended = unsafe { s.wins[index].target.EndDraw(None, None) };
        Some(drawn.and(ended))
    });
    // SAFETY: pairs with BeginPaint.
    unsafe {
        let _ = EndPaint(hwnd, &ps);
    }
    if let Some(Err(err)) = result {
        if err.code() == D2DERR_RECREATE_TARGET {
            log::warn!("the graphics device was lost while drawing the region overlay");
        }
        finish(Err(os_error(err)));
    }
}

/// Switch to `mode`: abandon any drag or click in progress, recompute what the
/// pointer is over, and remember the mode for the next capture.
fn switch_mode(mode: CaptureMode) {
    let all = with(|s| {
        if s.mode == mode {
            return None;
        }
        s.mode = mode;
        s.drag = None;
        s.pressed = false;
        s.cancel_pressed = false;
        let point = s.cursor.map(|(_, point)| point);
        s.hover = point.and_then(|point| s.hover_at(point));
        *LAST_MODE.lock().unwrap_or_else(PoisonError::into_inner) = mode;
        Some(s.all_hwnds())
    });
    if let Some(all) = all {
        // SAFETY: ends a mouse capture this thread may hold; harmless without one. The
        // drag and click are already cleared, so the WM_CAPTURECHANGED it sends changes
        // nothing.
        unsafe {
            let _ = ReleaseCapture();
        }
        invalidate(&all);
    }
}

/// What a button press did, decided while the session is borrowed.
enum Press {
    Bar(BarButton),
    Started(HWND, Vec<HWND>),
    Ignored,
}

fn on_button_down(hwnd: HWND, lparam: LPARAM) {
    let press = with(|s| {
        let index = s.index_of(hwnd)?;
        let point = s.desktop_point(index, lparam);
        if let Some(button) = s.bar_button(point) {
            if button == BarButton::Cancel {
                // Acts on release, so the release does not land in the app underneath.
                s.cancel_pressed = true;
                return Some(Press::Started(hwnd, s.all_hwnds()));
            }
            return Some(Press::Bar(button));
        }
        if s.over_bar(point) {
            return Some(Press::Ignored);
        }
        match s.mode {
            CaptureMode::Region => {
                s.drag = Some(Drag {
                    monitor: index,
                    start: point,
                    current: point,
                });
                s.cursor = Some((index, point));
            }
            CaptureMode::Window | CaptureMode::FullScreen => s.pressed = true,
        }
        Some(Press::Started(hwnd, s.all_hwnds()))
    });
    match press {
        Some(Press::Bar(BarButton::Region)) => switch_mode(CaptureMode::Region),
        Some(Press::Bar(BarButton::Window)) => switch_mode(CaptureMode::Window),
        Some(Press::Bar(BarButton::FullScreen)) => switch_mode(CaptureMode::FullScreen),
        Some(Press::Started(hwnd, all)) => {
            // SAFETY: capture follows the press so the release arrives even outside the window.
            unsafe { SetCapture(hwnd) };
            invalidate(&all);
        }
        Some(Press::Bar(BarButton::Cancel) | Press::Ignored) | None => {}
    }
}

fn on_mouse_move(hwnd: HWND, lparam: LPARAM) {
    let update = with(|s| {
        let index = s.index_of(hwnd)?;
        let point = s.desktop_point(index, lparam);
        let mut dirty = Vec::new();
        let magnifier = s.mode == CaptureMode::Region;
        if let Some((previous, _)) = s.cursor
            && magnifier
        {
            dirty.push(s.wins[previous].hwnd);
        }
        if let Some(drag) = &mut s.drag {
            drag.current = point;
            s.cursor = Some((drag.monitor, point));
            dirty.push(s.wins[drag.monitor].hwnd);
        } else {
            let monitors = s.wins.iter().map(|w| &w.monitor);
            let hovered = monitor_at(monitors, point).unwrap_or(index);
            s.cursor = Some((hovered, point));
            if magnifier {
                dirty.push(s.wins[hovered].hwnd);
            }
        }

        // Repaint only what the highlight or the bar hover changed.
        let hover = s.hover_at(point);
        if hover != s.hover {
            for old_or_new in [s.hover, hover].into_iter().flatten() {
                dirty.push(s.wins[old_or_new.monitor].hwnd);
            }
            s.hover = hover;
        }
        let bar_hover = s.bar_button(point);
        if bar_hover != s.bar_hover {
            s.bar_hover = bar_hover;
            dirty.push(s.wins[s.bar_monitor].hwnd);
        }
        dirty.dedup();

        // Keep the keyboard on the monitor the pointer is over, so Esc works there.
        let focus = match (&s.drag, s.cursor) {
            (None, Some((hovered, _))) if s.wins[hovered].hwnd != s.focused => {
                s.focused = s.wins[hovered].hwnd;
                Some(s.focused)
            }
            _ => None,
        };
        Some((dirty, focus))
    });
    if let Some((dirty, focus)) = update {
        if let Some(focus) = focus {
            // SAFETY: our own live window, on this thread.
            unsafe {
                let _ = SetFocus(Some(focus));
            }
        }
        invalidate(&dirty);
    }
}

fn on_button_up(hwnd: HWND, lparam: LPARAM) {
    let released_at = Instant::now();
    let cancel = with(|s| {
        if !s.cancel_pressed {
            return None;
        }
        s.cancel_pressed = false;
        let point = s.desktop_point(s.index_of(hwnd)?, lparam);
        Some(s.bar_button(point) == Some(BarButton::Cancel))
    });
    if let Some(confirmed) = cancel {
        // SAFETY: ends the press's mouse capture; the press is already cleared.
        unsafe {
            let _ = ReleaseCapture();
        }
        if confirmed {
            finish(Ok(None));
        }
        return;
    }
    let step = with(|s| {
        if s.mode == CaptureMode::Region {
            let drag = s.drag.take()?;
            // The release carries where the button went up; the last move the
            // overlay handled can be older when the pointer moved just before.
            // `crop_rect` clamps it to the drag's monitor, as it does a move.
            let end = s
                .index_of(hwnd)
                .map_or(drag.current, |index| s.desktop_point(index, lparam));
            let win = &s.wins[drag.monitor];
            let rect = crop_rect(
                &win.monitor,
                win.capture_width,
                win.capture_height,
                drag.start,
                end,
            );
            Some((
                rect.map(|rect| Selection {
                    monitor: drag.monitor,
                    rect,
                    mode: CaptureMode::Region,
                    released_at,
                }),
                s.all_hwnds(),
            ))
        } else {
            if !s.pressed {
                return None;
            }
            s.pressed = false;
            let index = s.index_of(hwnd)?;
            let point = s.desktop_point(index, lparam);
            Some((s.pick_at(point, released_at), s.all_hwnds()))
        }
    });
    let Some((selection, all)) = step else {
        return;
    };
    // SAFETY: ends the press's mouse capture; the press is already cleared, so the
    // WM_CAPTURECHANGED this sends changes nothing.
    unsafe {
        let _ = ReleaseCapture();
    }
    match selection {
        Some(selection) => finish(Ok(Some(selection))),
        // A click without a drag, or on nothing: keep the overlay open and start over.
        None => invalidate(&all),
    }
}

fn on_capture_changed(lparam: LPARAM) {
    let all = with(|s| {
        if s.drag.is_none() && !s.pressed && !s.cancel_pressed {
            return None;
        }
        let gained = lparam.0;
        if s.wins.iter().any(|w| w.hwnd.0 as isize == gained) {
            return None;
        }
        s.drag = None;
        s.pressed = false;
        s.cancel_pressed = false;
        Some(s.all_hwnds())
    });
    if let Some(all) = all {
        invalidate(&all);
    }
}

fn on_activate_app(active: bool) {
    let left = with(|s| {
        if active {
            s.active = true;
            None
        } else {
            s.active.then_some(())
        }
    });
    if left.is_some() {
        // The user switched away; a topmost overlay must never be stranded.
        finish(Ok(None));
    }
}

/// True when the pointer is over the mode bar or the mode picks a target by
/// clicking: both want the arrow, region mode wants the crosshair.
fn wants_arrow_cursor() -> bool {
    with(|s| {
        if s.mode != CaptureMode::Region {
            return Some(true);
        }
        let mut at = POINT::default();
        // SAFETY: `at` is a valid out pointer.
        unsafe { GetCursorPos(&mut at) }.ok()?;
        Some(s.over_bar(Point { x: at.x, y: at.y }))
    })
    .unwrap_or(false)
}

/// The mode a typed character switches to: R, W (or the `ư` a Vietnamese
/// input method makes of it) and F, in either case.
fn mode_for_char(unit: usize) -> Option<CaptureMode> {
    match char::from_u32(u32::try_from(unit).ok()?)? {
        'r' | 'R' => Some(CaptureMode::Region),
        'w' | 'W' | 'ư' | 'Ư' => Some(CaptureMode::Window),
        'f' | 'F' => Some(CaptureMode::FullScreen),
        _ => None,
    }
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_SETCURSOR => {
            let stock = if wants_arrow_cursor() {
                IDC_ARROW
            } else {
                IDC_CROSS
            };
            // SAFETY: loads and sets a stock cursor.
            unsafe {
                if let Ok(cursor) = LoadCursorW(None, stock) {
                    SetCursor(Some(cursor));
                }
            }
            LRESULT(1)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_PAINT => {
            paint(hwnd);
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            on_button_down(hwnd, lparam);
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            on_mouse_move(hwnd, lparam);
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            on_button_up(hwnd, lparam);
            LRESULT(0)
        }
        WM_CLOSE | WM_RBUTTONUP => {
            finish(Ok(None));
            LRESULT(0)
        }
        WM_KEYDOWN if wparam.0 == usize::from(VK_ESCAPE.0) => {
            finish(Ok(None));
            LRESULT(0)
        }
        WM_KEYDOWN if wparam.0 == usize::from(VK_R.0) => {
            switch_mode(CaptureMode::Region);
            LRESULT(0)
        }
        WM_KEYDOWN if wparam.0 == usize::from(VK_W.0) => {
            switch_mode(CaptureMode::Window);
            LRESULT(0)
        }
        WM_KEYDOWN if wparam.0 == usize::from(VK_F.0) => {
            switch_mode(CaptureMode::FullScreen);
            LRESULT(0)
        }
        // Input tools such as Unikey swallow a lone W and resend it as a character.
        WM_CHAR => match mode_for_char(wparam.0) {
            Some(mode) => {
                switch_mode(mode);
                LRESULT(0)
            }
            // SAFETY: forwards an unhandled message with the arguments we received.
            None => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        },
        WM_ACTIVATEAPP => {
            on_activate_app(wparam.0 != 0);
            LRESULT(0)
        }
        WM_CAPTURECHANGED => {
            on_capture_changed(lparam);
            LRESULT(0)
        }
        // SAFETY: forwards an unhandled message with the arguments we received.
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}
