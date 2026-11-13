//! A one-line diagnostic on stderr for a turn that failed, for the eval's `turn` example.
//!
//! The adapters otherwise never write CLI output anywhere. This module exists only behind
//! the `diagnostics` feature, which the app must never enable: the line carries event
//! labels, a whitelisted summary of the CLI's final message and the tail of its stderr.

use std::io::Write;

use serde_json::{Value, json};

use crate::cli::AgentError;
use crate::runner::{Finished, ProcessError};

/// How much of the CLI's stderr the line keeps.
const STDERR_TAIL_BYTES: usize = 4096;

/// The stderr tail of a finished process, whichever way it ended.
pub(crate) fn stderr_of(process: &Result<Finished, ProcessError>) -> String {
    match process {
        Ok(finished) => finished.stderr_tail.clone(),
        Err(ProcessError::Exit { stderr_tail, .. }) => stderr_tail.clone(),
        Err(_) => String::new(),
    }
}

/// The last `max` bytes of `text`, cut on a character boundary.
fn tail(text: &str, max: usize) -> &str {
    let mut start = text.len().saturating_sub(max);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// The first `max` characters of `text`.
pub(crate) fn head(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The diagnostic as one JSON value, before it is written.
fn line(
    provider: &str,
    error: &AgentError,
    events: &[String],
    result: Option<&Value>,
    stderr_tail: &str,
) -> Value {
    json!({
        "cropaDiagnostic": {
            "provider": provider,
            "error": format!("{error:?}"),
            "events": events,
            "result": result,
            "stderrTail": tail(stderr_tail, STDERR_TAIL_BYTES),
        }
    })
}

/// Writes the diagnostic of a failed turn as one JSON line on stderr.
pub(crate) fn report(
    provider: &str,
    error: &AgentError,
    events: &[String],
    result: Option<&Value>,
    stderr_tail: &str,
) {
    let value = line(provider, error, events, result, stderr_tail);
    let _ = writeln!(std::io::stderr().lock(), "{value}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_line_keeps_the_last_4_kb_of_stderr_on_a_character_boundary() {
        let text = format!("{}{}", "x".repeat(5000), "é".repeat(10));
        let value = line("claude", &AgentError::Timeout, &[], None, &text);
        let kept = value["cropaDiagnostic"]["stderrTail"].as_str().unwrap();
        assert!(kept.len() <= STDERR_TAIL_BYTES);
        assert!(kept.ends_with('é'));
        assert_eq!(value["cropaDiagnostic"]["error"], "Timeout");
        assert!(value["cropaDiagnostic"]["result"].is_null());
    }
}
