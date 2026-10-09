//! The yml release feed electron-builder publishes with every GitHub release:
//! where it lives, how it parses, how its version compares with the running
//! build and which asset this install downloads from it.

use std::fmt::Write as _;

use semver::Version;
use serde::Deserialize;

use super::state::{release_file_name, ReleaseFile};

/// The publishing repository's releases page. A build-time override lets a
/// test bundle read a local feed; shipped builds have no runtime switch.
const GITHUB_RELEASE_BASE: &str = "https://github.com/tung491/oh-my-pi-gui/releases";

pub(crate) fn release_base() -> &'static str {
    option_env!("SAI_ATLAS_UPDATE_BASE").unwrap_or(GITHUB_RELEASE_BASE)
}

/// The Linux channel file, as electron-builder names it (the 0.9.x updater reads the same file).
pub(crate) const FEED_FILE: &str = "latest-linux.yml";

/// `<base>/latest/download/<feed file>`: GitHub redirects to the latest release's asset.
pub(crate) fn feed_url(base: &str) -> String {
    format!("{}/latest/download/{FEED_FILE}", base.trim_end_matches('/'))
}

/// `<base>/download/v<version>/<name>`, both segments encoded as `encodeURIComponent` does.
pub(crate) fn download_url(base: &str, version: &str, name: &str) -> String {
    format!("{}/download/v{}/{}", base.trim_end_matches('/'), encode_uri_component(version), encode_uri_component(name))
}

/// `encodeURIComponent`: everything but its unreserved set becomes `%XX`.
fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => out.push(byte as char),
            // Writing to a String cannot fail.
            _ => {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

/// Release notes as electron-builder writes them: one string, or one entry per version.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(untagged, rename_all = "camelCase")]
enum ReleaseNotes {
    Text(String),
    Items(Vec<ReleaseNote>),
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseNote {
    #[serde(default)]
    note: Option<String>,
}

/// The fields of `latest-*.yml` the updater reads; everything else is ignored.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Feed {
    pub version: String,
    #[serde(default)]
    pub files: Vec<ReleaseFile>,
    #[serde(default)]
    release_notes: Option<ReleaseNotes>,
}

const NOTES_EXCERPT_CHARS: usize = 500;

impl Feed {
    pub(crate) fn parse(yaml: &str) -> Result<Feed, String> {
        let feed: Feed = serde_yml::from_str(yaml).map_err(|error| format!("{FEED_FILE} could not be parsed: {error}"))?;
        Version::parse(&feed.version).map_err(|error| format!("{FEED_FILE} has an invalid version \"{}\": {error}", feed.version))?;
        Ok(feed)
    }

    /// Release-notes excerpt for the banner.
    pub(crate) fn notes(&self) -> Option<String> {
        let text = match self.release_notes.as_ref()? {
            ReleaseNotes::Text(text) => text,
            ReleaseNotes::Items(items) => items.first()?.note.as_ref()?,
        };
        Some(text.chars().take(NOTES_EXCERPT_CHARS).collect())
    }
}

/// Fetch and parse the feed at `url`.
pub(crate) async fn fetch_feed(client: &reqwest::Client, url: &str) -> Result<Feed, String> {
    let response = client.get(url).send().await.map_err(|error| format!("{FEED_FILE} could not be fetched: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{FEED_FILE} could not be fetched ({})", status.as_u16()));
    }
    let body = response.text().await.map_err(|error| format!("{FEED_FILE} could not be read: {error}"))?;
    Feed::parse(&body)
}

/// Whether the feed's release is newer than the running build. Downgrades are
/// never offered; an unparsable version is an error, as electron-updater treats it.
pub(crate) fn is_newer(latest: &str, current: &str) -> Result<bool, String> {
    let latest = Version::parse(latest).map_err(|error| format!("the latest version \"{latest}\" is not a valid semver version: {error}"))?;
    let current = Version::parse(current).map_err(|error| format!("the app version \"{current}\" is not a valid semver version: {error}"))?;
    Ok(latest > current)
}

/// Which release asset this install downloads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AssetTarget {
    LinuxAppImage,
    LinuxDeb,
}

/// One downloadable release asset.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Asset {
    pub name: String,
    pub sha512: String,
    pub size: Option<u64>,
}

/// Pick the asset for `target`: the file with the package extension,
/// preferring one that names this CPU architecture, else the first, as
/// electron-updater's `findFile` does.
pub(crate) fn select_asset(files: &[ReleaseFile], target: AssetTarget) -> Option<Asset> {
    let extension = match target {
        AssetTarget::LinuxAppImage => ".appimage",
        AssetTarget::LinuxDeb => ".deb",
    };
    let named: Vec<(String, &ReleaseFile)> = files
        .iter()
        .map(|file| (release_file_name(&file.url), file))
        .filter(|(name, _)| name.to_lowercase().ends_with(extension))
        .collect();
    let arch = std::env::consts::ARCH;
    let (name, file) = named.iter().find(|(name, _)| name.contains(arch)).or_else(|| named.first())?;
    Some(Asset { name: name.clone(), sha512: file.sha512.clone(), size: file.size })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLISHED: &str = "version: 0.9.15
files:
  - url: Sai-ATLAS-0.9.15-x86_64.AppImage
    sha512: appimage-hash
    size: 257670000
    blockMapSize: 268000
  - url: sai-atlas_0.9.15_amd64.deb
    sha512: deb-hash
    size: 178130000
path: Sai-ATLAS-0.9.15-x86_64.AppImage
sha512: appimage-hash
releaseDate: '2026-09-30T10:00:00.000Z'
";

    fn file(url: &str, sha512: &str) -> ReleaseFile {
        ReleaseFile { url: url.into(), sha512: sha512.into(), size: None }
    }

    #[test]
    fn parses_the_published_linux_feed() {
        let feed = Feed::parse(PUBLISHED).unwrap();
        assert_eq!(feed.version, "0.9.15");
        assert_eq!(feed.files.len(), 2);
        assert_eq!(feed.files[1].url, "sai-atlas_0.9.15_amd64.deb");
        assert_eq!(feed.files[1].size, Some(178_130_000));
        assert_eq!(feed.notes(), None);
    }

    #[test]
    fn reads_release_notes_as_text_or_as_the_first_entry() {
        let text = Feed::parse("version: 1.0.0\nreleaseNotes: 'Fixes **things**'\n").unwrap();
        assert_eq!(text.notes().as_deref(), Some("Fixes **things**"));
        let items = Feed::parse("version: 1.0.0\nreleaseNotes:\n  - version: 1.0.0\n    note: first\n  - version: 0.9.0\n    note: second\n").unwrap();
        assert_eq!(items.notes().as_deref(), Some("first"));
        let long = Feed::parse(&format!("version: 1.0.0\nreleaseNotes: '{}'\n", "x".repeat(900))).unwrap();
        assert_eq!(long.notes().map(|notes| notes.chars().count()), Some(500));
    }

    #[test]
    fn rejects_a_feed_without_a_semver_version() {
        assert!(Feed::parse("version: latest\n").unwrap_err().contains("invalid version"));
        assert!(Feed::parse("files: [\n").unwrap_err().contains("could not be parsed"));
    }

    #[test]
    fn offers_only_a_strictly_newer_release() {
        assert_eq!(is_newer("0.9.16", "0.9.15"), Ok(true));
        assert_eq!(is_newer("0.9.15", "0.9.15"), Ok(false));
        assert_eq!(is_newer("0.9.14", "0.9.15"), Ok(false));
        assert_eq!(is_newer("1.0.0", "1.0.0-beta.1"), Ok(true));
        assert_eq!(is_newer("0.9.16", "0.0.0-test"), Ok(true));
        assert!(is_newer("v0.9.16", "0.9.15").is_err());
        assert!(is_newer("0.9.16", "dev").is_err());
    }

    #[test]
    fn builds_the_feed_and_download_urls_from_one_base() {
        let base = "https://github.com/tung491/oh-my-pi-gui/releases";
        assert_eq!(feed_url(base), format!("{base}/latest/download/{FEED_FILE}"));
        assert_eq!(feed_url(&format!("{base}/")), format!("{base}/latest/download/{FEED_FILE}"));
        assert_eq!(download_url(base, "0.9.16", "sai-atlas_0.9.16_amd64.deb"), format!("{base}/download/v0.9.16/sai-atlas_0.9.16_amd64.deb"));
        assert_eq!(download_url(base, "1.0.0-rc.1", "Sai ATLAS_1.0.0_x86_64.AppImage"), format!("{base}/download/v1.0.0-rc.1/Sai%20ATLAS_1.0.0_x86_64.AppImage"));
        assert!(release_base().starts_with("http"));
    }

    #[test]
    fn selects_the_asset_by_package_kind() {
        let feed = Feed::parse(PUBLISHED).unwrap();
        assert_eq!(
            select_asset(&feed.files, AssetTarget::LinuxDeb),
            Some(Asset { name: "sai-atlas_0.9.15_amd64.deb".into(), sha512: "deb-hash".into(), size: Some(178_130_000) })
        );
        assert_eq!(select_asset(&feed.files, AssetTarget::LinuxAppImage).map(|asset| asset.name).as_deref(), Some("Sai-ATLAS-0.9.15-x86_64.AppImage"));
        let spaced = vec![file("https://example.test/download/Sai%20ATLAS-0.9.15-x86_64.AppImage", "appimage-hash")];
        assert_eq!(select_asset(&spaced, AssetTarget::LinuxAppImage).map(|asset| asset.name).as_deref(), Some("Sai ATLAS-0.9.15-x86_64.AppImage"));
    }

    #[test]
    fn prefers_the_asset_naming_this_architecture() {
        let arch = std::env::consts::ARCH;
        let files = vec![file("sai-atlas_0.9.15_other.deb", "other"), file(&format!("sai-atlas_0.9.15_{arch}.deb"), "mine")];
        assert_eq!(select_asset(&files, AssetTarget::LinuxDeb).map(|asset| asset.sha512).as_deref(), Some("mine"));
    }
}
