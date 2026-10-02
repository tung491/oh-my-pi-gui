//! What this machine has for running a local model: RAM always, GPU memory
//! best effort. Every GPU probe is raced against a timeout and never hangs
//! the caller past it.

use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::Command;

use super::catalog::MachineFacts;

pub const HARDWARE_PROBE_TIMEOUT_MS: u64 = 2_000;
const MIB: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Darwin,
    Win32,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Arch {
    X64,
    Arm64,
    Other,
}

pub struct NvidiaGpu {
    pub name: String,
    pub vram_bytes: u64,
}

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Everything `read_machine` needs from the OS, injectable for tests.
pub struct HardwareDeps {
    pub platform: Platform,
    pub arch: Arch,
    /// `None` when RAM cannot be read at all.
    pub totalmem: Arc<dyn Fn() -> Option<u64> + Send + Sync>,
    /// Hardware threads the model runtime can use; `None` when unreadable.
    pub available_parallelism: Arc<dyn Fn() -> Option<usize> + Send + Sync>,
    /// Raw `nvidia-smi` CSV, or `None` when it is missing or failed. Never hangs past `timeout`.
    pub nvidia_smi: Arc<dyn Fn(Duration) -> BoxFuture<Option<String>> + Send + Sync>,
    /// The GPU's display name, best effort; `Err` stands in for a probe that threw.
    pub gpu_name: Arc<dyn Fn() -> BoxFuture<Result<Option<String>, String>> + Send + Sync>,
    pub timeout: Duration,
}

fn run_nvidia_smi(timeout: Duration) -> BoxFuture<Option<String>> {
    Box::pin(async move {
        let output = tokio::time::timeout(
            timeout,
            Command::new("nvidia-smi")
                .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
                .stdin(Stdio::null())
                .output(),
        )
        .await;
        match output {
            Ok(Ok(out)) if out.status.success() => Some(String::from_utf8_lossy(&out.stdout).into_owned()),
            _ => None,
        }
    })
}

/// `lspci -mm` (VGA/3D class), falling back to the sysfs vendor/device ids
/// when `lspci` is unavailable. Electron's `app.getGPUInfo` has no Rust
/// equivalent (Phase 2 → Design); macOS and Windows gain a real probe in
/// Phase 12, logging once in the meantime.
fn read_gpu_name_linux() -> BoxFuture<Result<Option<String>, String>> {
    Box::pin(async move {
        let output = Command::new("lspci").arg("-mm").stdin(Stdio::null()).output().await;
        if let Ok(out) = output {
            if out.status.success() {
                return Ok(gpu_name_from_lspci(&String::from_utf8_lossy(&out.stdout)));
            }
        }
        Ok(gpu_name_from_sysfs())
    })
}

/// Vendor/device ids under `/sys/class/drm/card*/device`, for a machine with no `lspci`.
fn gpu_name_from_sysfs() -> Option<String> {
    let mut entries = std::fs::read_dir("/sys/class/drm").ok()?;
    entries.find_map(|entry| {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let name = name.to_str()?;
        if !name.starts_with("card") || name.contains('-') {
            return None;
        }
        let device_dir = entry.path().join("device");
        let vendor = std::fs::read_to_string(device_dir.join("vendor")).ok()?.trim().to_string();
        let device = std::fs::read_to_string(device_dir.join("device")).ok()?.trim().to_string();
        Some(format!("{vendor}:{device}"))
    })
}

fn gpu_name_other_os() -> BoxFuture<Result<Option<String>, String>> {
    Box::pin(async move {
        static LOGGED: std::sync::Once = std::sync::Once::new();
        LOGGED.call_once(|| {
            crate::runtime_log::note("unknown", "GPU name lookup is not implemented on this OS", serde_json::json!({}));
        });
        Ok(None)
    })
}

fn default_deps() -> HardwareDeps {
    let platform = match std::env::consts::OS {
        "linux" => Platform::Linux,
        "macos" => Platform::Darwin,
        "windows" => Platform::Win32,
        _ => Platform::Other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => Arch::X64,
        "aarch64" => Arch::Arm64,
        _ => Arch::Other,
    };
    let gpu_name: Arc<dyn Fn() -> BoxFuture<Result<Option<String>, String>> + Send + Sync> =
        if platform == Platform::Linux { Arc::new(read_gpu_name_linux) } else { Arc::new(gpu_name_other_os) };
    HardwareDeps {
        platform,
        arch,
        totalmem: Arc::new(|| {
            let bytes = sysinfo_totalmem();
            if bytes > 0 { Some(bytes) } else { None }
        }),
        available_parallelism: Arc::new(|| std::thread::available_parallelism().ok().map(usize::from)),
        nvidia_smi: Arc::new(run_nvidia_smi),
        gpu_name,
        timeout: Duration::from_millis(HARDWARE_PROBE_TIMEOUT_MS),
    }
}

/// Total physical RAM in bytes, `0` when it cannot be read.
fn sysinfo_totalmem() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(meminfo) = std::fs::read_to_string("/proc/meminfo") {
            for line in meminfo.lines() {
                if let Some(rest) = line.strip_prefix("MemTotal:") {
                    let kib: u64 = rest.trim().trim_end_matches(" kB").trim().parse().unwrap_or(0);
                    return kib.saturating_mul(1024);
                }
            }
        }
        0
    }
    #[cfg(not(target_os = "linux"))]
    {
        0
    }
}

/// `name, MiB` per line; picks the card with the most memory (the one a model is sized against).
pub fn parse_nvidia_smi(stdout: &str) -> Option<NvidiaGpu> {
    let mut best: Option<NvidiaGpu> = None;
    for line in stdout.lines() {
        let Some(comma) = line.rfind(',') else { continue };
        if comma == 0 {
            continue;
        }
        let name = line[..comma].trim();
        let Ok(mib) = line[comma + 1..].trim().parse::<f64>() else { continue };
        if name.is_empty() || !mib.is_finite() || mib <= 0.0 {
            continue;
        }
        let vram_bytes = (mib * MIB as f64).round() as u64;
        if best.as_ref().is_none_or(|b| vram_bytes > b.vram_bytes) {
            best = Some(NvidiaGpu { name: name.to_string(), vram_bytes });
        }
    }
    best
}

/// Split one `lspci -mm` line into its quoted fields, in order.
fn quoted_fields(line: &str) -> Vec<&str> {
    let mut fields = Vec::new();
    let mut rest = line;
    while let Some(start) = rest.find('"') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('"') else { break };
        fields.push(&after[..end]);
        rest = &after[end + 1..];
    }
    fields
}

/// GPU name from `lspci -mm`: prefers a discrete (`3D controller`) device over
/// a plain display adapter, the way a dedicated GPU would be the active
/// render device alongside integrated graphics.
pub fn gpu_name_from_lspci(output: &str) -> Option<String> {
    let mut discrete: Option<String> = None;
    let mut any: Option<String> = None;
    for line in output.lines() {
        let fields = quoted_fields(line);
        if fields.len() < 3 {
            continue;
        }
        let class = fields[0];
        let device = fields[2].trim();
        if device.is_empty() {
            continue;
        }
        if class.contains("3D") {
            discrete.get_or_insert_with(|| device.to_string());
        } else if class.contains("VGA") || class.contains("Display") {
            any.get_or_insert_with(|| device.to_string());
        }
    }
    discrete.or(any)
}

/// Resolve `task`, or `None` when it outlives `timeout`.
async fn settle_option<T>(task: BoxFuture<Option<T>>, timeout: Duration) -> Option<T> {
    tokio::time::timeout(timeout, task).await.unwrap_or_default()
}

/// Resolve `task`, or `None` when it rejects or outlives `timeout`.
async fn settle_result<T>(task: BoxFuture<Result<T, String>>, timeout: Duration) -> Option<T> {
    match tokio::time::timeout(timeout, task).await {
        Ok(Ok(value)) => Some(value),
        _ => None,
    }
}

/// Threads as a positive integer; an unreadable or nonsensical count means one.
fn read_threads(deps: &HardwareDeps) -> u32 {
    match (deps.available_parallelism)() {
        Some(threads) if threads >= 1 => threads as u32,
        _ => 1,
    }
}

/// Machine facts for model sizing, or `None` when RAM itself cannot be read. Never hangs.
pub async fn read_machine(deps: &HardwareDeps) -> Option<MachineFacts> {
    let ram_bytes = (deps.totalmem)()?;
    if ram_bytes == 0 {
        return None;
    }
    let threads = read_threads(deps);
    let unified_memory = deps.platform == Platform::Darwin && deps.arch == Arch::Arm64;
    if !unified_memory && matches!(deps.platform, Platform::Linux | Platform::Win32) {
        let csv = settle_option((deps.nvidia_smi)(deps.timeout), deps.timeout).await;
        if let Some(gpu) = csv.and_then(|csv| parse_nvidia_smi(&csv)) {
            return Some(MachineFacts { ram_bytes, vram_bytes: Some(gpu.vram_bytes), unified_memory: false, threads });
        }
    }
    let _ = settle_result((deps.gpu_name)(), deps.timeout).await;
    Some(MachineFacts { ram_bytes, vram_bytes: None, unified_memory, threads })
}

/// Machine facts using the real OS probes.
pub async fn read_machine_default() -> Option<MachineFacts> {
    read_machine(&default_deps()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    fn test_deps() -> HardwareDeps {
        HardwareDeps {
            platform: Platform::Linux,
            arch: Arch::X64,
            totalmem: Arc::new(|| Some(32 * GIB)),
            available_parallelism: Arc::new(|| Some(8)),
            nvidia_smi: Arc::new(|_| Box::pin(async { None })),
            gpu_name: Arc::new(|| Box::pin(async { Ok(None) })),
            timeout: Duration::from_millis(50),
        }
    }

    #[test]
    fn reads_name_and_mib_picking_the_largest_card() {
        let gpu = parse_nvidia_smi("NVIDIA GeForce RTX 3060, 12288\nNVIDIA RTX A6000, 49140\n").expect("a GPU is parsed");
        assert_eq!(gpu.name, "NVIDIA RTX A6000");
        assert_eq!(gpu.vram_bytes, 49140 * 1024 * 1024);
    }

    #[test]
    fn ignores_junk() {
        assert!(parse_nvidia_smi("").is_none());
        assert!(parse_nvidia_smi("NVIDIA-SMI has failed\n, 12\nGPU, [N/A]").is_none());
    }

    #[test]
    fn prefers_the_active_device_string() {
        let output = "00:02.0 \"VGA compatible controller\" \"Intel Corporation\" \"UHD Graphics\" -ra1 \"Dell\" \"1234\"\n\
01:00.0 \"3D controller\" \"NVIDIA Corporation\" \"GeForce GTX 1050 Mobile\" -ra1 \"Dell\" \"5678\"";
        assert_eq!(gpu_name_from_lspci(output).as_deref(), Some("GeForce GTX 1050 Mobile"));
    }

    #[test]
    fn falls_back_to_the_gl_renderer() {
        let output = "00:02.0 \"VGA compatible controller\" \"Intel Corporation\" \"UHD Graphics\" -ra1 \"Dell\" \"1234\"";
        assert_eq!(gpu_name_from_lspci(output).as_deref(), Some("UHD Graphics"));
    }

    #[test]
    fn returns_null_for_unexpected_shapes() {
        assert_eq!(gpu_name_from_lspci(""), None);
        assert_eq!(gpu_name_from_lspci("not lspci output at all"), None);
    }

    #[tokio::test]
    async fn uses_nvidia_smi_vram_on_linux() {
        let mut deps = test_deps();
        deps.nvidia_smi = Arc::new(|_| Box::pin(async { Some("NVIDIA GeForce RTX 4090, 24564\n".to_string()) }));
        let machine = read_machine(&deps).await.expect("machine facts");
        assert_eq!(machine.ram_bytes, 32 * GIB);
        assert_eq!(machine.vram_bytes, Some(24564 * 1024 * 1024));
        assert!(!machine.unified_memory);
        assert_eq!(machine.threads, 8);
    }

    #[tokio::test]
    async fn falls_back_to_the_gpu_name_without_vram_when_nvidia_smi_is_missing() {
        let mut deps = test_deps();
        deps.gpu_name = Arc::new(|| Box::pin(async { Ok(Some("Intel Iris".to_string())) }));
        let machine = read_machine(&deps).await.expect("machine facts");
        assert_eq!(machine.ram_bytes, 32 * GIB);
        assert_eq!(machine.vram_bytes, None);
        assert!(!machine.unified_memory);
        assert_eq!(machine.threads, 8);
    }

    #[tokio::test]
    async fn marks_apple_silicon_as_unified_memory_and_skips_nvidia_smi() {
        let asked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let asked2 = asked.clone();
        let mut deps = test_deps();
        deps.platform = Platform::Darwin;
        deps.arch = Arch::Arm64;
        deps.nvidia_smi = Arc::new(move |_| {
            asked2.store(true, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async { Some("X, 1".to_string()) })
        });
        let machine = read_machine(&deps).await.expect("machine facts");
        assert!(!asked.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(machine.vram_bytes, None);
        assert!(machine.unified_memory);
    }

    #[tokio::test]
    async fn survives_probes_that_hang_or_throw() {
        let mut deps = test_deps();
        deps.nvidia_smi = Arc::new(|_| Box::pin(std::future::pending()));
        deps.gpu_name = Arc::new(|| Box::pin(async { Err("gpu process crashed".to_string()) }));
        let started = std::time::Instant::now();
        let machine = read_machine(&deps).await.expect("machine facts");
        assert_eq!(machine.ram_bytes, 32 * GIB);
        assert_eq!(machine.vram_bytes, None);
        assert!(!machine.unified_memory);
        assert_eq!(machine.threads, 8);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn counts_at_least_one_thread_when_the_count_is_unreadable_or_nonsensical() {
        for available_parallelism in [Arc::new(|| None) as Arc<dyn Fn() -> Option<usize> + Send + Sync>, Arc::new(|| Some(0))] {
            let mut deps = test_deps();
            deps.available_parallelism = available_parallelism;
            assert_eq!(read_machine(&deps).await.expect("machine facts").threads, 1);
        }
        let mut deps = test_deps();
        deps.available_parallelism = Arc::new(|| Some(12));
        assert_eq!(read_machine(&deps).await.expect("machine facts").threads, 12);
    }

    #[tokio::test]
    async fn returns_null_when_ram_is_unreadable() {
        let mut deps = test_deps();
        deps.totalmem = Arc::new(|| None);
        assert!(read_machine(&deps).await.is_none());
        deps.totalmem = Arc::new(|| Some(0));
        assert!(read_machine(&deps).await.is_none());
    }
}
