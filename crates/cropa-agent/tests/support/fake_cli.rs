//! A test-only helper binary: it behaves like a CLI that prints JSON lines so
//! the runner tests can exercise real processes. It is never shipped.
//!
//! Modes (first argument):
//! - `lines <n> <interval_ms>`: prints `{"seq":i}` for i in 0..n.
//! - `sleep <ms>`: prints nothing and sleeps.
//! - `grandchild`: starts a sleeping copy of itself, prints
//!   `{"pid":<own>,"grandchild":<other>}`, then sleeps.
//! - `exit <code>`: exits with the code.
//! - `cwd`: prints `{"cwd":"<current directory>"}`.
//! - `env`: prints `{"names":[<environment variable names>]}`.
//! - `stdin`: reads stdin to EOF and prints `{"len":<bytes>}`.
//! - `not-json`: prints a line that is not JSON.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

fn say(value: &serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn arg(args: &[String], index: usize) -> u64 {
    args.get(index).and_then(|a| a.parse().ok()).unwrap_or(0)
}

fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("lines") => {
            for seq in 0..arg(&args, 1) {
                say(&serde_json::json!({ "seq": seq }));
                sleep_ms(arg(&args, 2));
            }
        }
        Some("sleep") => sleep_ms(arg(&args, 1)),
        Some("grandchild") => {
            let exe = std::env::current_exe().expect("own path");
            let mut child = Command::new(exe)
                .args(["sleep", "600000"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("grandchild");
            say(&serde_json::json!({ "pid": std::process::id(), "grandchild": child.id() }));
            sleep_ms(600_000);
            let _ = child.wait();
        }
        Some("exit") => {
            eprintln!("fake cli failure");
            std::process::exit(i32::try_from(arg(&args, 1)).unwrap_or(1));
        }
        Some("cwd") => {
            let cwd = std::env::current_dir().expect("cwd");
            say(&serde_json::json!({ "cwd": cwd.to_string_lossy() }));
        }
        Some("env") => {
            let names: Vec<String> = std::env::vars_os()
                .map(|(name, _)| name.to_string_lossy().into_owned())
                .collect();
            say(&serde_json::json!({ "names": names }));
        }
        Some("stdin") => {
            let mut data = Vec::new();
            std::io::stdin().read_to_end(&mut data).expect("stdin");
            say(&serde_json::json!({ "len": data.len() }));
        }
        Some("not-json") => say_raw("this is not json"),
        _ => std::process::exit(2),
    }
}

fn say_raw(text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{text}");
    let _ = out.flush();
}
