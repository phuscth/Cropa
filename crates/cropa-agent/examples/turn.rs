//! Runs one real turn for the eval harness, which spawns this binary once per turn.
//! It spends quota, so tests never run it.
//!
//! stdin: one JSON line `{ "provider": "codex"|"claude", "system", "prompt", "schema",
//! "timeoutMs", "effort"? }`. The harness then keeps stdin open; closing it cancels the turn.
//! stdout: one JSON line, `{ "json": ... }` or `{ "error": "<AgentError kind>" }`.
//!
//! `cargo build -p cropa-agent --example turn`

use std::io::{self, BufRead, Read};
use std::time::Duration;

use cropa_agent::{AgentCli, AgentError, CancelToken, ClaudeCode, CodexExec, Effort, RunRequest};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnRequest {
    provider: String,
    system: String,
    prompt: String,
    schema: Option<serde_json::Value>,
    timeout_ms: u64,
    /// "low" (the default), "medium" or "high".
    effort: Option<String>,
}

fn error_kind(error: &AgentError) -> &'static str {
    match error {
        AgentError::NotInstalled => "NotInstalled",
        AgentError::NotLoggedIn => "NotLoggedIn",
        AgentError::UsageLimit => "UsageLimit",
        AgentError::Unsupported => "Unsupported",
        AgentError::Timeout => "Timeout",
        AgentError::Protocol(_) => "Protocol",
        AgentError::Cancelled => "Cancelled",
    }
}

fn print(value: &serde_json::Value) {
    println!("{value}");
}

fn main() {
    let stdin = io::stdin();
    let mut line = String::new();
    if stdin.lock().read_line(&mut line).unwrap_or(0) == 0 {
        print(&json!({ "error": "Protocol" }));
        return;
    }
    let Ok(request) = serde_json::from_str::<TurnRequest>(&line) else {
        print(&json!({ "error": "Protocol" }));
        return;
    };

    let agent: Box<dyn AgentCli> = match request.provider.as_str() {
        "codex" => Box::new(CodexExec::new()),
        "claude" => Box::new(ClaudeCode::new()),
        _ => {
            print(&json!({ "error": "Unsupported" }));
            return;
        }
    };

    // The harness closes stdin to cancel the turn.
    let cancel = CancelToken::new();
    std::thread::spawn({
        let cancel = cancel.clone();
        move || {
            let mut sink = Vec::new();
            let _ = io::stdin().lock().read_to_end(&mut sink);
            cancel.cancel();
        }
    });

    let effort = match request.effort.as_deref() {
        None | Some("low") => Effort::Low,
        Some("medium") => Effort::Medium,
        Some("high") => Effort::High,
        Some(_) => {
            print(&json!({ "error": "Unsupported" }));
            return;
        }
    };
    let run = RunRequest {
        system: request.system,
        prompt: request.prompt,
        schema: request.schema,
        images: Vec::new(),
        want_image: false,
        model: None,
        effort,
        timeout: Duration::from_millis(request.timeout_ms),
    };
    match agent.run(run, &cancel, &mut |_| {}) {
        Ok(output) => print(&json!({ "json": output.json })),
        Err(error) => print(&json!({ "error": error_kind(&error) })),
    }
}
