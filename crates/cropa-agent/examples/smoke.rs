//! Runs one real turn through an adapter, for a manual check on a machine with
//! the CLI installed and logged in. It spends quota, so tests never run it.
//!
//! `cargo run -p cropa-agent --example smoke -- codex|claude [image.png]`

use std::path::PathBuf;
use std::time::{Duration, Instant};

use cropa_agent::{AgentCli, CancelToken, ClaudeCode, CodexExec, RunRequest};
use serde_json::json;

fn main() {
    let mut args = std::env::args().skip(1);
    let agent: Box<dyn AgentCli> = match args.next().as_deref() {
        Some("codex") => Box::new(CodexExec::new()),
        Some("claude") => Box::new(ClaudeCode::new()),
        _ => {
            eprintln!("usage: smoke codex|claude [image.png]");
            std::process::exit(2);
        }
    };
    let images: Vec<PathBuf> = args.next().map(PathBuf::from).into_iter().collect();

    let detection = agent.detect();
    println!(
        "version {:?}, supported {:?}, logged in {:?}",
        detection.version, detection.version_supported, detection.logged_in
    );

    let request = RunRequest {
        system: "You choose colours.".to_owned(),
        prompt: "Pick one colour.".to_owned(),
        schema: Some(json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "color": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"},
                "name": {"type": "string"}
            },
            "required": ["color"]
        })),
        images,
        want_image: false,
        model: None,
        timeout: Duration::from_secs(120),
    };
    let started = Instant::now();
    let result = agent.run(request, &CancelToken::new(), &mut |_| {});
    println!("elapsed {} ms", started.elapsed().as_millis());
    match result {
        Ok(output) => println!("{}", output.json.unwrap_or_default()),
        Err(error) => println!("error: {error:?}"),
    }
}
