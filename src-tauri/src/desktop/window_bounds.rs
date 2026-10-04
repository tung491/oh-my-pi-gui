//! Restored-window geometry guard, ported from `src/main/window-bounds.ts`.
//! A saved rect may name a display that is no longer attached; a window that
//! "opens" there is unreachable, so it is recentered on the fallback display.

/// The smallest content size a chat window may have, in logical pixels.
pub(crate) const MIN_WIDTH: f64 = 800.0;
pub(crate) const MIN_HEIGHT: f64 = 600.0;

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

/// The largest window decoration (outer footprint minus content size, logical
/// pixels) believed to be real. GNOME's client-side header bar and shadow are
/// about 52x89, Windows' borders and caption about 16x39, macOS' title bar
/// 0x28; a larger gap is a bogus measurement (a size cache still holding the
/// window's position, or a first configure the compositor constrained).
const MAX_DECORATION_WIDTH: f64 = 200.0;
const MAX_DECORATION_HEIGHT: f64 = 300.0;

/// The content (inner) size to request so a window's full footprint (the
/// outer bounds `windowState` saves, matching Electron's `getBounds()` /
/// `useContentSize: false` semantics) ends up at `target_outer`.
///
/// The window builder can only ask for a content size, so a window is built
/// at `requested_inner` and its realized footprint (`measured_outer`) read
/// back; the gap between the two is the platform's window decoration (GTK's
/// client-side header bar and shadow, a title bar and border elsewhere).
/// Subtracting it from the target gives the content size whose footprint is
/// exactly `target_outer`, as long as the decoration stays constant — true for
/// a fixed theme and scale factor.
///
/// `None` means the measurement is not a plausible decoration (negative, or
/// past the ceilings above) and the window keeps its requested content size,
/// so its footprint is one decoration larger than the target. That footprint
/// is what gets saved, so while the measurement keeps failing the window grows
/// by one decoration per launch; applying a bogus decoration instead can double
/// it at once. A tiling window manager's first configure (the tile, not the
/// requested size) is a known gap: a tile up to the ceilings larger than the
/// target reads as a decoration. The result never goes below the window's
/// minimum content size.
pub(crate) fn corrected_inner_size(target_outer: (f64, f64), requested_inner: (f64, f64), measured_outer: (f64, f64)) -> Option<(f64, f64)> {
    let decoration = (measured_outer.0 - requested_inner.0, measured_outer.1 - requested_inner.1);
    let plausible = (0.0..=MAX_DECORATION_WIDTH).contains(&decoration.0) && (0.0..=MAX_DECORATION_HEIGHT).contains(&decoration.1);
    plausible.then(|| ((target_outer.0 - decoration.0).max(MIN_WIDTH), (target_outer.1 - decoration.1).max(MIN_HEIGHT)))
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

    #[test]
    fn corrects_the_requested_inner_size_so_the_outer_footprint_matches_the_target() {
        // GTK client-side decorations add 52x89 logical pixels (header bar +
        // shadow) once a window is realized.
        let corrected = corrected_inner_size((1452.0, 989.0), (1452.0, 989.0), (1504.0, 1078.0));
        assert_eq!(corrected, Some((1400.0, 900.0)));
        let (width, height) = corrected.unwrap();
        assert_eq!((width + 52.0, height + 89.0), (1452.0, 989.0));
    }

    #[test]
    fn a_known_decoration_is_subtracted_from_a_default_sized_target() {
        assert_eq!(corrected_inner_size((1400.0, 900.0), (1400.0, 900.0), (1452.0, 989.0)), Some((1348.0, 811.0)));
    }

    #[test]
    fn zero_decoration_leaves_the_requested_size_unchanged() {
        assert_eq!(corrected_inner_size((1400.0, 900.0), (1400.0, 900.0), (1400.0, 900.0)), Some((1400.0, 900.0)));
    }

    #[test]
    fn a_size_cache_still_holding_the_window_position_never_doubles_the_window() {
        // Before its first configure, a Linux window reports its position as
        // its outer size. Read as a decoration that is hugely negative; the
        // old arithmetic turned (260, 90) into a 2540x1710 window.
        for position in [(260.0, 90.0), (0.0, 0.0), (28.0, 28.0)] {
            assert_eq!(corrected_inner_size((1400.0, 900.0), (1400.0, 900.0), position), None, "{position:?}");
        }
    }

    #[test]
    fn a_decoration_past_the_plausibility_ceilings_is_ignored() {
        let target = (1400.0, 900.0);
        assert_eq!(corrected_inner_size(target, target, (1600.0, 1200.0)), Some((1200.0, 600.0)));
        assert_eq!(corrected_inner_size(target, target, (1601.0, 1000.0)), None, "201 px wide");
        assert_eq!(corrected_inner_size(target, target, (1500.0, 1201.0)), None, "301 px tall");
        assert_eq!(corrected_inner_size(target, target, (1399.0, 950.0)), None, "negative width");
    }

    #[test]
    fn the_corrected_size_never_drops_below_the_minimum_window_size() {
        assert_eq!(corrected_inner_size((820.0, 650.0), (820.0, 650.0), (872.0, 739.0)), Some((MIN_WIDTH, MIN_HEIGHT)));
    }
}
