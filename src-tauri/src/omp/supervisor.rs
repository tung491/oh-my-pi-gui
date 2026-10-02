//! The sidecar supervisor: `main.rs` re-executes the GUI binary with
//! `ports::SUPERVISOR_ARGV` and hands control here before Tauri starts. The
//! body (setsid, child subreaper, parent-death signal, control channel, the
//! SIGTERM → grace → SIGKILL → orphan sweep sequence) is the omp module's.

use std::ffi::OsString;
use std::process::ExitCode;

/// Run as the supervisor for the omp command line in `args[2..]`; never returns to Tauri.
pub fn run(args: Vec<OsString>) -> ExitCode {
    let _ = args;
    todo!()
}
