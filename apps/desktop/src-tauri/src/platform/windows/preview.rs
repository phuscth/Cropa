//! The floating preview on Windows: a small topmost card in the corner of the
//! work area that shows the capture just taken, with Edit and close buttons
//! while the pointer is over it.
//!
//! The window is layered and never takes the keyboard focus by itself. It is
//! drawn with Direct2D into a 32-bit DIB and shown with per-pixel alpha, so
//! the rounded corners and the shadow blend with whatever is behind it.
//!
//! One thread per preview owns every Win32 object and runs the message loop.
//! The caller gets a [`PreviewHandle`]: the user's choice arrives on its
//! channel, and its closer takes the preview down from any thread.
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
use std::mem::ManuallyDrop;

use ::windows::Win32::Graphics::Direct2D::{
    D2D1_ANTIALIAS_MODE_PER_PRIMITIVE, D2D1_LAYER_OPTIONS_NONE, D2D1_LAYER_PARAMETERS,
    ID2D1Geometry, ID2D1Layer, ID2D1RoundedRectangleGeometry,
};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, PoisonError};

use ::windows::Win32::Foundation::{
    COLORREF, ERROR_CLASS_ALREADY_EXISTS, GetLastError, HWND, LPARAM, LRESULT, POINT, RECT, SIZE,
    WPARAM,
};
use ::windows::Win32::Graphics::Direct2D::Common::{
    D2D_RECT_F, D2D_SIZE_U, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COLOR_F, D2D1_PIXEL_FORMAT,
};
use ::windows::Win32::Graphics::Direct2D::{
    D2D1_BITMAP_BRUSH_PROPERTIES, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR, D2D1_BITMAP_PROPERTIES,
    D2D1_BRUSH_PROPERTIES, D2D1_DRAW_TEXT_OPTIONS_NONE, D2D1_EXTEND_MODE_CLAMP,
    D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_FEATURE_LEVEL_DEFAULT, D2D1_RENDER_TARGET_PROPERTIES,
    D2D1_RENDER_TARGET_TYPE_DEFAULT, D2D1_RENDER_TARGET_USAGE_GDI_COMPATIBLE, D2D1_ROUNDED_RECT,
    D2D1CreateFactory, ID2D1BitmapBrush, ID2D1DCRenderTarget, ID2D1Factory, ID2D1SolidColorBrush,
    ID2D1StrokeStyle,
};
use ::windows::Win32::Graphics::DirectWrite::{
    DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL,
    DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_MEASURING_MODE_NATURAL, DWRITE_PARAGRAPH_ALIGNMENT_CENTER,
    DWRITE_TEXT_ALIGNMENT_CENTER, DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection,
    IDWriteTextFormat,
};
use ::windows::Win32::Graphics::Dwm::{
    DWMWA_TRANSITIONS_FORCEDISABLED, DwmFlush, DwmSetWindowAttribute,
};
use ::windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use ::windows::Win32::Graphics::Gdi::{
    AC_SRC_ALPHA, AC_SRC_OVER, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION,
    CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetMonitorInfoW,
    HBITMAP, HDC, HGDIOBJ, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromPoint, SelectObject,
};
use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    SetFocus, TME_LEAVE, TRACKMOUSEEVENT, TrackMouseEvent, VK_ESCAPE, VK_RETURN,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, HTCLIENT,
    IDC_ARROW, IDC_HAND, LoadCursorW, MA_NOACTIVATE, MSG, PostMessageW, PostQuitMessage,
    RegisterClassExW, SW_SHOWNOACTIVATE, SetCursor, SetForegroundWindow, ShowWindow,
    TranslateMessage, ULW_ALPHA, UpdateLayeredWindow, WM_APP, WM_DESTROY, WM_DPICHANGED,
    WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEMOVE, WM_SETCURSOR,
    WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};
use ::windows::core::{BOOL, Interface, PCWSTR, w};
use image::{RgbaImage, imageops};
use windows_numerics::{Matrix3x2, Vector2};

use super::super::geometry::{
    DesktopRect, PreviewButton, PreviewLayout, preview_button_at, preview_image_size,
    preview_layout,
};
use super::super::{
    MonitorInfo, PlatformError, PreviewAction, PreviewCloser, PreviewHandle, Result,
};
use super::dpi::DpiGuard;
use crate::i18n::{Lang, preview_text};

const CLASS_NAME: PCWSTR = w!("CropaPreview");
/// Asks the preview thread to destroy its window.
const WM_CLOSE_PREVIEW: u32 = WM_APP + 1;
/// `WM_MOUSELEAVE`, which lives in a Windows feature this build does not enable.
const WM_MOUSELEAVE: u32 = 0x02A3;
/// Rings of the shadow, drawn from the outermost inwards.
const SHADOW_RINGS: u32 = 12;

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

/// Premultiplied BGRA bytes of `image`, the format layered windows and
/// Direct2D expect.
fn premultiplied_bgra(image: &RgbaImage) -> Vec<u8> {
    let mut pixels = Vec::with_capacity(image.as_raw().len());
    for pixel in image.pixels() {
        let [r, g, b, a] = pixel.0;
        let scale = |channel: u8| ((u16::from(channel) * u16::from(a) + 127) / 255) as u8;
        pixels.extend_from_slice(&[scale(b), scale(g), scale(r), a]);
    }
    pixels
}

/// What the pointer is doing over the preview.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct Hover {
    /// The pointer is inside the window: the buttons are shown.
    over: bool,
    button: Option<PreviewButton>,
}

/// A memory DC holding a 32-bit top-down DIB the preview is drawn into.
struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}

impl Surface {
    fn new(width: u32, height: u32) -> Result<Self> {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        // SAFETY: a null source DC makes a DC compatible with the screen.
        let dc = unsafe { CreateCompatibleDC(None) };
        if dc.is_invalid() {
            return Err(os_error(::windows::core::Error::from_thread()));
        }
        let mut bits = std::ptr::null_mut();
        // SAFETY: `info` describes a 32-bit DIB; `bits` is a valid out pointer.
        let bitmap = match unsafe {
            CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
        } {
            Ok(bitmap) => bitmap,
            Err(err) => {
                // SAFETY: `dc` was created above and is not used again.
                unsafe {
                    let _ = DeleteDC(dc);
                }
                return Err(os_error(err));
            }
        };
        // SAFETY: both handles are live and the bitmap is not selected elsewhere.
        let previous = unsafe { SelectObject(dc, HGDIOBJ(bitmap.0)) };
        Ok(Self {
            dc,
            bitmap,
            previous,
        })
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        // SAFETY: the bitmap is selected into the DC; put the old object back
        // before deleting the bitmap and the DC, each created by `new`.
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            let _ = DeleteDC(self.dc);
        }
    }
}

/// The window and everything it draws with. It lives in a thread-local because
/// the window procedure has no other way to reach it.
struct Preview {
    hwnd: HWND,
    layout: PreviewLayout,
    scale: f32,
    // Dropped before the surface: the render target draws into its DC.
    target: ID2D1DCRenderTarget,
    solid: ID2D1SolidColorBrush,
    picture: ID2D1BitmapBrush,
    /// The card's rounded outline, clipping the picture.
    clip: ID2D1RoundedRectangleGeometry,
    layer: ID2D1Layer,
    format: IDWriteTextFormat,
    label: Vec<u16>,
    surface: Surface,
    hover: Hover,
    tracking: bool,
    actions: Sender<PreviewAction>,
}

thread_local! {
    static PREVIEW: RefCell<Option<Preview>> = const { RefCell::new(None) };
    /// The shared HWND slot, so `WM_DESTROY` can clear it without touching `PREVIEW`.
    static SLOT: RefCell<Option<Arc<Mutex<Option<isize>>>>> = const { RefCell::new(None) };
}

/// Run `f` on the preview. `None` when there is none yet or it is already
/// borrowed further up the stack; callers then fall back to default handling.
fn with<R>(f: impl FnOnce(&mut Preview) -> Option<R>) -> Option<R> {
    PREVIEW.with(|cell| {
        let mut guard = cell.try_borrow_mut().ok()?;
        f(guard.as_mut()?)
    })
}

impl Preview {
    fn fill_rounded(&self, bounds: D2D_RECT_F, radius: f32, brush: &ID2D1SolidColorBrush) {
        let rounded = D2D1_ROUNDED_RECT {
            rect: bounds,
            radiusX: radius,
            radiusY: radius,
        };
        // SAFETY: drawing between BeginDraw and EndDraw with live resources.
        unsafe { self.target.FillRoundedRectangle(&rounded, brush) };
    }

    fn tint(&self, c: D2D1_COLOR_F) -> &ID2D1SolidColorBrush {
        // SAFETY: `c` outlives the call.
        unsafe { self.solid.SetColor(&c) };
        &self.solid
    }

    fn draw(&self) -> ::windows::core::Result<()> {
        let layout = &self.layout;
        let s = self.scale;
        let window = &layout.window;
        let bounds = RECT {
            left: 0,
            top: 0,
            right: window.width as i32,
            bottom: window.height as i32,
        };
        // SAFETY: the DC belongs to `surface`, which outlives the target's use of it.
        unsafe { self.target.BindDC(self.surface.dc, &bounds) }?;
        // SAFETY: the target is bound; every draw call below sits inside this pair.
        unsafe {
            self.target.BeginDraw();
            self.target.Clear(Some(&color(0.0, 0.0, 0.0, 0.0)));
        }

        let card = layout.card;
        let card_rect = rect(
            card.x as f32,
            card.y as f32,
            (card.x + card.width) as f32,
            (card.y + card.height) as f32,
        );
        let radius = layout.radius;

        // A soft shadow: rings of faint black, largest first, dropped a little.
        let step = (card.x as f32 / SHADOW_RINGS as f32).max(0.5);
        for ring in (1..=SHADOW_RINGS).rev() {
            let grow = ring as f32 * step;
            let ring_rect = rect(
                card_rect.left - grow,
                card_rect.top - grow + 2.0 * s,
                card_rect.right + grow,
                card_rect.bottom + grow + 2.0 * s,
            );
            self.fill_rounded(
                ring_rect,
                radius + grow,
                self.tint(color(0.0, 0.0, 0.0, 0.035)),
            );
        }

        self.fill_rounded(card_rect, radius, self.tint(color(0.11, 0.11, 0.12, 1.0)));

        let image = layout.image;
        let image_rect = rect(
            image.x as f32,
            image.y as f32,
            (image.x + image.width) as f32,
            (image.y + image.height) as f32,
        );
        // The picture brush paints in window coordinates; move it to the image.
        let at = Matrix3x2::translation(image.x as f32, image.y as f32);
        // The picture is clipped to the card's rounded outline, so a picture
        // that nearly fills the card cannot poke out of its corners.
        let mask = D2D1_LAYER_PARAMETERS {
            contentBounds: rect(f32::MIN, f32::MIN, f32::MAX, f32::MAX),
            geometricMask: ManuallyDrop::new(self.clip.cast::<ID2D1Geometry>().ok()),
            maskAntialiasMode: D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
            maskTransform: Matrix3x2::identity(),
            opacity: 1.0,
            opacityBrush: ManuallyDrop::new(None),
            layerOptions: D2D1_LAYER_OPTIONS_NONE,
        };
        // SAFETY: drawing with live resources inside BeginDraw/EndDraw; the layer
        // is popped before the next draw call.
        unsafe {
            self.picture.SetTransform(&at);
            self.target.PushLayer(&mask, &self.layer);
            self.target.FillRectangle(&image_rect, &self.picture);
            self.target.PopLayer();
        }
        // The mask holds its own reference to the geometry; release it.
        drop(ManuallyDrop::into_inner(mask.geometricMask));

        // A hairline border, inset by half its width so it stays on the card.
        let border = D2D1_ROUNDED_RECT {
            rect: rect(
                card_rect.left + 0.5,
                card_rect.top + 0.5,
                card_rect.right - 0.5,
                card_rect.bottom - 0.5,
            ),
            radiusX: radius - 0.5,
            radiusY: radius - 0.5,
        };
        let border_brush = self.tint(color(1.0, 1.0, 1.0, 0.12));
        // SAFETY: drawing with live resources inside BeginDraw/EndDraw.
        unsafe {
            self.target
                .DrawRoundedRectangle(&border, border_brush, 1.0, None::<&ID2D1StrokeStyle>);
        }

        if self.hover.over {
            self.draw_edit_button();
            self.draw_close_button();
        }

        // SAFETY: pairs with the BeginDraw above.
        unsafe { self.target.EndDraw(None, None) }
    }

    fn button_background(hot: bool) -> D2D1_COLOR_F {
        if hot {
            color(0.27, 0.27, 0.29, 0.9)
        } else {
            color(0.08, 0.08, 0.09, 0.65)
        }
    }

    fn draw_edit_button(&self) {
        let edit = self.layout.edit;
        let bounds = rect(
            edit.x as f32,
            edit.y as f32,
            (edit.x + edit.width) as f32,
            (edit.y + edit.height) as f32,
        );
        let hot = self.hover.button == Some(PreviewButton::Edit);
        self.fill_rounded(
            bounds,
            edit.height as f32 / 2.0,
            self.tint(Self::button_background(hot)),
        );
        let text = self.tint(color(1.0, 1.0, 1.0, 1.0));
        // SAFETY: the label and format outlive the call; drawing inside BeginDraw/EndDraw.
        unsafe {
            self.target.DrawText(
                &self.label,
                &self.format,
                &bounds,
                text,
                D2D1_DRAW_TEXT_OPTIONS_NONE,
                DWRITE_MEASURING_MODE_NATURAL,
            );
        }
    }

    fn draw_close_button(&self) {
        let close = self.layout.close;
        let bounds = rect(
            close.x as f32,
            close.y as f32,
            (close.x + close.width) as f32,
            (close.y + close.height) as f32,
        );
        let hot = self.hover.button == Some(PreviewButton::Close);
        self.fill_rounded(
            bounds,
            close.height as f32 / 2.0,
            self.tint(Self::button_background(hot)),
        );
        let centre = (
            f32::midpoint(bounds.left, bounds.right),
            f32::midpoint(bounds.top, bounds.bottom),
        );
        let arm = close.width as f32 * 0.17;
        let stroke = (self.scale * 1.5).max(1.0);
        let line = self.tint(color(1.0, 1.0, 1.0, 1.0));
        let point = |x: f32, y: f32| Vector2 { X: x, Y: y };
        // SAFETY: drawing with live resources inside BeginDraw/EndDraw.
        unsafe {
            self.target.DrawLine(
                point(centre.0 - arm, centre.1 - arm),
                point(centre.0 + arm, centre.1 + arm),
                line,
                stroke,
                None::<&ID2D1StrokeStyle>,
            );
            self.target.DrawLine(
                point(centre.0 + arm, centre.1 - arm),
                point(centre.0 - arm, centre.1 + arm),
                line,
                stroke,
                None::<&ID2D1StrokeStyle>,
            );
        }
    }

    /// Draw and hand the result to the window manager.
    fn present(&self) -> ::windows::core::Result<()> {
        self.draw()?;
        let window = self.layout.window;
        let position = POINT {
            x: window.x,
            y: window.y,
        };
        let size = SIZE {
            cx: window.width as i32,
            cy: window.height as i32,
        };
        let source = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        // SAFETY: the window is ours; the DC holds the finished picture and every
        // pointer refers to a local that outlives the call.
        unsafe {
            UpdateLayeredWindow(
                self.hwnd,
                None,
                Some(&position),
                Some(&size),
                Some(self.surface.dc),
                Some(&source),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            )
        }
    }
}

fn redraw() {
    let result = with(|preview| Some(preview.present()));
    if let Some(Err(err)) = result {
        log::warn!("could not redraw the preview: {err}");
    }
}

/// Point of a mouse message in client coordinates (signed 16-bit words).
fn client_point(lparam: LPARAM) -> (i32, i32) {
    let [x_low, x_high, y_low, y_high, ..] = lparam.0.to_le_bytes();
    (
        i32::from(i16::from_le_bytes([x_low, x_high])),
        i32::from(i16::from_le_bytes([y_low, y_high])),
    )
}

fn on_mouse_move(hwnd: HWND, lparam: LPARAM) {
    let (x, y) = client_point(lparam);
    let start_tracking = with(|preview| {
        let hover = Hover {
            over: true,
            button: preview_button_at(&preview.layout, x, y),
        };
        let changed = hover != preview.hover;
        preview.hover = hover;
        let start = !preview.tracking;
        preview.tracking = true;
        Some((changed, start))
    });
    let Some((changed, start)) = start_tracking else {
        return;
    };
    if start {
        let mut track = TRACKMOUSEEVENT {
            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
            dwFlags: TME_LEAVE,
            hwndTrack: hwnd,
            dwHoverTime: 0,
        };
        // SAFETY: `track` is fully initialised and names our own window.
        if let Err(err) = unsafe { TrackMouseEvent(&mut track) } {
            log::warn!("could not track the pointer over the preview: {err}");
        }
    }
    if changed {
        redraw();
    }
}

fn on_mouse_leave() {
    let changed = with(|preview| {
        preview.tracking = false;
        let changed = preview.hover != Hover::default();
        preview.hover = Hover::default();
        Some(changed)
    });
    if changed == Some(true) {
        redraw();
    }
}

fn on_button_up(hwnd: HWND, lparam: LPARAM) {
    let (x, y) = client_point(lparam);
    let button = with(|preview| preview_button_at(&preview.layout, x, y));
    match button {
        Some(PreviewButton::Edit) => finish(hwnd, PreviewAction::Edit),
        Some(PreviewButton::Close) => finish(hwnd, PreviewAction::Dismiss),
        None => {}
    }
}

fn on_button_down(hwnd: HWND, lparam: LPARAM) {
    let (x, y) = client_point(lparam);
    let on_button = with(|preview| preview_button_at(&preview.layout, x, y)).is_some();
    if on_button {
        return;
    }
    // A click on the card itself is the user asking for the keyboard, so
    // Enter and Esc work from here on.
    // SAFETY: our own live window, on its own thread.
    unsafe {
        let _ = SetForegroundWindow(hwnd);
        let _ = SetFocus(Some(hwnd));
    }
}

/// Report the user's choice, then close the window. The borrow of the preview
/// is released before the window is destroyed.
fn finish(hwnd: HWND, action: PreviewAction) {
    with(|preview| {
        // The receiver is gone when the caller no longer waits; nothing to do then.
        let _ = preview.actions.send(action);
        Some(())
    });
    // SAFETY: our own live window, destroyed on its own thread.
    unsafe {
        let _ = DestroyWindow(hwnd);
    }
}

fn clear_shared_hwnd() {
    SLOT.with(|cell| {
        if let Some(slot) = cell.borrow().as_ref() {
            *slot.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
    });
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        WM_MOUSEMOVE => {
            on_mouse_move(hwnd, lparam);
            LRESULT(0)
        }
        WM_MOUSELEAVE => {
            on_mouse_leave();
            LRESULT(0)
        }
        WM_SETCURSOR if (lparam.0 & 0xFFFF) as u32 == HTCLIENT => {
            let on_button = with(|preview| preview.hover.button).is_some();
            let name = if on_button { IDC_HAND } else { IDC_ARROW };
            // SAFETY: loads and sets a stock cursor.
            unsafe {
                if let Ok(cursor) = LoadCursorW(None, name) {
                    SetCursor(Some(cursor));
                }
            }
            LRESULT(1)
        }
        WM_LBUTTONDOWN => {
            on_button_down(hwnd, lparam);
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            on_button_up(hwnd, lparam);
            LRESULT(0)
        }
        WM_KEYDOWN if wparam.0 == usize::from(VK_RETURN.0) => {
            finish(hwnd, PreviewAction::Edit);
            LRESULT(0)
        }
        WM_KEYDOWN if wparam.0 == usize::from(VK_ESCAPE.0) => {
            finish(hwnd, PreviewAction::Dismiss);
            LRESULT(0)
        }
        // Keep the size and place that were worked out for the monitor.
        WM_DPICHANGED => LRESULT(0),
        WM_CLOSE_PREVIEW => {
            // SAFETY: our own live window, destroyed on its own thread.
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            clear_shared_hwnd();
            // SAFETY: posts WM_QUIT to this thread's queue.
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        // SAFETY: forwards an unhandled message with the arguments we received.
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

fn register_class() -> Result<()> {
    // SAFETY: a null module name returns this executable's handle.
    let instance = unsafe { GetModuleHandleW(None) }.map_err(os_error)?;
    let class = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(wnd_proc),
        hInstance: instance.into(),
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

/// The work area (the monitor without the taskbar) of the monitor holding the
/// centre of `on`, or the monitor's own rectangle when Windows does not say.
fn work_area(on: &MonitorInfo) -> DesktopRect {
    let own = DesktopRect {
        x: on.x,
        y: on.y,
        width: on.width,
        height: on.height,
    };
    let centre = POINT {
        x: on.x.saturating_add((on.width / 2) as i32),
        y: on.y.saturating_add((on.height / 2) as i32),
    };
    // SAFETY: any point is valid; the nearest monitor is returned.
    let monitor = unsafe { MonitorFromPoint(centre, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is initialised with its size and is a valid out pointer.
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return own;
    }
    let work = info.rcWork;
    DesktopRect {
        x: work.left,
        y: work.top,
        width: (work.right - work.left).max(0) as u32,
        height: (work.bottom - work.top).max(0) as u32,
    }
}

/// Everything the preview thread needs, built on the caller's thread.
struct Request {
    /// Premultiplied BGRA pixels of the thumbnail.
    pixels: Vec<u8>,
    size: (u32, u32),
    original: (u32, u32),
    monitor: MonitorInfo,
    actions: Sender<PreviewAction>,
    shared_hwnd: Arc<Mutex<Option<isize>>>,
}

pub fn show_preview(image: &RgbaImage, on: &MonitorInfo) -> Result<PreviewHandle> {
    let original = (image.width(), image.height());
    let size = preview_image_size(original, on.scale_factor);
    let thumbnail = imageops::thumbnail(image, size.0, size.1);

    let (actions, receiver) = mpsc::channel();
    let shared_hwnd = Arc::new(Mutex::new(None));
    let request = Request {
        pixels: premultiplied_bgra(&thumbnail),
        size,
        original,
        monitor: on.clone(),
        actions,
        shared_hwnd: Arc::clone(&shared_hwnd),
    };
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("cropa-preview".into())
        .spawn(move || run(request, &ready_tx))
        .map_err(os_error)?;

    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            let _ = thread.join();
            return Err(err);
        }
        Err(_) => {
            let _ = thread.join();
            return Err(os_error("the preview thread stopped before it showed"));
        }
    }

    let closer = PreviewCloser::new(move || {
        let mut asked = false;
        {
            let slot = shared_hwnd.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(raw) = *slot {
                // SAFETY: the slot holds the HWND only between creation and
                // WM_DESTROY, and the lock is held, so the window still exists.
                // Posting only queues a message.
                let posted = unsafe {
                    PostMessageW(
                        Some(HWND(raw as *mut _)),
                        WM_CLOSE_PREVIEW,
                        WPARAM(0),
                        LPARAM(0),
                    )
                };
                match posted {
                    Ok(()) => asked = true,
                    Err(err) => log::warn!("could not ask the preview to close: {err}"),
                }
            }
        }
        if thread.join().is_err() {
            log::warn!("the preview thread panicked");
        }
        if asked {
            // SAFETY: waits for the next composition; it takes no pointers. The
            // closed window is off the screen when this returns, so a capture
            // that follows cannot catch it.
            if let Err(err) = unsafe { DwmFlush() } {
                log::warn!("could not wait for the screen to recompose: {err}");
            }
        }
    });
    Ok(PreviewHandle {
        actions: receiver,
        closer,
    })
}

/// The preview thread: build the window, report that it is up, pump messages
/// until it is destroyed.
fn run(request: Request, ready: &Sender<Result<()>>) {
    // Held for the whole thread so the window is sized in physical pixels.
    let _dpi = DpiGuard::per_monitor();
    let shared_hwnd = Arc::clone(&request.shared_hwnd);
    match build(request) {
        Ok(()) => {
            let _ = ready.send(Ok(()));
        }
        Err(err) => {
            teardown(&shared_hwnd);
            let _ = ready.send(Err(err));
            return;
        }
    }
    let mut message = MSG::default();
    loop {
        // SAFETY: `message` is a valid out pointer; this thread owns the window.
        let status = unsafe { GetMessageW(&mut message, None, 0, 0) };
        match status.0 {
            0 => break,
            -1 => {
                log::warn!(
                    "the preview message loop failed: {}",
                    ::windows::core::Error::from_thread()
                );
                break;
            }
            _ => {
                // SAFETY: `message` was filled by GetMessageW.
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        }
    }
    teardown(&shared_hwnd);
}

/// Drop the window state and its Direct2D objects on the thread that made them.
fn teardown(shared_hwnd: &Mutex<Option<isize>>) {
    // A window still in the slot was never destroyed (an error after it was
    // created). The lock is released before the call: `WM_DESTROY` takes it.
    let leftover = shared_hwnd
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    if let Some(raw) = leftover {
        // SAFETY: the slot holds the HWND only until `WM_DESTROY`, so the window
        // exists, and this is the thread that created it.
        unsafe {
            let _ = DestroyWindow(HWND(raw as *mut _));
        }
    }
    PREVIEW.with(|cell| {
        if let Ok(mut guard) = cell.try_borrow_mut() {
            guard.take();
        }
    });
    SLOT.with(|cell| cell.borrow_mut().take());
}

#[allow(clippy::too_many_lines)]
fn build(request: Request) -> Result<()> {
    let Request {
        pixels,
        size,
        original,
        monitor,
        actions,
        shared_hwnd,
    } = request;
    let layout = preview_layout(work_area(&monitor), monitor.scale_factor, original);
    let window = layout.window;

    // SAFETY: creates single-threaded factories used only on this thread.
    let d2d: ID2D1Factory =
        unsafe { D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None) }.map_err(os_error)?;
    // SAFETY: as above.
    let dwrite: IDWriteFactory =
        unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) }.map_err(os_error)?;
    register_class()?;

    let text = preview_text(Lang::detect());
    let title: Vec<u16> = text.title.encode_utf16().chain(Some(0)).collect();
    // SAFETY: the class is registered, the window is a plain popup with no
    // parent, and `title` is null-terminated and outlives the call.
    let hwnd = unsafe {
        let instance = GetModuleHandleW(None).map_err(os_error)?;
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            CLASS_NAME,
            PCWSTR(title.as_ptr()),
            WS_POPUP,
            window.x,
            window.y,
            window.width as i32,
            window.height as i32,
            None,
            None,
            Some(instance.into()),
            None,
        )
    }
    .map_err(os_error)?;
    SLOT.with(|cell| *cell.borrow_mut() = Some(Arc::clone(&shared_hwnd)));
    *shared_hwnd.lock().unwrap_or_else(PoisonError::into_inner) = Some(hwnd.0 as isize);

    // The window appears and vanishes without the fade Windows adds.
    let disabled = BOOL(1);
    // SAFETY: `disabled` is a BOOL, the size matches, and `hwnd` is our window.
    if let Err(err) = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            std::ptr::from_ref(&disabled).cast(),
            std::mem::size_of::<BOOL>() as u32,
        )
    } {
        log::warn!("could not turn off the preview's transition: {err}");
    }

    let surface = Surface::new(window.width, window.height)?;
    let target_properties = D2D1_RENDER_TARGET_PROPERTIES {
        r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
        },
        // 96 dpi makes one drawing unit one physical pixel.
        dpiX: 96.0,
        dpiY: 96.0,
        usage: D2D1_RENDER_TARGET_USAGE_GDI_COMPATIBLE,
        minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
    };
    // SAFETY: the properties struct is fully initialised and outlives the call.
    let target = unsafe { d2d.CreateDCRenderTarget(&target_properties) }.map_err(os_error)?;

    let bitmap_properties = D2D1_BITMAP_PROPERTIES {
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
        },
        dpiX: 96.0,
        dpiY: 96.0,
    };
    // SAFETY: `pixels` holds width * height * 4 bytes, matching the size and pitch given.
    let bitmap = unsafe {
        target.CreateBitmap(
            D2D_SIZE_U {
                width: size.0,
                height: size.1,
            },
            Some(pixels.as_ptr().cast()),
            size.0 * 4,
            &bitmap_properties,
        )
    }
    .map_err(os_error)?;
    let brush_properties = D2D1_BITMAP_BRUSH_PROPERTIES {
        extendModeX: D2D1_EXTEND_MODE_CLAMP,
        extendModeY: D2D1_EXTEND_MODE_CLAMP,
        interpolationMode: D2D1_BITMAP_INTERPOLATION_MODE_LINEAR,
    };
    let common = D2D1_BRUSH_PROPERTIES {
        opacity: 1.0,
        transform: Matrix3x2::identity(),
    };
    // SAFETY: both property structs are fully initialised and outlive the call.
    let picture =
        unsafe { target.CreateBitmapBrush(&bitmap, Some(&brush_properties), Some(&common)) }
            .map_err(os_error)?;
    // SAFETY: no brush properties; the colour is copied.
    let solid = unsafe { target.CreateSolidColorBrush(&color(0.0, 0.0, 0.0, 1.0), None) }
        .map_err(os_error)?;

    // SAFETY: the family and locale are static literals; no custom font collection.
    let format = unsafe {
        dwrite.CreateTextFormat(
            w!("Segoe UI"),
            None::<&IDWriteFontCollection>,
            DWRITE_FONT_WEIGHT_SEMI_BOLD,
            DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL,
            12.0 * monitor.scale_factor,
            w!("en-us"),
        )
    }
    .map_err(os_error)?;
    // SAFETY: plain property setters on a live text format.
    unsafe {
        format
            .SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER)
            .map_err(os_error)?;
        format
            .SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER)
            .map_err(os_error)?;
    }

    let card = layout.card;
    let card_outline = D2D1_ROUNDED_RECT {
        rect: rect(
            card.x as f32,
            card.y as f32,
            (card.x + card.width) as f32,
            (card.y + card.height) as f32,
        ),
        radiusX: layout.radius,
        radiusY: layout.radius,
    };
    // SAFETY: the outline struct is fully initialised and outlives the call.
    let clip = unsafe { d2d.CreateRoundedRectangleGeometry(&card_outline) }.map_err(os_error)?;
    // SAFETY: a layer without a size is sized by Direct2D when it is pushed.
    let layer = unsafe { target.CreateLayer(None) }.map_err(os_error)?;

    let preview = Preview {
        hwnd,
        layout,
        scale: monitor.scale_factor,
        target,
        solid,
        picture,
        clip,
        layer,
        format,
        label: text.edit.encode_utf16().collect(),
        surface,
        hover: Hover::default(),
        tracking: false,
        actions,
    };
    preview.present().map_err(os_error)?;
    PREVIEW.with(|cell| *cell.borrow_mut() = Some(preview));

    // SAFETY: our own live window; shown without activating it.
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use image::Rgba;

    use super::*;

    #[test]
    fn pixels_are_premultiplied_and_reordered_to_bgra() {
        let mut image = RgbaImage::new(2, 1);
        image.put_pixel(0, 0, Rgba([10, 20, 30, 255]));
        image.put_pixel(1, 0, Rgba([200, 100, 50, 128]));

        let pixels = premultiplied_bgra(&image);

        assert_eq!(&pixels[..4], &[30, 20, 10, 255]);
        assert_eq!(&pixels[4..], &[25, 50, 100, 128]);
    }
}
