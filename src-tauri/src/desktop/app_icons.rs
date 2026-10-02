//! Tray and window icon choices per platform, ported from
//! `src/main/app-icons.ts`. macOS status items are template images (the system
//! recolors them); Ubuntu's AppIndicator shows pixels as drawn on a top bar
//! that is dark in both themes, so Linux gets a white mark. The mark's alpha
//! channel is read from `src/main/tray-mark.ts`, which `gen:icons` renders.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::prelude::*;

use super::Platform;

const TRAY_MARK_TS: &str = include_str!("../../../src/main/tray-mark.ts");

/// The mark as `tray-mark.ts` carries it: side length, one alpha byte per pixel, and the artwork's hash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TrayMark {
    pub size: usize,
    pub alpha: Vec<u8>,
    pub source_sha256: String,
}

/// Pull the constants out of the generated TypeScript module.
pub(crate) fn parse_tray_mark(source: &str) -> Result<TrayMark, String> {
    let size_re = regex::Regex::new(r"TRAY_MARK_SIZE\s*=\s*(\d+)\s*;").map_err(|e| e.to_string())?;
    let alpha_re = regex::Regex::new(r#"TRAY_MARK_ALPHA\s*=\s*"([A-Za-z0-9+/=]+)"\s*;"#).map_err(|e| e.to_string())?;
    let sha_re = regex::Regex::new(r#"TRAY_MARK_SOURCE_SHA256\s*=\s*"([0-9a-f]{64})"\s*;"#).map_err(|e| e.to_string())?;
    let size: usize = size_re
        .captures(source)
        .and_then(|c| c.get(1))
        .ok_or("TRAY_MARK_SIZE missing")?
        .as_str()
        .parse()
        .map_err(|e| format!("TRAY_MARK_SIZE: {e}"))?;
    let encoded = alpha_re.captures(source).and_then(|c| c.get(1)).ok_or("TRAY_MARK_ALPHA missing")?.as_str();
    let alpha = BASE64_STANDARD.decode(encoded).map_err(|e| format!("TRAY_MARK_ALPHA: {e}"))?;
    if alpha.len() != size * size {
        return Err(format!("TRAY_MARK_ALPHA has {} bytes for a {size}×{size} mark", alpha.len()));
    }
    let source_sha256 = sha_re.captures(source).and_then(|c| c.get(1)).ok_or("TRAY_MARK_SOURCE_SHA256 missing")?.as_str().to_string();
    Ok(TrayMark { size, alpha, source_sha256 })
}

/// The mark shipped with this build, parsed once.
pub(crate) fn tray_mark() -> Result<&'static TrayMark, String> {
    static MARK: OnceLock<Result<TrayMark, String>> = OnceLock::new();
    MARK.get_or_init(|| parse_tray_mark(TRAY_MARK_TS)).as_ref().map_err(Clone::clone)
}

/// 32-bit pixels, `size`×`size`, for the tray icon.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TrayBitmap {
    pub pixels: Vec<u8>,
    pub size: usize,
    pub scale_factor: u32,
    pub template: bool,
}

pub(crate) fn tray_icon_bitmap(platform: Platform, mark: &TrayMark) -> TrayBitmap {
    // The mark is 18pt drawn at 2× so it stays crisp on HiDPI displays. The run
    // status is text (tooltip + menu header), never painted into the mark.
    let channel = if platform == Platform::Linux { 255 } else { 0 };
    let mut pixels = vec![0u8; mark.size * mark.size * 4];
    for (index, alpha) in mark.alpha.iter().enumerate() {
        if *alpha == 0 {
            continue;
        }
        pixels[index * 4] = channel;
        pixels[index * 4 + 1] = channel;
        pixels[index * 4 + 2] = channel;
        pixels[index * 4 + 3] = *alpha;
    }
    TrayBitmap { pixels, size: mark.size, scale_factor: 2, template: platform != Platform::Linux }
}

/// Window/taskbar icon for Linux; macOS and Windows take it from the bundle.
pub(crate) fn linux_window_icon_path(platform: Platform, packaged: bool, resources_path: &Path, app_path: &Path) -> Option<PathBuf> {
    if platform != Platform::Linux {
        return None;
    }
    Some(if packaged { resources_path.join("icon.png") } else { app_path.join("resources").join("icon.png") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

    fn mark() -> &'static TrayMark {
        tray_mark().unwrap()
    }

    fn pixel(bitmap: &TrayBitmap, x: usize, y: usize) -> [u8; 4] {
        let index = (y * bitmap.size + x) * 4;
        [bitmap.pixels[index], bitmap.pixels[index + 1], bitmap.pixels[index + 2], bitmap.pixels[index + 3]]
    }

    fn alpha_at(bitmap: &TrayBitmap, index: usize) -> u8 {
        bitmap.pixels[index * 4 + 3]
    }

    /// Every drawn pixel carries the platform's ink; the rest stay fully transparent.
    fn expect_ink(bitmap: &TrayBitmap, channel: u8) {
        for index in 0..bitmap.size * bitmap.size {
            let [r, g, b, a] = pixel(bitmap, index % bitmap.size, index / bitmap.size);
            if a > 0 {
                assert_eq!([r, g, b], [channel, channel, channel], "pixel {index}");
            } else {
                assert_eq!([r, g, b], [0, 0, 0], "pixel {index}");
            }
        }
    }

    fn opaque_share(bitmap: &TrayBitmap) -> f64 {
        let opaque = (0..bitmap.size * bitmap.size).filter(|index| alpha_at(bitmap, *index) > 0).count();
        opaque as f64 / (bitmap.size * bitmap.size) as f64
    }

    fn expect_clear_corners(bitmap: &TrayBitmap) {
        let last = bitmap.size - 1;
        for (x, y) in [(0, 0), (last, 0), (0, last), (last, last)] {
            assert_eq!(pixel(bitmap, x, y), [0, 0, 0, 0]);
        }
    }

    #[test]
    fn keeps_the_macos_menu_bar_mark_a_black_template_image() {
        let bitmap = tray_icon_bitmap(Platform::Darwin, mark());
        assert_eq!((bitmap.size, bitmap.scale_factor, bitmap.template), (36, 2, true));
        assert_eq!(bitmap.pixels.len(), 36 * 36 * 4);
        expect_ink(&bitmap, 0);
        expect_clear_corners(&bitmap);
        assert!(opaque_share(&bitmap) > 0.15);
        assert!(opaque_share(&bitmap) < 0.6);
    }

    #[test]
    fn paints_the_same_mark_white_for_the_dark_ubuntu_top_bar() {
        let bitmap = tray_icon_bitmap(Platform::Linux, mark());
        assert_eq!((bitmap.size, bitmap.scale_factor, bitmap.template), (36, 2, false));
        expect_ink(&bitmap, 255);
        expect_clear_corners(&bitmap);
        let darwin = tray_icon_bitmap(Platform::Darwin, mark());
        for index in 0..bitmap.size * bitmap.size {
            assert_eq!(alpha_at(&bitmap, index), alpha_at(&darwin, index));
        }
    }

    #[test]
    fn leaves_the_windows_tray_bitmap_exactly_as_macos_draws_it() {
        assert_eq!(tray_icon_bitmap(Platform::Win32, mark()), tray_icon_bitmap(Platform::Darwin, mark()));
    }

    #[test]
    fn was_rendered_from_the_current_tray_artwork() {
        // Editing resources/tray-source.svg without `bun run gen:icons` fails here.
        let source = include_bytes!("../../../resources/tray-source.svg");
        assert_eq!(hex::encode(sha2::Sha256::digest(source)), mark().source_sha256);
    }

    #[test]
    fn extracts_the_mark_from_the_generated_module() {
        let parsed = parse_tray_mark("export const TRAY_MARK_SIZE = 2;\nexport const TRAY_MARK_ALPHA =\n\t\"AP8A/w==\";\nexport const TRAY_MARK_SOURCE_SHA256 = \"0000000000000000000000000000000000000000000000000000000000000000\";\n").unwrap();
        assert_eq!(parsed.size, 2);
        assert_eq!(parsed.alpha, vec![0, 255, 0, 255]);
        assert!(parse_tray_mark("export const TRAY_MARK_SIZE = 3;\nexport const TRAY_MARK_ALPHA = \"AP8A/w==\";\nexport const TRAY_MARK_SOURCE_SHA256 = \"0000000000000000000000000000000000000000000000000000000000000000\";").is_err());
        assert!(parse_tray_mark("nothing here").is_err());
    }

    #[test]
    fn points_packaged_linux_windows_at_the_bundled_icon() {
        assert_eq!(
            linux_window_icon_path(Platform::Linux, true, Path::new("/opt/Sai ATLAS/resources"), Path::new("/opt/Sai ATLAS/resources/app.asar")),
            Some(PathBuf::from("/opt/Sai ATLAS/resources/icon.png"))
        );
    }

    #[test]
    fn uses_the_checkout_icon_in_a_dev_run() {
        assert_eq!(
            linux_window_icon_path(Platform::Linux, false, Path::new("/electron/resources"), Path::new("/src/gui")),
            Some(PathBuf::from("/src/gui/resources/icon.png"))
        );
    }

    #[test]
    fn leaves_macos_and_windows_to_their_bundle_icons() {
        assert_eq!(linux_window_icon_path(Platform::Darwin, true, Path::new("/r"), Path::new("/a")), None);
        assert_eq!(linux_window_icon_path(Platform::Win32, true, Path::new("/r"), Path::new("/a")), None);
    }
}
