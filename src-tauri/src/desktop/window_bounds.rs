//! Restored-window geometry guard, ported from `src/main/window-bounds.ts`.
//! A saved rect may name a display that is no longer attached; a window that
//! "opens" there is unreachable, so it is recentered on the fallback display.

/// A rectangle in logical pixels, as the renderer and the saved state use it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Only the top strip matters: it carries the title bar the user drags by.
const GRAB_BAND_HEIGHT: f64 = 28.0;
const MIN_GRAB_WIDTH: f64 = 60.0;

fn intersects(a: &Rect, b: &Rect) -> bool {
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/// True when enough of the window's title bar sits on some display to reach it.
pub(crate) fn is_reachable(rect: &Rect, work_areas: &[Rect]) -> bool {
    let band = Rect { x: rect.x, y: rect.y, width: rect.width, height: GRAB_BAND_HEIGHT };
    work_areas.iter().any(|area| {
        let clipped_width = (band.x + band.width).min(area.x + area.width) - band.x.max(area.x);
        let clipped_height = (band.y + band.height).min(area.y + area.height) - band.y.max(area.y);
        clipped_width >= MIN_GRAB_WIDTH && clipped_height > 0.0 && intersects(&band, area)
    })
}

/// Keep `rect` where it was when its title bar is on a screen, otherwise place
/// it centred on the fallback display (never resized when it fits: a window the
/// user stretched across two monitors comes back that way when both return).
pub(crate) fn restore_within_displays(rect: Rect, work_areas: &[Rect]) -> Rect {
    let Some(area) = work_areas.first() else { return rect };
    if is_reachable(&rect, work_areas) {
        return rect;
    }
    let width = rect.width.min((area.width - 40.0).max(1.0));
    let height = rect.height.min((area.height - 40.0).max(1.0));
    Rect {
        x: (area.x + (area.width - width) / 2.0).round(),
        y: (area.y + (area.height - height) / 2.0).round(),
        width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Rect = Rect { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 };
    const MONITOR: Rect = Rect { x: 1440.0, y: 0.0, width: 2560.0, height: 1440.0 };

    #[test]
    fn recenters_a_window_saved_on_a_display_that_is_no_longer_attached() {
        let saved = Rect { x: 4200.0, y: 1600.0, width: 1200.0, height: 800.0 };
        let restored = restore_within_displays(saved, &[LAPTOP]);
        assert_ne!(restored, saved);
        assert!(is_reachable(&restored, &[LAPTOP]));
        assert_eq!(restored.x, ((1440.0 - 1200.0) / 2.0f64).round());
        assert_eq!(restored.y, ((900.0 - 800.0) / 2.0f64).round());
    }

    #[test]
    fn leaves_a_fully_on_screen_geometry_untouched_position_and_size_both() {
        let saved = Rect { x: 120.0, y: 80.0, width: 1000.0, height: 700.0 };
        assert_eq!(restore_within_displays(saved, &[LAPTOP, MONITOR]), saved);
    }

    #[test]
    fn keeps_a_window_that_hangs_off_one_edge_as_long_as_its_title_bar_is_grabbable() {
        let stretched = Rect { x: 1240.0, y: 40.0, width: 1200.0, height: 800.0 };
        assert!(is_reachable(&stretched, &[LAPTOP, MONITOR]));
        assert_eq!(restore_within_displays(stretched, &[LAPTOP, MONITOR]), stretched);
    }

    #[test]
    fn fits_a_monitor_sized_window_to_the_only_display_left_when_recentering() {
        let wide = Rect { x: 2600.0, y: 0.0, width: 2000.0, height: 1200.0 };
        let restored = restore_within_displays(wide, &[LAPTOP]);
        assert!(is_reachable(&restored, &[LAPTOP]));
        assert_eq!(restored.width, LAPTOP.width - 40.0);
        assert_eq!(restored.height, LAPTOP.height - 40.0);
    }

    #[test]
    fn a_vertically_off_screen_window_is_pulled_back_below_the_menu_bar() {
        let saved = Rect { x: 200.0, y: -1400.0, width: 900.0, height: 600.0 };
        let restored = restore_within_displays(saved, &[LAPTOP]);
        assert!(restored.y >= LAPTOP.y);
        assert!(restored.y + 28.0 <= LAPTOP.height);
    }
}
