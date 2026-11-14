//! The Claude Code adapter: `claude -p` with a stream-json conversation on
//! stdin and stdout, every tool, skill, plugin and setting source switched off.
//!
//! Logs hold the provider and the outcome kind, never a prompt or output.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::Provider;
use crate::adapter::{
    ISOLATION_NOTE, LIST_TIMEOUT, Probe, Version, adapter_env, check_model, classify, detect,
    missing_final, read_png, sanitize_models, scratch_dir,
};
use crate::cancel::CancelToken;
use crate::cli::{
    AgentCli, AgentError, Detection, Effort, Event, ModelInfo, RunOutput, RunRequest,
};
use crate::path_search::find_executable;
use crate::runner::{Finished, LineFlow, ProcessError, ProcessSpec, run_process};

/// Set to false to switch the adapter off, for example when the provider
/// changes its policy on driving the CLI from other programs. The app then
/// reports Claude Code as unavailable and refuses runs.
pub const ENABLED: bool = true;

/// The version the locked-down flags were verified on.
pub const MIN_VERSION: Version = (2, 1, 323);

/// The one variable that locates the CLI's own login.
const LOGIN_ENV: &str = "CLAUDE_CONFIG_DIR";

const PROBE: Probe = Probe {
    name: "claude",
    min_version: MIN_VERSION,
    login_env: LOGIN_ENV,
    login_args: &["auth", "status"],
    parse_login,
};

/// Only `loggedIn` is read; the email, organisation and the rest of the
/// status are ignored by serde and never stored.
#[derive(Deserialize)]
struct AuthStatus {
    #[serde(rename = "loggedIn")]
    logged_in: bool,
}

/// `claude auth status` prints JSON and exits 1 when logged out; either way
/// the JSON says which.
fn parse_login(_code: Option<i32>, stdout: &str, _stderr: &str) -> Option<bool> {
    serde_json::from_str::<AuthStatus>(stdout)
        .ok()
        .map(|status| status.logged_in)
}

#[derive(Debug, Clone, Default)]
pub struct ClaudeCode {
    executable: Option<PathBuf>,
}

impl ClaudeCode {
    /// Finds `claude` on `PATH` for every call.
    pub fn new() -> Self {
        Self::default()
    }

    /// Uses this absolute path instead of searching `PATH`.
    pub fn with_executable(path: PathBuf) -> Self {
        Self {
            executable: Some(path),
        }
    }

    fn find(&self) -> Option<PathBuf> {
        self.executable
            .clone()
            .or_else(|| find_executable(Provider::ClaudeCode.executable()))
    }
}

/// The arguments of one turn. Values that come from the request use the
/// `--opt=value` form so they can never be read as a flag.
fn build_args(
    system_file: &Path,
    schema: Option<&Value>,
    model: Option<&str>,
    effort: Effort,
) -> Result<Vec<OsString>, AgentError> {
    let mut args: Vec<OsString> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--thinking-display=summarized",
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--safe-mode",
        "--effort",
        // From the enum, so it is one of three fixed words.
        effort.as_arg(),
        "--system-prompt-file",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    args.push(system_file.into());
    if let Some(schema) = schema {
        args.push(format!("--json-schema={}", schema_arg(schema)?).into());
    }
    if let Some(model) = model {
        args.push(format!("--model={model}").into());
    }
    Ok(args)
}

/// The `request_id` of the model-list request, echoed in its response.
const MODELS_REQUEST_ID: &str = "cropa-models";

/// The arguments of the model-list call: the same lock-down as a turn, with no
/// prompt, schema or system file.
fn list_args() -> Vec<OsString> {
    [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--setting-sources",
        "",
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--safe-mode",
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

/// The one stdin line that asks the CLI to describe itself.
fn list_request() -> Vec<u8> {
    let mut line = json!({
        "type": "control_request",
        "request_id": MODELS_REQUEST_ID,
        "request": { "subtype": "initialize" },
    })
    .to_string();
    line.push('\n');
    line.into_bytes()
}

/// Only the fields of a model entry that Cropa uses; the rest of the response
/// (the account among it) is never read.
#[derive(Deserialize)]
struct ModelEntry {
    value: String,
    #[serde(default, rename = "resolvedModel")]
    resolved_model: String,
    #[serde(default, rename = "displayName")]
    display_name: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
struct InitializeResponse {
    models: Vec<ModelEntry>,
}

/// The CLI's own `default` entry is an alias: it is skipped, and the first real
/// model it resolves to is marked as the default.
fn models_from(response: InitializeResponse) -> Vec<ModelInfo> {
    let default_target = response
        .models
        .iter()
        .find(|entry| entry.value == "default")
        .map(|entry| entry.resolved_model.clone())
        .filter(|target| !target.is_empty());
    let mut default_marked = false;
    response
        .models
        .into_iter()
        .filter(|entry| entry.value != "default")
        .map(|entry| {
            let is_default = !default_marked
                && default_target
                    .as_deref()
                    .is_some_and(|target| target == entry.resolved_model);
            default_marked |= is_default;
            ModelInfo {
                id: entry.value,
                display_name: entry.display_name,
                description: entry.description,
                is_default,
                is_new: false,
            }
        })
        .collect()
}

/// Reads one stdout line of the model-list call. The answer is the
/// `control_response` carrying this call's request id.
fn read_models_line(
    line: &Value,
    answer: &mut Option<Result<Vec<ModelInfo>, AgentError>>,
) -> LineFlow {
    if line["type"] != "control_response" || line["response"]["request_id"] != MODELS_REQUEST_ID {
        return LineFlow::Continue;
    }
    *answer = Some(if line["response"]["subtype"] == "success" {
        serde_json::from_value::<InitializeResponse>(line["response"]["response"].clone())
            .map(models_from)
            .map_err(|_| AgentError::Protocol("the model list was not understood".to_owned()))
    } else {
        Err(AgentError::Protocol(
            "the CLI refused the model list".to_owned(),
        ))
    });
    LineFlow::Stop
}

/// The model list, or why there is none when the process ended first.
fn models_result(
    answer: Option<Result<Vec<ModelInfo>, AgentError>>,
    process: Result<Finished, ProcessError>,
) -> Result<Vec<ModelInfo>, AgentError> {
    match answer {
        Some(result) => result,
        None => Err(missing_final(
            process,
            &[],
            "the CLI ended without a model list",
        )),
    }
}

/// Windows refuses a command line over 32,767 characters, so the schema, which
/// travels as an argument, may not be larger than this.
const MAX_SCHEMA_ARG_BYTES: usize = 24 * 1024;

/// The schema as the `--json-schema` value. The root `$schema` goes: Claude
/// Code refuses a draft it cannot resolve locally, and the generators of
/// schemas name one (zod names draft 2020-12).
fn schema_arg(schema: &Value) -> Result<String, AgentError> {
    let Value::Object(map) = schema else {
        return Err(AgentError::Protocol(
            "the schema is not an object".to_owned(),
        ));
    };
    let mut map = map.clone();
    map.remove("$schema");
    let text = Value::Object(map).to_string();
    if text.len() > MAX_SCHEMA_ARG_BYTES {
        return Err(AgentError::Protocol("the schema is too large".to_owned()));
    }
    Ok(text)
}

/// The single stream-json user message that carries the images and the prompt.
fn user_message(prompt: &str, images: &[Vec<u8>]) -> Vec<u8> {
    let engine = base64::engine::general_purpose::STANDARD;
    let mut content: Vec<Value> = images
        .iter()
        .map(|bytes| {
            json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": engine.encode(bytes),
                },
            })
        })
        .collect();
    content.push(json!({ "type": "text", "text": prompt }));
    let mut line = json!({
        "type": "user",
        "message": { "role": "user", "content": content },
    })
    .to_string();
    line.push('\n');
    line.into_bytes()
}

/// The content blocks whose deltas become events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockKind {
    Thinking,
    Text,
    Output,
}

impl BlockKind {
    fn of(block_type: &str) -> Option<Self> {
        match block_type {
            "thinking" => Some(Self::Thinking),
            "text" => Some(Self::Text),
            // The structured answer is the input of the `StructuredOutput` tool call.
            "tool_use" => Some(Self::Output),
            _ => None,
        }
    }

    fn of_delta(delta_type: &str) -> Option<Self> {
        match delta_type {
            "thinking_delta" => Some(Self::Thinking),
            "text_delta" => Some(Self::Text),
            "input_json_delta" => Some(Self::Output),
            _ => None,
        }
    }

    /// The prose kinds are joined with a blank line when a second block starts.
    const fn separated(self) -> Option<usize> {
        match self {
            Self::Thinking => Some(0),
            Self::Text => Some(1),
            Self::Output => None,
        }
    }
}

/// Reads the stream-json lines of one turn.
#[derive(Debug, Default)]
struct ClaudeStream {
    started: bool,
    /// The kind of each open content block, by its index.
    blocks: std::collections::HashMap<u64, BlockKind>,
    /// Whether thinking and reply text were already sent, so a second block of the same kind
    /// starts after a separator.
    sent: [bool; 2],
    owes_separator: [bool; 2],
    rate_limited: bool,
    result: Option<Value>,
    /// One short label per line, for the diagnostic line of a failed turn.
    #[cfg(feature = "diagnostics")]
    events: Vec<String>,
    /// A whitelisted summary of the `result` line.
    #[cfg(feature = "diagnostics")]
    summary: Option<Value>,
}

/// The most event labels kept.
#[cfg(feature = "diagnostics")]
const MAX_EVENT_LABELS: usize = 64;

/// `type`, or `type/subtype`; for a message the block types follow in brackets, and a
/// tool call carries the tool's name.
#[cfg(feature = "diagnostics")]
fn event_label(line: &Value) -> String {
    let mut label = line["type"].as_str().unwrap_or("?").to_owned();
    if let Some(subtype) = line["subtype"].as_str() {
        label.push('/');
        label.push_str(subtype);
    }
    if let Some(blocks) = line["message"]["content"].as_array() {
        let names: Vec<String> = blocks
            .iter()
            .map(|block| {
                let kind = block["type"].as_str().unwrap_or("?");
                match block["name"].as_str() {
                    Some(name) if kind == "tool_use" => format!("{kind}:{name}"),
                    _ => kind.to_owned(),
                }
            })
            .collect();
        label.push('[');
        label.push_str(&names.join(","));
        label.push(']');
    }
    label
}

/// The fields of the `result` line that say why a turn ended as it did. The session id,
/// usage and cost are left out.
#[cfg(feature = "diagnostics")]
fn result_summary(line: &Value) -> Value {
    let mut keys: Vec<&str> = line
        .as_object()
        .map(|map| map.keys().map(String::as_str).collect())
        .unwrap_or_default();
    keys.sort_unstable();
    json!({
        "subtype": line["subtype"],
        "is_error": line["is_error"],
        "stop_reason": line["stop_reason"],
        "num_turns": line["num_turns"],
        "duration_ms": line["duration_ms"],
        "result": line["result"].as_str().map(|text| crate::diag::head(text, 2000)),
        "structured_output_bytes": match &line["structured_output"] {
            Value::Null => Value::Null,
            value => json!(value.to_string().len()),
        },
        "permission_denials": line["permission_denials"].as_array().map(Vec::len),
        "errors": match &line["errors"] {
            Value::Null => Value::Null,
            value => json!(crate::diag::head(&value.to_string(), 2000)),
        },
        "keys": keys,
    })
}

impl ClaudeStream {
    #[cfg(feature = "diagnostics")]
    fn note(&mut self, line: &Value) {
        // A partial-message line arrives per delta: only a block start is worth a label.
        let skipped =
            line["type"] == "stream_event" && line["event"]["type"] != "content_block_start";
        if !skipped && self.events.len() < MAX_EVENT_LABELS {
            self.events.push(event_label(line));
        }
        if line["type"] == "result" {
            self.summary = Some(result_summary(line));
        }
    }

    fn push(&mut self, line: &Value, on_event: &mut dyn FnMut(Event)) -> LineFlow {
        if !self.started {
            self.started = true;
            on_event(Event::Started);
        }
        #[cfg(feature = "diagnostics")]
        self.note(line);
        match line["type"].as_str() {
            Some("rate_limit_event") => {
                if line["rate_limit_info"]["status"] == "rejected" {
                    self.rate_limited = true;
                }
            }
            Some("result") => {
                self.result = Some(line.clone());
                return LineFlow::Stop;
            }
            Some("stream_event") => self.stream_event(&line["event"], on_event),
            _ => {}
        }
        LineFlow::Continue
    }

    /// Turns the partial-message events into thinking, reply and answer deltas. The full
    /// `assistant` messages repeat the same text, so they produce no events.
    fn stream_event(&mut self, event: &Value, on_event: &mut dyn FnMut(Event)) {
        let Some(index) = event["index"].as_u64() else {
            return;
        };
        match event["type"].as_str() {
            Some("content_block_start") => {
                let kind = event["content_block"]["type"]
                    .as_str()
                    .and_then(BlockKind::of);
                match kind {
                    Some(kind) => {
                        if let Some(slot) = kind.separated()
                            && self.sent[slot]
                        {
                            self.owes_separator[slot] = true;
                        }
                        self.blocks.insert(index, kind);
                    }
                    None => {
                        self.blocks.remove(&index);
                    }
                }
            }
            Some("content_block_delta") => {
                let Some(&kind) = self.blocks.get(&index) else {
                    return;
                };
                let delta = &event["delta"];
                if delta["type"].as_str().and_then(BlockKind::of_delta) != Some(kind) {
                    return;
                }
                let text = match kind {
                    BlockKind::Thinking => &delta["thinking"],
                    BlockKind::Text => &delta["text"],
                    BlockKind::Output => &delta["partial_json"],
                };
                let Some(text) = text.as_str().filter(|text| !text.is_empty()) else {
                    return;
                };
                if let Some(slot) = kind.separated() {
                    if self.owes_separator[slot] {
                        self.owes_separator[slot] = false;
                        on_event(Self::event(kind, "\n\n"));
                    }
                    self.sent[slot] = true;
                }
                on_event(Self::event(kind, text));
            }
            _ => {}
        }
    }

    fn event(kind: BlockKind, text: &str) -> Event {
        let text = text.to_owned();
        match kind {
            BlockKind::Thinking => Event::Thinking { text },
            BlockKind::Text => Event::Delta { text },
            BlockKind::Output => Event::OutputDelta { text },
        }
    }

    fn finish(
        self,
        process: Result<Finished, ProcessError>,
        wants_schema: bool,
    ) -> Result<RunOutput, AgentError> {
        let Some(result) = self.result else {
            return Err(missing_final(
                process,
                &[],
                "the CLI ended without a result",
            ));
        };
        let text = result["result"].as_str().unwrap_or_default();
        if result["is_error"] == false && result["subtype"] == "success" {
            let json = if wants_schema {
                match &result["structured_output"] {
                    Value::Null => {
                        return Err(AgentError::Protocol("no structured output".to_owned()));
                    }
                    value => value.clone(),
                }
            } else {
                Value::String(text.to_owned())
            };
            return Ok(RunOutput {
                json: Some(json),
                image: None,
            });
        }
        if result["subtype"] == "error_max_structured_output_retries" {
            return Err(AgentError::Protocol(
                "the reply did not match the schema".to_owned(),
            ));
        }
        let classified = classify(text);
        if self.rate_limited || classified == Some(AgentError::UsageLimit) {
            return Err(AgentError::UsageLimit);
        }
        Err(classified
            .unwrap_or_else(|| AgentError::Protocol("the CLI reported an error".to_owned())))
    }
}

impl AgentCli for ClaudeCode {
    fn detect(&self) -> Detection {
        detect(self.find(), &PROBE)
    }

    fn list_models(&self, cancel: &CancelToken) -> Result<Vec<ModelInfo>, AgentError> {
        let executable = self.find().ok_or(AgentError::NotInstalled)?;
        let dir = scratch_dir()?;
        let spec = ProcessSpec {
            program: executable,
            args: list_args(),
            env: adapter_env(&[LOGIN_ENV]),
            stdin: Some(list_request()),
            keep_stdin_open: false,
            timeout: LIST_TIMEOUT,
        };
        let started = Instant::now();
        let mut answer = None;
        let process = run_process(&spec, dir.path(), cancel, &mut |line| {
            read_models_line(&line, &mut answer)
        });
        let result = models_result(answer, process).map(sanitize_models);
        log::debug!(
            "claude models: {} after {} ms",
            result.as_ref().map_or_else(
                |e| format!("{e:?}"),
                |models| format!("{} models", models.len())
            ),
            started.elapsed().as_millis()
        );
        result
    }

    fn run(
        &self,
        req: RunRequest,
        cancel: &CancelToken,
        on_event: &mut dyn FnMut(Event),
    ) -> Result<RunOutput, AgentError> {
        if req.want_image {
            return Err(AgentError::Unsupported);
        }
        check_model(req.model.as_deref())?;
        let executable = self.find().ok_or(AgentError::NotInstalled)?;
        let images = req
            .images
            .iter()
            .map(|path| read_png(path))
            .collect::<Result<Vec<_>, _>>()?;

        let dir = scratch_dir()?;
        let system_file = dir.path().join("system.txt");
        std::fs::write(&system_file, format!("{}\n\n{ISOLATION_NOTE}", req.system))
            .map_err(|_| AgentError::Protocol("could not write the system prompt".to_owned()))?;

        let spec = ProcessSpec {
            program: executable,
            args: build_args(
                &system_file,
                req.schema.as_ref(),
                req.model.as_deref(),
                req.effort,
            )?,
            env: adapter_env(&[LOGIN_ENV]),
            stdin: Some(user_message(&req.prompt, &images)),
            keep_stdin_open: false,
            timeout: req.timeout,
        };
        let mut stream = ClaudeStream::default();
        let process = run_process(&spec, dir.path(), cancel, &mut |line| {
            stream.push(&line, &mut *on_event)
        });
        #[cfg(feature = "diagnostics")]
        let (events, summary, stderr_tail) = (
            stream.events.clone(),
            stream.summary.clone(),
            crate::diag::stderr_of(&process),
        );
        let result = stream.finish(process, req.schema.is_some());
        #[cfg(feature = "diagnostics")]
        if let Err(error) = &result {
            crate::diag::report("claude", error, &events, summary.as_ref(), &stderr_tail);
        }
        log::debug!(
            "claude turn: {}",
            result
                .as_ref()
                .map_or_else(|e| format!("{e:?}"), |_| "ok".to_owned())
        );
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCHEMA_OK: &str = include_str!("../tests/fixtures/claude/stream-schema-ok.jsonl");
    const IMAGE_OK: &str = include_str!("../tests/fixtures/claude/stream-image-ok.jsonl");
    const CANCELLED: &str = include_str!("../tests/fixtures/claude/stream-cancelled.jsonl");
    const PARTIAL_THINKING: &str =
        include_str!("../tests/fixtures/claude/stream-partial-thinking.jsonl");
    const PARTIAL_TEXT: &str = include_str!("../tests/fixtures/claude/stream-partial-text.jsonl");
    const SCHEMA_INVALID: &str =
        include_str!("../tests/fixtures/claude/json-schema-invalid.stderr.txt");
    const AUTH_IN: &str = include_str!("../tests/fixtures/claude/auth-status-logged-in.json");
    const AUTH_OUT: &str = include_str!("../tests/fixtures/claude/auth-status-logged-out.json");

    /// Feeds lines like the runner does: in order, up to the first `Stop`.
    fn feed(lines: &str) -> (ClaudeStream, Vec<Event>, usize) {
        let mut stream = ClaudeStream::default();
        let mut events = Vec::new();
        let mut fed = 0;
        for line in lines.lines().filter(|l| !l.trim().is_empty()) {
            fed += 1;
            let value: Value = serde_json::from_str(line).expect("fixture line is JSON");
            if stream.push(&value, &mut |e| events.push(e)) == LineFlow::Stop {
                break;
            }
        }
        (stream, events, fed)
    }

    fn exit(stderr: &str) -> Result<Finished, ProcessError> {
        Err(ProcessError::Exit {
            code: Some(1),
            stderr_tail: stderr.to_owned(),
        })
    }

    #[test]
    fn a_schema_turn_returns_the_structured_output() {
        let (stream, events, fed) = feed(SCHEMA_OK);
        assert_eq!(events, [Event::Started]);
        assert_eq!(fed, SCHEMA_OK.lines().count());
        let out = stream.finish(Ok(Finished::default()), true).unwrap();
        assert_eq!(out.json.unwrap()["layers"][0]["kind"], "linear");
    }

    /// The text of every event one picker selects, in order.
    fn joined(events: &[Event], pick: fn(&Event) -> Option<&str>) -> String {
        events.iter().filter_map(pick).collect()
    }

    fn thinking_of(event: &Event) -> Option<&str> {
        match event {
            Event::Thinking { text } => Some(text),
            _ => None,
        }
    }

    fn reply_of(event: &Event) -> Option<&str> {
        match event {
            Event::Delta { text } => Some(text),
            _ => None,
        }
    }

    fn output_of(event: &Event) -> Option<&str> {
        match event {
            Event::OutputDelta { text } => Some(text),
            _ => None,
        }
    }

    /// The strings of one delta field in the fixture, concatenated.
    fn fixture_deltas(lines: &str, delta_type: &str, field: &str) -> String {
        lines
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|line| line["event"]["delta"]["type"] == delta_type)
            .filter_map(|line| line["event"]["delta"][field].as_str().map(str::to_owned))
            .collect()
    }

    #[test]
    fn a_partial_thinking_turn_streams_the_summary_and_the_answer() {
        let (stream, events, _) = feed(PARTIAL_THINKING);
        assert_eq!(events[0], Event::Started);
        let thinking = joined(&events, thinking_of);
        assert!(thinking.starts_with("I'm settling on the background palette"));
        assert_eq!(
            thinking,
            fixture_deltas(PARTIAL_THINKING, "thinking_delta", "thinking")
        );
        assert_eq!(joined(&events, reply_of), "");

        let streamed: Value = serde_json::from_str(&joined(&events, output_of)).unwrap();
        let out = stream.finish(Ok(Finished::default()), true).unwrap();
        assert_eq!(out.json, Some(streamed));
    }

    #[test]
    fn a_partial_text_turn_streams_the_prose_without_thinking() {
        let (_, events, _) = feed(PARTIAL_TEXT);
        assert_eq!(joined(&events, thinking_of), "");
        let prose = joined(&events, reply_of);
        assert!(prose.starts_with("Colors: deep navy"));
        assert_eq!(prose, fixture_deltas(PARTIAL_TEXT, "text_delta", "text"));
        assert!(serde_json::from_str::<Value>(&joined(&events, output_of)).is_ok());
    }

    #[test]
    fn a_second_block_of_the_same_kind_starts_after_a_blank_line() {
        let lines = [
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"one"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"thinking"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"two"}}}"#,
        ]
        .join("\n");
        let (_, events, _) = feed(&lines);
        assert_eq!(joined(&events, thinking_of), "one\n\ntwo");
    }

    #[test]
    fn a_turn_without_a_schema_returns_the_text() {
        let (stream, _, _) = feed(IMAGE_OK);
        let out = stream.finish(Ok(Finished::default()), false).unwrap();
        assert_eq!(out.json, Some(json!("left=red right=blue")));
    }

    #[test]
    fn a_schema_turn_without_structured_output_is_a_protocol_error() {
        let (stream, _, _) = feed(IMAGE_OK);
        assert_eq!(
            stream.finish(Ok(Finished::default()), true).unwrap_err(),
            AgentError::Protocol("no structured output".to_owned())
        );
    }

    #[test]
    fn a_cut_stream_is_cancelled_or_a_protocol_error() {
        let (stream, _, fed) = feed(CANCELLED);
        assert_eq!(fed, CANCELLED.lines().count());
        assert_eq!(
            stream
                .finish(Err(ProcessError::Cancelled), false)
                .unwrap_err(),
            AgentError::Cancelled
        );
        let (stream, _, _) = feed(CANCELLED);
        assert_eq!(
            stream.finish(Ok(Finished::default()), false).unwrap_err(),
            AgentError::Protocol("the CLI ended without a result".to_owned())
        );
        let (stream, _, _) = feed(CANCELLED);
        assert_eq!(
            stream
                .finish(Err(ProcessError::Timeout), false)
                .unwrap_err(),
            AgentError::Timeout
        );
    }

    #[test]
    fn a_refused_schema_is_reported_from_stderr() {
        let stream = ClaudeStream::default();
        assert_eq!(
            stream.finish(exit(SCHEMA_INVALID), true).unwrap_err(),
            AgentError::Protocol("the CLI refused the schema".to_owned())
        );
    }

    #[cfg(feature = "diagnostics")]
    #[test]
    fn the_diagnostic_keeps_event_labels_and_a_result_summary_without_the_session() {
        let (stream, _, _) = feed(SCHEMA_OK);
        assert!(stream.events.contains(&"system/init".to_owned()));
        assert!(stream.events.contains(&"result/success".to_owned()));
        assert_eq!(stream.events.last().unwrap(), "result/success");

        // Partial-message lines do not fill the label list.
        let (stream, _, _) = feed(PARTIAL_THINKING);
        let blocks = stream
            .events
            .iter()
            .filter(|l| *l == "stream_event")
            .count();
        assert_eq!(blocks, 2);
        assert_eq!(stream.events.last().unwrap(), "result/success");

        let (stream, _, _) = feed(IMAGE_OK);
        let summary = stream.summary.unwrap();
        assert!(summary["structured_output_bytes"].is_null());
        assert_eq!(summary["subtype"], "success");
        assert!(summary.get("session_id").is_none());
        assert!(!summary.to_string().contains("00000000-0000"));
    }

    const MODELS: &str = include_str!("../tests/fixtures/claude/initialize-models.jsonl");

    /// Feeds lines like the runner does and returns the model list.
    fn list_from(
        lines: &str,
        process: Result<Finished, ProcessError>,
    ) -> Result<Vec<ModelInfo>, AgentError> {
        let mut answer = None;
        for line in lines.lines().filter(|l| !l.trim().is_empty()) {
            let value: Value = serde_json::from_str(line).expect("line is JSON");
            if read_models_line(&value, &mut answer) == LineFlow::Stop {
                break;
            }
        }
        models_result(answer, process).map(crate::adapter::sanitize_models)
    }

    #[test]
    fn the_model_list_keeps_the_real_models_and_marks_the_clis_default() {
        let models = list_from(MODELS, Ok(Finished::default())).unwrap();
        assert_eq!(models.len(), 13);
        assert_eq!(models[0].id, "opus");
        assert_eq!(models[0].display_name, "Opus 5.5");
        assert!(models[0].is_default);
        assert_eq!(models.iter().filter(|m| m.is_default).count(), 1);
        assert!(models.iter().all(|m| m.id != "default" && !m.is_new));
        for id in ["fable", "sonnet", "haiku", "claude-opus-4-8"] {
            assert!(models.iter().any(|m| m.id == id), "{id}");
        }
    }

    #[test]
    fn a_refused_model_list_is_a_protocol_error() {
        let line = r#"{"type":"control_response","response":{"subtype":"error","request_id":"cropa-models","error":"no"}}"#;
        assert_eq!(
            list_from(line, Ok(Finished::default())).unwrap_err(),
            AgentError::Protocol("the CLI refused the model list".to_owned())
        );
    }

    #[test]
    fn a_response_for_another_request_is_not_the_answer() {
        let line = r#"{"type":"control_response","response":{"subtype":"success","request_id":"other","response":{"models":[]}}}"#;
        assert_eq!(
            list_from(line, Ok(Finished::default())).unwrap_err(),
            AgentError::Protocol("the CLI ended without a model list".to_owned())
        );
    }

    #[test]
    fn a_model_list_that_never_comes_keeps_the_login_cause() {
        let lines = r#"{"type":"system","subtype":"init"}"#;
        assert_eq!(
            list_from(lines, exit("Not logged in. Please run /login")).unwrap_err(),
            AgentError::NotLoggedIn
        );
        assert_eq!(
            list_from(lines, Ok(Finished::default())).unwrap_err(),
            AgentError::Protocol("the CLI ended without a model list".to_owned())
        );
    }

    #[test]
    fn the_model_list_call_is_fixed_and_carries_no_prompt() {
        let args = list_args();
        assert_eq!(args[0], OsString::from("-p"));
        assert!(
            args.iter()
                .all(|a| !a.to_string_lossy().starts_with("--model"))
        );
        assert!(!args.iter().any(|a| a == "--system-prompt-file"));
        let request: Value = serde_json::from_slice(&list_request()).unwrap();
        assert_eq!(request["type"], "control_request");
        assert_eq!(request["request"]["subtype"], "initialize");
        assert_eq!(request["request_id"], MODELS_REQUEST_ID);
    }

    #[test]
    fn auth_status_reads_only_the_login_flag() {
        assert_eq!(parse_login(Some(0), AUTH_IN, ""), Some(true));
        assert_eq!(parse_login(Some(1), AUTH_OUT, ""), Some(false));
        assert_eq!(parse_login(Some(0), "not json", ""), None);
        assert_eq!(parse_login(Some(0), "{}", ""), None);
    }

    // The next two are inferred: the strings come from the CLI's code, not
    // from a recorded run.
    #[test]
    fn inferred_a_rejected_rate_limit_with_an_error_result_is_a_usage_limit() {
        let lines = [
            r#"{"type":"system","subtype":"init"}"#,
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}"#,
            r#"{"type":"result","subtype":"success","is_error":true,"result":"limit"}"#,
        ]
        .join("\n");
        let (stream, _, _) = feed(&lines);
        assert_eq!(
            stream.finish(Ok(Finished::default()), false).unwrap_err(),
            AgentError::UsageLimit
        );
    }

    #[test]
    fn inferred_too_many_structured_output_retries_is_a_protocol_error() {
        let line =
            r#"{"type":"result","subtype":"error_max_structured_output_retries","is_error":true}"#;
        let (stream, _, _) = feed(line);
        assert_eq!(
            stream.finish(Ok(Finished::default()), true).unwrap_err(),
            AgentError::Protocol("the reply did not match the schema".to_owned())
        );
    }

    #[test]
    fn the_arguments_are_fixed_and_request_values_never_stand_alone() {
        let schema = json!({"type": "object"});
        let args = build_args(
            Path::new("/t/system.txt"),
            Some(&schema),
            Some("opus"),
            Effort::Low,
        )
        .unwrap();
        let expected: Vec<OsString> = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--thinking-display=summarized",
            "--tools",
            "",
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--setting-sources",
            "",
            "--no-session-persistence",
            "--safe-mode",
            "--effort",
            "low",
            "--system-prompt-file",
            "/t/system.txt",
            r#"--json-schema={"type":"object"}"#,
            "--model=opus",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        assert_eq!(args, expected);
        assert_eq!(
            build_args(Path::new("/t/system.txt"), None, None, Effort::Low)
                .unwrap()
                .len(),
            20
        );
    }

    #[test]
    fn the_root_dollar_schema_is_not_passed_to_the_cli() {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {"a": {"type": "string"}},
            "required": ["a"]
        });
        let args = build_args(Path::new("/t/s.txt"), Some(&schema), None, Effort::Low).unwrap();
        let arg = args.last().unwrap().to_str().unwrap();
        let value: Value =
            serde_json::from_str(arg.strip_prefix("--json-schema=").unwrap()).unwrap();
        assert!(value.get("$schema").is_none());
        assert_eq!(value["required"], json!(["a"]));
    }

    #[test]
    fn a_schema_over_the_command_line_cap_is_refused() {
        // `{"a":"<n x>"}` is 8 + n bytes.
        let schema = |len: usize| json!({"a": "x".repeat(len - 8)});
        assert!(schema_arg(&schema(MAX_SCHEMA_ARG_BYTES)).is_ok());
        assert_eq!(
            schema_arg(&schema(MAX_SCHEMA_ARG_BYTES + 1)),
            Err(AgentError::Protocol("the schema is too large".to_owned()))
        );
        assert_eq!(
            schema_arg(&json!([1])),
            Err(AgentError::Protocol(
                "the schema is not an object".to_owned()
            ))
        );
    }

    #[test]
    fn the_prompt_travels_on_stdin_with_the_images_first() {
        let message = user_message("--not a flag", &[vec![1, 2, 3]]);
        assert!(message.ends_with(b"\n"));
        let value: Value = serde_json::from_slice(&message).unwrap();
        let content = &value["message"]["content"];
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["source"]["data"], "AQID");
        assert_eq!(content[1]["text"], "--not a flag");
    }

    #[test]
    fn each_effort_becomes_its_own_fixed_level() {
        for (effort, word) in [
            (Effort::Low, "low"),
            (Effort::Medium, "medium"),
            (Effort::High, "high"),
        ] {
            let args = build_args(Path::new("/t/system.txt"), None, None, effort).unwrap();
            let at = args.iter().position(|a| a == "--effort").unwrap();
            assert_eq!(args[at + 1], OsString::from(word));
            assert_eq!(args.iter().filter(|a| *a == "--effort").count(), 1);
        }
    }

    #[test]
    fn a_flag_like_model_is_refused_before_anything_starts() {
        let adapter = ClaudeCode::with_executable(PathBuf::from("/does/not/matter"));
        let req = RunRequest {
            system: "--system".to_owned(),
            prompt: "--prompt".to_owned(),
            schema: None,
            images: Vec::new(),
            want_image: false,
            model: Some("--dangerously-skip-permissions".to_owned()),
            effort: Effort::default(),
            timeout: std::time::Duration::from_secs(5),
        };
        assert_eq!(
            adapter
                .run(req, &CancelToken::new(), &mut |_| {})
                .unwrap_err(),
            AgentError::Protocol("invalid model name".to_owned())
        );
    }
}
