//! Picking a window or a whole monitor on the overlay: pure functions on
//! physical desktop pixels, so z-order, multi-monitor, negative origins and mixed
//! DPI are testable on any machine.

use super::geometry::{DesktopRect, LocalRect, Point, map_edge, monitor_at};
use super::{CaptureMode, MonitorInfo, PixelRect};

/// What the OS reported about one top-level window, in z-order (topmost first).
// One flag per fact Windows reports; the filter below is their only reader.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowCandidate {
    /// The visible frame, without the invisible resize border; `None` when unknown.
    pub bounds: Option<DesktopRect>,
    pub visible: bool,
    pub minimised: bool,
    pub cloaked: bool,
    pub tool_window: bool,
    /// The desktop itself, which is not a window the user means to capture.
    pub desktop_shell: bool,
    /// Click-through (a game or GPU overlay): it neither hides nor offers anything.
    pub transparent: bool,
    pub process_id: u32,
}

/// A window on screen, in z-order. Windows the user cannot pick still hide
/// whatever lies under them, so they stay in the list as blockers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListedWindow {
    pub bounds: DesktopRect,
    pub pickable: bool,
}

/// The windows that cover the screen, topmost first. Dropped entirely: invisible,
/// minimised, cloaked, click-through and desktop windows, and those without an
/// area. Tool windows and windows owned by `own_process` stay as blockers.
pub fn listed_windows(
    candidates: impl IntoIterator<Item = WindowCandidate>,
    own_process: u32,
) -> Vec<ListedWindow> {
    candidates
        .into_iter()
        .filter(|c| c.visible && !c.minimised && !c.cloaked && !c.transparent && !c.desktop_shell)
        .filter_map(|c| {
            let bounds = c.bounds.filter(|b| b.width > 0 && b.height > 0)?;
            Some(ListedWindow {
                bounds,
                pickable: !c.tool_window && c.process_id != own_process,
            })
        })
        .collect()
}

/// Index of the topmost window containing `p`, pickable or not. Edges are
/// half-open, like [`super::geometry::monitor_at`].
pub fn window_at(windows: &[ListedWindow], p: Point) -> Option<usize> {
    let (x, y) = (i64::from(p.x), i64::from(p.y));
    windows.iter().position(|w| {
        let w = w.bounds;
        let (left, top) = (i64::from(w.x), i64::from(w.y));
        x >= left && y >= top && x < left + i64::from(w.width) && y < top + i64::from(w.height)
    })
}

/// A monitor and the size of its capture.
#[derive(Debug, Clone, PartialEq)]
pub struct MonitorView {
    pub monitor: MonitorInfo,
    pub capture_width: u32,
    pub capture_height: u32,
}

/// What a click at a point would capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pick {
    /// Index into the monitors given to [`pick`].
    pub monitor: usize,
    /// Where to highlight it, in that monitor's pixels.
    pub local: LocalRect,
    /// What to crop, in that monitor's capture pixels.
    pub crop: PixelRect,
}

/// What window or full-screen mode picks at `p`: the pickable window on top
/// there, or the monitor under it. Only the part on the monitor under `p` is
/// picked. `None` in region mode, in a gap between monitors, over empty
/// desktop, or when the topmost window there is one the user cannot pick.
pub fn pick(
    mode: CaptureMode,
    monitors: &[MonitorView],
    windows: &[ListedWindow],
    p: Point,
) -> Option<Pick> {
    let index = monitor_at(monitors.iter().map(|v| &v.monitor), p)?;
    let view = &monitors[index];
    match mode {
        CaptureMode::Region => None,
        CaptureMode::FullScreen => Some(Pick {
            monitor: index,
            local: LocalRect {
                x: 0,
                y: 0,
                width: view.monitor.width,
                height: view.monitor.height,
            },
            crop: full_monitor(view.capture_width, view.capture_height)?,
        }),
        CaptureMode::Window => {
            let top = windows[window_at(windows, p)?];
            if !top.pickable {
                return None;
            }
            let (local, crop) = window_on_monitor(
                top.bounds,
                &view.monitor,
                view.capture_width,
                view.capture_height,
            )?;
            Some(Pick {
                monitor: index,
                local,
                crop,
            })
        }
    }
}

/// The part of `window` on `monitor`: where to draw it (monitor-local pixels)
/// and what to crop (capture pixels, mapped by the capture-to-monitor size
/// ratio like `crop_rect`). `None` when the window does not reach that monitor.
/// A window spanning monitors is clipped to this monitor. The scale factor
/// plays no part: the window and the monitor are both physical.
pub fn window_on_monitor(
    window: DesktopRect,
    monitor: &MonitorInfo,
    capture_width: u32,
    capture_height: u32,
) -> Option<(LocalRect, PixelRect)> {
    let clip = |origin: i32, extent: u32, monitor_origin: i32, monitor_extent: u32| {
        let start = i64::from(origin).max(i64::from(monitor_origin));
        let end = (i64::from(origin) + i64::from(extent))
            .min(i64::from(monitor_origin) + i64::from(monitor_extent));
        // Both edges are inside 0..=monitor_extent once relative to the monitor.
        let start = u32::try_from(start - i64::from(monitor_origin)).ok()?;
        let end = u32::try_from(end - i64::from(monitor_origin)).ok()?;
        (end > start).then_some((start, end))
    };
    let (left, right) = clip(window.x, window.width, monitor.x, monitor.width)?;
    let (top, bottom) = clip(window.y, window.height, monitor.y, monitor.height)?;

    let local = LocalRect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };

    let map_x = |edge| map_edge(edge, capture_width, monitor.width).min(capture_width);
    let map_y = |edge| map_edge(edge, capture_height, monitor.height).min(capture_height);
    let (crop_left, crop_right) = (map_x(left), map_x(right));
    let (crop_top, crop_bottom) = (map_y(top), map_y(bottom));
    let width = crop_right.saturating_sub(crop_left);
    let height = crop_bottom.saturating_sub(crop_top);
    if width == 0 || height == 0 {
        return None;
    }
    Some((
        local,
        PixelRect {
            x: crop_left,
            y: crop_top,
            width,
            height,
        },
    ))
}

/// The whole capture of a monitor; `None` when the capture is empty.
pub fn full_monitor(capture_width: u32, capture_height: u32) -> Option<PixelRect> {
    (capture_width > 0 && capture_height > 0).then_some(PixelRect {
        x: 0,
        y: 0,
        width: capture_width,
        height: capture_height,
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

    fn win(x: i32, y: i32, width: u32, height: u32) -> DesktopRect {
        DesktopRect {
            x,
            y,
            width,
            height,
        }
    }

    fn local(x: u32, y: u32, width: u32, height: u32) -> LocalRect {
        LocalRect {
            x,
            y,
            width,
            height,
        }
    }

    fn crop(x: u32, y: u32, width: u32, height: u32) -> PixelRect {
        PixelRect {
            x,
            y,
            width,
            height,
        }
    }

    fn p(x: i32, y: i32) -> Point {
        Point { x, y }
    }

    fn candidate(bounds: Option<DesktopRect>) -> WindowCandidate {
        WindowCandidate {
            bounds,
            visible: true,
            minimised: false,
            cloaked: false,
            tool_window: false,
            desktop_shell: false,
            transparent: false,
            process_id: 10,
        }
    }

    fn listed(x: i32, y: i32, width: u32, height: u32, pickable: bool) -> ListedWindow {
        ListedWindow {
            bounds: win(x, y, width, height),
            pickable,
        }
    }

    fn view(monitor: MonitorInfo) -> MonitorView {
        MonitorView {
            capture_width: monitor.width,
            capture_height: monitor.height,
            monitor,
        }
    }

    #[test]
    fn the_topmost_window_under_the_point_wins() {
        // Topmost first: the first window overlaps the second one's right part.
        let windows = [
            listed(100, 100, 300, 200, true),
            listed(0, 0, 250, 250, true),
        ];
        assert_eq!(window_at(&windows, p(150, 150)), Some(0));
        assert_eq!(window_at(&windows, p(20, 20)), Some(1));
        assert_eq!(window_at(&windows, p(600, 600)), None);
    }

    #[test]
    fn window_edges_are_half_open() {
        let windows = [listed(100, 100, 300, 200, true)];
        assert_eq!(window_at(&windows, p(100, 100)), Some(0));
        assert_eq!(window_at(&windows, p(399, 299)), Some(0));
        assert_eq!(window_at(&windows, p(400, 150)), None);
        assert_eq!(window_at(&windows, p(150, 300)), None);
        assert_eq!(window_at(&windows, p(99, 150)), None);
    }

    #[test]
    fn a_window_left_of_the_origin_is_found() {
        let windows = [listed(-500, -50, 400, 200, true)];
        assert_eq!(window_at(&windows, p(-500, -50)), Some(0));
        assert_eq!(window_at(&windows, p(-101, 149)), Some(0));
        assert_eq!(window_at(&windows, p(-100, 0)), None);
    }

    #[test]
    fn dropped_windows_do_not_block_but_unpickable_ones_do_and_z_order_is_kept() {
        let area = Some(win(0, 0, 100, 100));
        let own = 99;
        let candidates = [
            WindowCandidate {
                bounds: Some(win(1, 1, 10, 10)),
                ..candidate(area)
            },
            WindowCandidate {
                visible: false,
                ..candidate(area)
            },
            WindowCandidate {
                minimised: true,
                ..candidate(area)
            },
            WindowCandidate {
                cloaked: true,
                ..candidate(area)
            },
            WindowCandidate {
                desktop_shell: true,
                ..candidate(area)
            },
            WindowCandidate {
                transparent: true,
                ..candidate(area)
            },
            candidate(Some(win(0, 0, 0, 50))),
            candidate(Some(win(0, 0, 50, 0))),
            candidate(None),
            WindowCandidate {
                tool_window: true,
                bounds: Some(win(3, 3, 30, 30)),
                ..candidate(area)
            },
            WindowCandidate {
                process_id: own,
                bounds: Some(win(4, 4, 40, 40)),
                ..candidate(area)
            },
            WindowCandidate {
                bounds: Some(win(2, 2, 20, 20)),
                ..candidate(area)
            },
        ];
        assert_eq!(
            listed_windows(candidates, own),
            vec![
                listed(1, 1, 10, 10, true),
                listed(3, 3, 30, 30, false),
                listed(4, 4, 40, 40, false),
                listed(2, 2, 20, 20, true),
            ]
        );
    }

    #[test]
    fn a_blocker_on_top_hides_the_window_below_it() {
        let monitors = [view(monitor(0, 0, 1920, 1080, 1.0))];
        // Cropa's own editor over a normal window.
        let windows = [
            listed(500, 300, 600, 400, false),
            listed(0, 0, 1000, 700, true),
        ];
        // Only the lower window is under this point: it can be picked.
        let free = pick(CaptureMode::Window, &monitors, &windows, p(100, 100));
        assert_eq!(free.map(|f| f.crop), Some(crop(0, 0, 1000, 700)));
        // The blocker covers this point of the lower window too.
        assert_eq!(
            pick(CaptureMode::Window, &monitors, &windows, p(600, 400)),
            None
        );
    }

    #[test]
    fn window_mode_over_empty_desktop_picks_nothing() {
        let monitors = [view(monitor(0, 0, 1920, 1080, 1.0))];
        let windows = [listed(100, 100, 300, 200, true)];
        assert_eq!(
            pick(CaptureMode::Window, &monitors, &windows, p(900, 900)),
            None
        );
        assert_eq!(pick(CaptureMode::Window, &monitors, &[], p(10, 10)), None);
    }

    #[test]
    fn a_window_spanning_monitors_picks_the_part_under_the_point() {
        let monitors = [
            view(monitor(-2880, 0, 2880, 1620, 1.5)),
            view(monitor(0, 0, 1920, 1080, 1.0)),
        ];
        let windows = [listed(-500, 100, 1200, 300, true)];
        let left = pick(CaptureMode::Window, &monitors, &windows, p(-100, 200)).expect("left");
        assert_eq!(left.monitor, 0);
        assert_eq!(left.local, local(2380, 100, 500, 300));
        assert_eq!(left.crop, crop(2380, 100, 500, 300));
        let right = pick(CaptureMode::Window, &monitors, &windows, p(300, 200)).expect("right");
        assert_eq!(right.monitor, 1);
        assert_eq!(right.local, local(0, 100, 700, 300));
        assert_eq!(right.crop, crop(0, 100, 700, 300));
    }

    #[test]
    fn full_screen_picks_the_monitor_under_the_point() {
        let monitors = [
            view(monitor(-2880, 0, 2880, 1620, 1.5)),
            view(monitor(0, 0, 1920, 1080, 1.0)),
        ];
        // A window on top does not matter in this mode.
        let windows = [listed(-500, 100, 1200, 300, false)];
        let right = pick(CaptureMode::FullScreen, &monitors, &windows, p(300, 200)).expect("right");
        assert_eq!(right.monitor, 1);
        assert_eq!(right.local, local(0, 0, 1920, 1080));
        assert_eq!(right.crop, crop(0, 0, 1920, 1080));
        let left = pick(CaptureMode::FullScreen, &monitors, &windows, p(-2000, 5)).expect("left");
        assert_eq!(left.monitor, 0);
        assert_eq!(left.crop, crop(0, 0, 2880, 1620));
    }

    #[test]
    fn a_point_between_monitors_or_in_region_mode_picks_nothing() {
        let monitors = [
            view(monitor(-1920, 0, 1920, 1080, 1.0)),
            view(monitor(100, 0, 1920, 1080, 1.0)),
        ];
        let windows = [listed(-500, 0, 1000, 500, true)];
        for mode in [CaptureMode::Window, CaptureMode::FullScreen] {
            assert_eq!(pick(mode, &monitors, &windows, p(50, 200)), None);
        }
        assert_eq!(
            pick(CaptureMode::Region, &monitors, &windows, p(200, 200)),
            None
        );
    }

    #[test]
    fn a_window_on_a_monitor_left_of_and_above_the_primary() {
        let m = monitor(-2880, -400, 2880, 1620, 1.5);
        let window = win(-2000, -100, 500, 400);
        assert_eq!(
            window_on_monitor(window, &m, 2880, 1620),
            Some((local(880, 300, 500, 400), crop(880, 300, 500, 400)))
        );
    }

    #[test]
    fn a_window_spanning_mixed_dpi_monitors_is_clipped_to_each() {
        let left = monitor(-2880, 0, 2880, 1620, 1.5);
        let primary = monitor(0, 0, 1920, 1080, 1.0);
        let window = win(-500, 100, 1200, 300);
        assert_eq!(
            window_on_monitor(window, &left, 2880, 1620),
            Some((local(2380, 100, 500, 300), crop(2380, 100, 500, 300)))
        );
        assert_eq!(
            window_on_monitor(window, &primary, 1920, 1080),
            Some((local(0, 100, 700, 300), crop(0, 100, 700, 300)))
        );
    }

    #[test]
    fn a_window_partly_off_screen_is_clipped_to_the_monitor() {
        let m = monitor(0, 0, 1920, 1080, 1.0);
        // Above the top and past the right edge at once.
        assert_eq!(
            window_on_monitor(win(1800, -60, 400, 300), &m, 1920, 1080),
            Some((local(1800, 0, 120, 240), crop(1800, 0, 120, 240)))
        );
        // Larger than the monitor on every side.
        assert_eq!(
            window_on_monitor(win(-10, -10, 3000, 3000), &m, 1920, 1080),
            Some((local(0, 0, 1920, 1080), crop(0, 0, 1920, 1080)))
        );
    }

    #[test]
    fn a_window_that_does_not_reach_the_monitor_is_not_there() {
        let m = monitor(0, 0, 1920, 1080, 1.0);
        assert_eq!(
            window_on_monitor(win(-400, 0, 400, 300), &m, 1920, 1080),
            None
        );
        assert_eq!(
            window_on_monitor(win(1920, 0, 400, 300), &m, 1920, 1080),
            None
        );
        assert_eq!(
            window_on_monitor(win(0, 1080, 400, 300), &m, 1920, 1080),
            None
        );
        assert_eq!(
            window_on_monitor(win(0, -300, 400, 300), &m, 1920, 1080),
            None
        );
    }

    #[test]
    fn huge_window_values_do_not_overflow() {
        let m = monitor(0, 0, 1920, 1080, 1.0);
        let window = win(i32::MIN, i32::MIN, u32::MAX, u32::MAX);
        assert_eq!(
            window_on_monitor(window, &m, 1920, 1080),
            Some((local(0, 0, 1920, 1080), crop(0, 0, 1920, 1080)))
        );
    }

    #[test]
    fn a_capture_of_another_size_is_mapped_with_rounding() {
        // The monitor reports 1920x1080 but the capture is 2400x1350 (x1.25).
        let m = monitor(0, 0, 1920, 1080, 1.0);
        let window = win(101, 3, 100, 100);
        assert_eq!(
            window_on_monitor(window, &m, 2400, 1350),
            // x: 126.25 -> 126, 251.25 -> 251; y: 3.75 -> 4, 128.75 -> 129.
            Some((local(101, 3, 100, 100), crop(126, 4, 125, 125)))
        );
    }

    #[test]
    fn a_whole_monitor_is_its_whole_capture() {
        assert_eq!(full_monitor(2880, 1620), Some(crop(0, 0, 2880, 1620)));
        assert_eq!(full_monitor(0, 1620), None);
        assert_eq!(full_monitor(2880, 0), None);
    }
}
