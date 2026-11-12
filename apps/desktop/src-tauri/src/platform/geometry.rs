//! Coordinate maths for region selection: pure functions on physical pixels,
//! no OS types, so the multi-monitor and negative-origin cases are testable on
//! any machine.

use super::{MonitorInfo, PixelRect};

/// A point in physical pixels on the virtual desktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

fn contains(monitor: &MonitorInfo, p: Point) -> bool {
    let (x, y) = (i64::from(p.x), i64::from(p.y));
    let (left, top) = (i64::from(monitor.x), i64::from(monitor.y));
    x >= left
        && y >= top
        && x < left + i64::from(monitor.width)
        && y < top + i64::from(monitor.height)
}

/// Index of the monitor containing `p`. Edges are half-open: a monitor at x=0
/// owns x=0, its left neighbour ending at 0 does not.
pub fn monitor_at<'a>(
    monitors: impl IntoIterator<Item = &'a MonitorInfo>,
    p: Point,
) -> Option<usize> {
    monitors.into_iter().position(|m| contains(m, p))
}

fn clamp_axis(value: i32, origin: i32, size: u32) -> u32 {
    let last = size.saturating_sub(1);
    let local = i64::from(value) - i64::from(origin);
    // The clamp keeps the value within 0..=last, so the conversion cannot fail.
    u32::try_from(local.clamp(0, i64::from(last))).unwrap_or(last)
}

/// Clamp a desktop point into `monitor` and return the pixel under it in
/// monitor-local coordinates (0..=width-1, 0..=height-1): the pointer can never
/// be past the last pixel.
pub fn to_local(monitor: &MonitorInfo, p: Point) -> (u32, u32) {
    (
        clamp_axis(p.x, monitor.x, monitor.width),
        clamp_axis(p.y, monitor.y, monitor.height),
    )
}

/// The desktop point of a mouse message sent to a window whose client area
/// starts at the monitor's corner. `lparam` holds the client x in its low word
/// and y in its high word, both signed (a captured mouse can be left of or
/// above the window).
pub fn client_point_to_desktop(monitor: &MonitorInfo, lparam: isize) -> Point {
    let [x_low, x_high, y_low, y_high, ..] = lparam.to_le_bytes();
    let x = i32::from(i16::from_le_bytes([x_low, x_high]));
    let y = i32::from(i16::from_le_bytes([y_low, y_high]));
    Point {
        x: monitor.x + x,
        y: monitor.y + y,
    }
}

/// `edge * capture / monitor`, rounded to nearest.
pub(crate) fn map_edge(edge: u32, capture: u32, monitor: u32) -> u32 {
    if monitor == 0 {
        return 0;
    }
    let monitor = u64::from(monitor);
    let mapped = (u64::from(edge) * u64::from(capture) + monitor / 2) / monitor;
    // edge <= monitor, so mapped <= capture and the conversion cannot fail.
    u32::try_from(mapped).unwrap_or(capture)
}

/// The rectangle dragged from `start` to `end` (desktop pixels, either order),
/// clamped to `monitor` and mapped into a capture of `capture_width` x
/// `capture_height`. It includes the pixel under both points, so a drag to the
/// last pixel reaches the monitor's far edge. `None` when either axis did not
/// move: a click, or a drag along a line.
///
/// The overlay shows the capture stretched to the monitor, so mapping each edge
/// by the size ratio crops what the user sees. Normally the sizes are equal and
/// the mapping is the identity. The scale factor plays no part: the monitor
/// geometry and the capture are both physical.
pub fn crop_rect(
    monitor: &MonitorInfo,
    capture_width: u32,
    capture_height: u32,
    start: Point,
    end: Point,
) -> Option<PixelRect> {
    let (sx, sy) = to_local(monitor, start);
    let (ex, ey) = to_local(monitor, end);
    if sx == ex || sy == ey {
        return None;
    }
    // The far edge is one past the last pixel (half-open).
    let (left, right) = (sx.min(ex), sx.max(ex) + 1);
    let (top, bottom) = (sy.min(ey), sy.max(ey) + 1);

    let left = map_edge(left, capture_width, monitor.width);
    let right = map_edge(right, capture_width, monitor.width).min(capture_width);
    let top = map_edge(top, capture_height, monitor.height);
    let bottom = map_edge(bottom, capture_height, monitor.height).min(capture_height);

    let width = right.saturating_sub(left);
    let height = bottom.saturating_sub(top);
    if width == 0 || height == 0 {
        return None;
    }
    Some(PixelRect {
        x: left,
        y: top,
        width,
        height,
    })
}

/// A rectangle on the virtual desktop, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// A rectangle inside a window, in physical pixels from its top-left corner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl LocalRect {
    pub fn contains(&self, x: i32, y: i32) -> bool {
        let (x, y) = (i64::from(x), i64::from(y));
        x >= i64::from(self.x)
            && y >= i64::from(self.y)
            && x < i64::from(self.x) + i64::from(self.width)
            && y < i64::from(self.y) + i64::from(self.height)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewButton {
    Edit,
    Close,
}

/// Where everything of a floating preview sits. The window is the card plus a
/// margin on every side for its shadow.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PreviewLayout {
    pub window: DesktopRect,
    pub card: LocalRect,
    pub image: LocalRect,
    pub edit: LocalRect,
    pub close: LocalRect,
    pub radius: f32,
}

// Sizes below are in logical pixels and become physical ones through the scale.
const IMAGE_MAX: (f32, f32) = (240.0, 160.0);
const CARD_MIN: (f32, f32) = (136.0, 72.0);
const SHADOW_MARGIN: f32 = 12.0;
const SCREEN_GAP: f32 = 16.0;
const BUTTON_INSET: f32 = 6.0;
const EDIT_SIZE: (f32, f32) = (56.0, 24.0);
const CLOSE_SIZE: f32 = 24.0;
const CARD_RADIUS: f32 = 8.0;

/// A length scaled to physical pixels and rounded.
fn px(length: f32, scale: f32) -> u32 {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let rounded = (length * scale).round().max(0.0) as u32;
    rounded
}

/// The size of the thumbnail shown in the preview: at most 240 × 160 logical
/// pixels, aspect kept, never larger than the capture itself.
pub fn preview_image_size(image: (u32, u32), scale: f32) -> (u32, u32) {
    let (width, height) = (image.0.max(1), image.1.max(1));
    #[allow(clippy::cast_precision_loss)]
    let (w, h) = (width as f32, height as f32);
    let factor = (IMAGE_MAX.0 * scale / w)
        .min(IMAGE_MAX.1 * scale / h)
        .min(1.0);
    (px(w, factor).max(1), px(h, factor).max(1))
}

/// Place a preview in the bottom-right corner of `work_area`, 16 logical pixels
/// from its edges. A work area too small for the window puts the window's
/// top-left corner at the work area's.
pub fn preview_layout(work_area: DesktopRect, scale: f32, image: (u32, u32)) -> PreviewLayout {
    let (image_w, image_h) = preview_image_size(image, scale);
    let card_w = image_w.max(px(CARD_MIN.0, scale));
    let card_h = image_h.max(px(CARD_MIN.1, scale));
    let margin = px(SHADOW_MARGIN, scale);
    let gap = px(SCREEN_GAP, scale);

    // The window's start on one axis: the card ends `gap` before the work
    // area's far edge, and the window never starts before the work area.
    let place = |origin: i32, extent: u32, card: u32| {
        let far_edge = i64::from(origin) + i64::from(extent);
        let start = far_edge - i64::from(gap) - i64::from(card) - i64::from(margin);
        i32::try_from(start.max(i64::from(origin))).unwrap_or(origin)
    };
    let window = DesktopRect {
        x: place(work_area.x, work_area.width, card_w),
        y: place(work_area.y, work_area.height, card_h),
        width: card_w + 2 * margin,
        height: card_h + 2 * margin,
    };

    let inset = px(BUTTON_INSET, scale);
    let close_size = px(CLOSE_SIZE, scale);
    PreviewLayout {
        window,
        card: LocalRect {
            x: margin,
            y: margin,
            width: card_w,
            height: card_h,
        },
        image: LocalRect {
            x: margin + (card_w - image_w) / 2,
            y: margin + (card_h - image_h) / 2,
            width: image_w,
            height: image_h,
        },
        edit: LocalRect {
            x: margin + inset,
            y: margin + inset,
            width: px(EDIT_SIZE.0, scale),
            height: px(EDIT_SIZE.1, scale),
        },
        close: LocalRect {
            x: (margin + card_w).saturating_sub(inset + close_size),
            y: margin + inset,
            width: close_size,
            height: close_size,
        },
        radius: CARD_RADIUS * scale,
    }
}

/// The button under a point given in window coordinates.
pub fn preview_button_at(layout: &PreviewLayout, x: i32, y: i32) -> Option<PreviewButton> {
    if layout.edit.contains(x, y) {
        Some(PreviewButton::Edit)
    } else if layout.close.contains(x, y) {
        Some(PreviewButton::Close)
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarButton {
    Region,
    Window,
    FullScreen,
    Cancel,
}

/// Where the capture mode bar and its four buttons sit, in monitor-local pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModeBarLayout {
    pub bar: LocalRect,
    pub buttons: [(BarButton, LocalRect); 4],
    pub radius: f32,
    pub button_radius: f32,
}

const BAR_TOP_MARGIN: f32 = 16.0;
const BAR_PADDING: f32 = 4.0;
const BAR_BUTTON_HEIGHT: f32 = 32.0;
const BAR_BUTTON_PADDING: f32 = 12.0;
const BAR_GAP: f32 = 4.0;
const BAR_CANCEL_GAP: f32 = 8.0;
const BAR_RADIUS: f32 = 8.0;
const BAR_BUTTON_RADIUS: f32 = 6.0;

/// Centre a bar of four text buttons at the top of a monitor `monitor_width`
/// wide. `label_widths` are the measured text widths in physical pixels, in
/// button order; `label_height` is the text's height.
pub fn mode_bar_layout(
    monitor_width: u32,
    scale: f32,
    label_widths: [f32; 4],
    label_height: f32,
) -> ModeBarLayout {
    let padding = px(BAR_PADDING, scale);
    let gap = px(BAR_GAP, scale);
    let cancel_gap = px(BAR_CANCEL_GAP, scale);
    let button_padding = px(BAR_BUTTON_PADDING, scale);
    let button_height = px(BAR_BUTTON_HEIGHT, scale).max(px(label_height.ceil(), 1.0));
    let widths = label_widths.map(|w| px(w.ceil(), 1.0) + 2 * button_padding);

    let content = widths.iter().sum::<u32>() + 3 * gap + cancel_gap;
    let bar_width = content + 2 * padding;
    let bar = LocalRect {
        x: monitor_width.saturating_sub(bar_width) / 2,
        y: px(BAR_TOP_MARGIN, scale),
        width: bar_width,
        height: button_height + 2 * padding,
    };

    let kinds = [
        BarButton::Region,
        BarButton::Window,
        BarButton::FullScreen,
        BarButton::Cancel,
    ];
    let mut x = bar.x + padding;
    let buttons = std::array::from_fn(|i| {
        if i == 3 {
            x += cancel_gap;
        }
        let rect = LocalRect {
            x,
            y: bar.y + padding,
            width: widths[i],
            height: button_height,
        };
        x += widths[i] + gap;
        (kinds[i], rect)
    });
    ModeBarLayout {
        bar,
        buttons,
        radius: BAR_RADIUS * scale,
        button_radius: BAR_BUTTON_RADIUS * scale,
    }
}

/// The button under a point given in window coordinates.
pub fn bar_button_at(layout: &ModeBarLayout, x: i32, y: i32) -> Option<BarButton> {
    layout
        .buttons
        .iter()
        .find(|(_, rect)| rect.contains(x, y))
        .map(|(button, _)| *button)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(x: i32, y: i32, width: u32, height: u32, scale_factor: f32) -> MonitorInfo {
        MonitorInfo {
            id: 1,
            name: "test".into(),
            x,
            y,
            width,
            height,
            scale_factor,
            is_primary: false,
        }
    }

    fn p(x: i32, y: i32) -> Point {
        Point { x, y }
    }

    fn rect(x: u32, y: u32, width: u32, height: u32) -> PixelRect {
        PixelRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn drag_on_the_primary_at_100_percent() {
        let m = monitor(0, 0, 1920, 1080, 1.0);
        let r = crop_rect(&m, 1920, 1080, p(100, 50), p(699, 449));
        assert_eq!(r, Some(rect(100, 50, 600, 400)));
    }

    #[test]
    fn drag_on_a_125_percent_monitor_right_of_the_primary() {
        // 3000x1688 physical at x=1920; dividing by 1.25 or forgetting the
        // origin would move the result.
        let m = monitor(1920, 0, 3000, 1688, 1.25);
        let r = crop_rect(&m, 3000, 1688, p(1920 + 500, 200), p(1920 + 1099, 799));
        assert_eq!(r, Some(rect(500, 200, 600, 600)));
    }

    #[test]
    fn drag_on_a_150_percent_monitor_left_of_the_primary() {
        let m = monitor(-2880, 0, 2880, 1620, 1.5);
        let r = crop_rect(&m, 2880, 1620, p(-2880 + 300, 120), p(-2880 + 1499, 919));
        assert_eq!(r, Some(rect(300, 120, 1200, 800)));
    }

    #[test]
    fn drag_on_a_175_percent_monitor_above_the_primary() {
        let m = monitor(0, -1890, 3360, 1890, 1.75);
        let r = crop_rect(&m, 3360, 1890, p(350, -1890 + 175), p(2099, -1890 + 1224));
        assert_eq!(r, Some(rect(350, 175, 1750, 1050)));
    }

    #[test]
    fn monitor_left_of_and_above_the_primary() {
        let m = monitor(-2880, -400, 2880, 1620, 1.5);
        let r = crop_rect(&m, 2880, 1620, p(-2000, -100), p(-1501, 299));
        assert_eq!(r, Some(rect(880, 300, 500, 400)));
    }

    #[test]
    fn drag_onto_a_neighbour_is_clamped_to_the_start_monitor() {
        let m = monitor(0, 0, 1920, 1080, 1.0);
        let r = crop_rect(&m, 1920, 1080, p(1800, 500), p(2500, 2000));
        assert_eq!(r, Some(rect(1800, 500, 120, 580)));
    }

    #[test]
    fn drag_into_negative_space_is_clamped_to_the_monitor_origin() {
        let m = monitor(0, 0, 1920, 1080, 1.0);
        let r = crop_rect(&m, 1920, 1080, p(100, 100), p(-50, -50));
        assert_eq!(r, Some(rect(0, 0, 101, 101)));
    }

    #[test]
    fn the_whole_monitor_is_reachable() {
        let m = monitor(0, 0, 1920, 1080, 1.0);
        let r = crop_rect(&m, 1920, 1080, p(0, 0), p(1919, 1079));
        assert_eq!(r, Some(rect(0, 0, 1920, 1080)));
        let beyond = crop_rect(&m, 1920, 1080, p(0, 0), p(5000, 5000));
        assert_eq!(beyond, r);
    }

    #[test]
    fn reversed_drag_matches_the_forward_drag() {
        let m = monitor(-1920, 0, 1920, 1080, 1.0);
        let forward = crop_rect(&m, 1920, 1080, p(-1500, 200), p(-901, 699));
        let backward = crop_rect(&m, 1920, 1080, p(-901, 699), p(-1500, 200));
        assert_eq!(forward, Some(rect(420, 200, 600, 500)));
        assert_eq!(forward, backward);
    }

    #[test]
    fn a_click_or_a_flat_drag_does_not_finish() {
        let m = monitor(0, 0, 1920, 1080, 1.0);
        assert_eq!(crop_rect(&m, 1920, 1080, p(400, 300), p(400, 300)), None);
        assert_eq!(crop_rect(&m, 1920, 1080, p(400, 300), p(900, 300)), None);
        assert_eq!(crop_rect(&m, 1920, 1080, p(400, 300), p(400, 900)), None);
    }

    #[test]
    fn monitor_at_uses_half_open_edges() {
        let left = monitor(-1920, 0, 1920, 1080, 1.0);
        let right = monitor(0, 0, 1920, 1080, 1.0);
        let all = [left, right];
        assert_eq!(monitor_at(&all, p(-1, 500)), Some(0));
        assert_eq!(monitor_at(&all, p(0, 500)), Some(1));
        assert_eq!(monitor_at(&all, p(-1920, 0)), Some(0));
        assert_eq!(monitor_at(&all, p(1919, 1079)), Some(1));
        assert_eq!(monitor_at(&all, p(1920, 500)), None);
        assert_eq!(monitor_at(&all, p(500, 1080)), None);
    }

    #[test]
    fn monitor_at_misses_a_gap_between_monitors() {
        let left = monitor(-1920, 0, 1920, 1080, 1.0);
        let right = monitor(100, 0, 1920, 1080, 1.0);
        assert_eq!(monitor_at(&[left, right], p(50, 500)), None);
    }

    #[test]
    fn a_capture_of_another_size_is_mapped_with_rounding() {
        // The monitor reports 1920x1080 but the capture is 2400x1350 (x1.25).
        let m = monitor(0, 0, 1920, 1080, 1.0);
        let r = crop_rect(&m, 2400, 1350, p(101, 3), p(200, 102));
        // x: 126.25 -> 126, 251.25 -> 251; y: 3.75 -> 4, 128.75 -> 129.
        assert_eq!(r, Some(rect(126, 4, 125, 125)));
    }

    #[test]
    fn mouse_points_are_sign_extended_from_the_message() {
        let m = monitor(-2880, -400, 2880, 1620, 1.5);
        // Captured mouse left of and above the window: low word 0xFFF6 = -10.
        let lparam = (0xFFECisize << 16) | 0xFFF6; // high word 0xFFEC = -20
        assert_eq!(client_point_to_desktop(&m, lparam), p(-2890, -420));
        let lparam = (0x012Cisize << 16) | 0x01F4; // y = 300, x = 500
        assert_eq!(client_point_to_desktop(&m, lparam), p(-2380, -100));
    }

    fn work(x: i32, y: i32, width: u32, height: u32) -> DesktopRect {
        DesktopRect {
            x,
            y,
            width,
            height,
        }
    }

    /// The card's bottom-right corner in desktop coordinates.
    fn card_corner(layout: &PreviewLayout) -> (i32, i32) {
        (
            layout.window.x + (layout.card.x + layout.card.width).cast_signed(),
            layout.window.y + (layout.card.y + layout.card.height).cast_signed(),
        )
    }

    #[test]
    fn a_preview_sits_16_from_the_corner_above_the_taskbar() {
        let layout = preview_layout(work(0, 0, 1920, 1040), 1.0, (1920, 1080));
        assert_eq!(card_corner(&layout), (1904, 1024));
        assert_eq!((layout.image.width, layout.image.height), (240, 135));
        assert_eq!(layout.window.width, 240 + 24);
        assert_eq!(layout.card.x, 12);
    }

    #[test]
    fn a_preview_at_150_percent_scales_everything() {
        let layout = preview_layout(work(0, 0, 2880, 1560), 1.5, (1920, 1080));
        assert_eq!(layout.image.width, 360);
        assert!(layout.image.height.abs_diff(203) <= 1);
        assert_eq!(card_corner(&layout), (2880 - 24, 1560 - 24));
        assert_eq!(layout.card.x, 18);
    }

    #[test]
    fn a_preview_on_a_monitor_left_of_and_above_the_primary_stays_inside() {
        let area = work(-2560, -200, 2560, 1440);
        let layout = preview_layout(area, 1.25, (2560, 1440));
        let window = layout.window;
        assert!(window.x >= area.x && window.y >= area.y);
        assert!(i64::from(window.x) + i64::from(window.width) <= i64::from(area.x) + 2560);
        assert!(i64::from(window.y) + i64::from(window.height) <= i64::from(area.y) + 1440);
        // 16 logical pixels at 125 % is 20 physical pixels from the corner.
        assert_eq!(
            card_corner(&layout),
            (area.x + 2560 - 20, area.y + 1440 - 20)
        );
    }

    #[test]
    fn a_tall_capture_is_limited_by_height_and_keeps_its_aspect() {
        let (w, h) = preview_image_size((400, 1600), 1.25);
        assert_eq!(h, 200);
        assert!(w.abs_diff(50) <= 1);
        let layout = preview_layout(work(0, 0, 1920, 1080), 1.25, (400, 1600));
        assert_eq!(layout.image.height, 200);
    }

    #[test]
    fn a_tiny_capture_is_not_enlarged_and_is_centred_in_the_smallest_card() {
        let layout = preview_layout(work(0, 0, 1920, 1080), 1.0, (20, 10));
        assert_eq!((layout.image.width, layout.image.height), (20, 10));
        assert_eq!((layout.card.width, layout.card.height), (136, 72));
        assert_eq!(layout.image.x, layout.card.x + (136 - 20) / 2);
        assert_eq!(layout.image.y, layout.card.y + (72 - 10) / 2);
    }

    #[test]
    fn a_taskbar_on_the_left_leaves_the_preview_at_the_right_edge() {
        let layout = preview_layout(work(60, 0, 1860, 1080), 1.0, (800, 600));
        assert_eq!(card_corner(&layout).0, 1904);
        assert!(layout.window.x >= 60);
    }

    #[test]
    fn a_work_area_smaller_than_the_preview_pins_it_to_the_work_area_origin() {
        let layout = preview_layout(work(100, 50, 100, 40), 1.0, (800, 600));
        assert_eq!((layout.window.x, layout.window.y), (100, 50));
    }

    #[test]
    fn the_buttons_are_found_where_they_are_drawn() {
        let layout = preview_layout(work(0, 0, 1920, 1080), 1.0, (800, 600));
        let (edit, close) = (layout.edit, layout.close);
        let inside = |r: LocalRect| (r.x.cast_signed() + 1, r.y.cast_signed() + 1);
        let (x, y) = inside(edit);
        assert_eq!(preview_button_at(&layout, x, y), Some(PreviewButton::Edit));
        let (x, y) = inside(close);
        assert_eq!(preview_button_at(&layout, x, y), Some(PreviewButton::Close));
        let (x, y) = (
            layout.card.x.cast_signed() + 100,
            layout.card.y.cast_signed() + 100,
        );
        assert_eq!(preview_button_at(&layout, x, y), None);
        assert_eq!(preview_button_at(&layout, -1, -1), None);
        assert!(close.x + close.width <= layout.card.x + layout.card.width);
        assert!(edit.x + edit.width < close.x);
    }

    #[test]
    fn the_bar_buttons_are_found_where_they_are_drawn() {
        let layout = mode_bar_layout(2880, 1.5, [60.0, 70.0, 110.0, 50.0], 20.0);
        let kinds = [
            BarButton::Region,
            BarButton::Window,
            BarButton::FullScreen,
            BarButton::Cancel,
        ];
        for (kind, rect) in layout.buttons {
            let (left, top) = (rect.x.cast_signed(), rect.y.cast_signed());
            let (right, bottom) = (
                (rect.x + rect.width).cast_signed(),
                (rect.y + rect.height).cast_signed(),
            );
            assert_eq!(bar_button_at(&layout, left, top), Some(kind));
            assert_eq!(bar_button_at(&layout, right - 1, bottom - 1), Some(kind));
            assert_eq!(bar_button_at(&layout, left, top - 1), None);
            assert_eq!(bar_button_at(&layout, left, bottom), None);
        }
        assert_eq!(layout.buttons.map(|(kind, _)| kind), kinds);
        // The bar is centred and a gap separates every pair of buttons.
        let bar = layout.bar;
        assert_eq!(bar.x * 2 + bar.width, 2880);
        for pair in layout.buttons.windows(2) {
            assert!(pair[0].1.x + pair[0].1.width < pair[1].1.x);
        }
        let first_gap = layout.buttons[1].1.x - (layout.buttons[0].1.x + layout.buttons[0].1.width);
        let cancel_gap =
            layout.buttons[3].1.x - (layout.buttons[2].1.x + layout.buttons[2].1.width);
        assert!(cancel_gap > first_gap);
        assert_eq!(
            bar_button_at(&layout, bar.x.cast_signed() + 1, bar.y.cast_signed() + 1),
            None
        );
    }

    #[test]
    fn a_bar_wider_than_the_monitor_starts_at_the_left_edge() {
        let layout = mode_bar_layout(200, 1.0, [100.0; 4], 18.0);
        assert_eq!(layout.bar.x, 0);
    }
}
