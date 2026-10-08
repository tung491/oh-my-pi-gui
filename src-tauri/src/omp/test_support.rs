//! Helpers shared by this module's tests.

use std::path::{Path, PathBuf};
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

/// The real sidecar fixture, which runs under the supervisor exactly like omp.
pub(crate) fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("e2e").join("sidecar-fixture.ts").canonicalize().unwrap()
}

/// The environment variable naming the file the sidecar fixture writes its
/// `process.env` to as JSON. macOS does not show a process's environment to
/// another process, so the fixture reports it itself.
pub(crate) const FIXTURE_ENV_DUMP: &str = "OMP_GUI_TEST_ENV_DUMP";

/// The environment the fixture wrote to `path`, waiting up to 5 s for the file.
pub(crate) async fn read_env_dump(path: &Path) -> std::collections::HashMap<String, String> {
    for _ in 0..500 {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(env) = serde_json::from_str(&text) {
                return env;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the fixture never wrote its environment to {}", path.display());
}

/// One `ps` column for `pid`, trimmed; `None` when the process is gone.
#[cfg(not(target_os = "linux"))]
fn ps_field(pid: u32, field: &str) -> Option<String> {
    // Without -ww, macOS cuts `args` to the terminal width.
    let output = Command::new("/bin/ps").args(["-ww", "-o", field, "-p", &pid.to_string()]).stderr(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !text.is_empty()).then_some(text)
}

/// The fields of `/proc/<pid>/stat` after the command name, which may hold spaces.
#[cfg(target_os = "linux")]
fn stat_fields(pid: u32) -> Option<Vec<String>> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, rest) = stat.rsplit_once(')')?;
    Some(rest.split_whitespace().map(str::to_string).collect())
}

/// True while `pid` runs and is not a zombie.
pub(crate) fn alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        stat_fields(pid).is_some_and(|fields| fields.first().map(String::as_str) != Some("Z"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_ok() && ps_field(pid, "stat=").is_some_and(|stat| !stat.starts_with('Z'))
    }
}

/// `pid`'s argv. Off Linux it comes from `ps`, split on whitespace, so it is
/// exact only for arguments without spaces, which every test argv here is.
pub(crate) fn argv(pid: u32) -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default().split(|byte| *byte == 0).filter(|part| !part.is_empty()).map(|part| String::from_utf8_lossy(part).into_owned()).collect()
    }
    #[cfg(not(target_os = "linux"))]
    {
        ps_field(pid, "args=").map(|args| args.split_whitespace().map(str::to_string).collect()).unwrap_or_default()
    }
}

/// `pid`'s parent pid.
pub(crate) fn ppid(pid: u32) -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        stat_fields(pid)?.get(1)?.parse().ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        ps_field(pid, "ppid=")?.parse().ok()
    }
}

/// `pid`'s working directory.
pub(crate) fn cwd(pid: u32) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let output = Command::new("/usr/sbin/lsof").args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"]).stderr(Stdio::null()).output().ok()?;
        String::from_utf8_lossy(&output.stdout).lines().find_map(|line| line.strip_prefix('n').map(PathBuf::from))
    }
}

/// Every live process whose parent is `parent`, with its argv.
pub(crate) fn children_of(parent: u32) -> Vec<(u32, Vec<String>)> {
    #[cfg(target_os = "linux")]
    {
        let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
        entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_string_lossy().parse::<u32>().ok())
            .filter(|pid| ppid(*pid) == Some(parent) && alive(*pid))
            .map(|pid| (pid, argv(pid)))
            .collect()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let Ok(output) = Command::new("/bin/ps").args(["-ww", "-axo", "pid=,ppid=,stat=,args="]).stderr(Stdio::null()).output() else { return Vec::new() };
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let pid: u32 = fields.next()?.parse().ok()?;
                let row_parent: u32 = fields.next()?.parse().ok()?;
                let stat = fields.next()?;
                (row_parent == parent && !stat.starts_with('Z')).then(|| (pid, fields.map(str::to_string).collect()))
            })
            .collect()
    }
}
