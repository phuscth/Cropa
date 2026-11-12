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
fn map_edge(edge: u32, capture: u32, monitor: u32) -> u32 {
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
}
