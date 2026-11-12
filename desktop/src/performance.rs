//! The desktop processes' CPU and memory for the Performance panel. The
//! server reports its own children; this covers the shell, the server and
//! the webview processes the shell started.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::State;

use crate::Shell;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetric {
    pid: u32,
    name: String,
    #[serde(rename = "type")]
    kind: &'static str,
    cpu_percent: f32,
    memory_mb: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    captured_at: u128,
    processes: Vec<ProcessMetric>,
}

/// CPU usage is measured between refreshes, so the system view lives as long as the app.
#[derive(Default)]
pub struct Sampler(Mutex<System>);

/// Async so the system-wide process refresh runs off the main thread.
#[tauri::command(async)]
pub fn performance_snapshot(shell: State<'_, Shell>, sampler: State<'_, Sampler>) -> Snapshot {
    let app = sysinfo::get_current_pid().ok();
    let server = shell.server_pid().map(Pid::from_u32);
    let mut system = sampler.0.lock().unwrap();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );

    let processes = system
        .processes()
        .values()
        .filter_map(|process| {
            let (name, kind) = if Some(process.pid()) == app {
                ("App", "Browser")
            } else if Some(process.pid()) == server {
                ("Server", "Utility")
            } else if process.parent().is_some() && process.parent() == app {
                // macOS runs WebKit's processes as XPC services, which are not the app's children.
                ("Renderer", "Tab")
            } else {
                return None;
            };
            Some(ProcessMetric {
                pid: process.pid().as_u32(),
                name: name.to_owned(),
                kind,
                cpu_percent: process.cpu_usage(),
                memory_mb: process.memory() as f64 / 1024.0 / 1024.0,
            })
        })
        .collect();
    Snapshot {
        captured_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis())
            .unwrap_or(0),
        processes,
    }
}
