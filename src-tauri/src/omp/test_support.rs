//! Helpers shared by this module's tests.

use std::path::Path;
use std::process::{Command, Stdio};

/// Writes an executable fixture through a child shell. A write descriptor held in
/// the test process would be copied by any concurrent fork, and exec of the file
/// would then fail with ETXTBSY until that child exec'd.
pub(crate) fn write_executable(path: &Path, body: &str) {
    let status = Command::new("/bin/sh")
        .args(["-c", "printf '%s' \"$1\" > \"$0\" && chmod 755 \"$0\"", &path.to_string_lossy(), body])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .status()
        .expect("spawn /bin/sh to write a fixture");
    assert!(status.success(), "writing fixture {}", path.display());
}
