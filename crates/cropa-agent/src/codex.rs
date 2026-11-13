//! The Codex adapter: `codex exec --json` in a fresh scratch folder with the
//! sandbox read-only and every tool, plugin and user setting switched off. The
//! prompt goes on stdin.
//!
//! Logs hold the provider and the outcome kind, never a prompt or output.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::Provider;
use crate::adapter::{
    ISOLATION_NOTE, Probe, Version, adapter_env, check_model, classify, detect, missing_final,
    read_png, scratch_dir,
};
use crate::cancel::CancelToken;
use crate::cli::{AgentCli, AgentError, Detection, Event, RunOutput, RunRequest};
use crate::path_search::find_executable;
use crate::runner::{Finished, LineFlow, ProcessError, ProcessSpec, run_process};

/// Set to false to switch the adapter off, for example when the provider
/// changes its policy on driving the CLI from other programs. The app then
/// reports Codex as unavailable and refuses runs.
pub const ENABLED: bool = true;

/// The version the locked-down flags were verified on.
pub const MIN_VERSION: Version = (0, 167, 0);

/// The one variable that locates the CLI's own login.
const LOGIN_ENV: &str = "CODEX_HOME";

/// Features that still bring the user's plugins, apps, skills and agent tools
/// into a turn when only the sandbox flags are given.
const DISABLED_FEATURES: &[&str] = &[
    "apps",
    "plugins",
    "skill_search",
    "tool_suggest",
    "multi_agent",
    "goals",
    "hooks",
    "image_generation",
    "browser_use",
    "computer_use",
    "shell_tool",
    "unified_exec",
    "view_image",
    "sleep_tool",
];

const PROBE: Probe = Probe {
    name: "codex",
    min_version: MIN_VERSION,
    login_env: LOGIN_ENV,
    login_args: &["login", "status"],
    parse_login,
};

/// `codex login status` prints on stderr: exit 0 when logged in, exit 1 and
/// "Not logged in" when not. Anything else is unknown.
fn parse_login(code: Option<i32>, stdout: &str, stderr: &str) -> Option<bool> {
    match code {
        Some(0) => Some(true),
        Some(1) if stdout.contains("Not logged in") || stderr.contains("Not logged in") => {
            Some(false)
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Default)]
pub struct CodexExec {
    executable: Option<PathBuf>,
}

impl CodexExec {
    /// Finds `codex` on `PATH` for every call.
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
            .or_else(|| find_executable(Provider::Codex.executable()))
    }
}

/// The arguments of one turn. There is no positional prompt: `--image` takes
/// many values and would swallow it, so the prompt goes on stdin. Values from
/// the request use the `--opt=value` form so they can never be read as a flag.
fn build_args(
    schema_file: Option<&Path>,
    images: &[PathBuf],
    model: Option<&str>,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--ignore-user-config",
        "--ignore-rules",
        "-c",
        "model_reasoning_effort=\"low\"",
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        "web_search=\"disabled\"",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    for feature in DISABLED_FEATURES {
        args.push("--disable".into());
        args.push((*feature).into());
    }
    if let Some(path) = schema_file {
        let mut arg = OsString::from("--output-schema=");
        arg.push(path);
        args.push(arg);
    }
    for image in images {
        let mut arg = OsString::from("--image=");
        arg.push(image);
        args.push(arg);
    }
    if let Some(model) = model {
        args.push(format!("--model={model}").into());
    }
    args
}

/// The prompt: the isolation note, the system prompt and the user prompt.
fn stdin_text(system: &str, prompt: &str) -> Vec<u8> {
    [ISOLATION_NOTE, system, prompt]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
        .into_bytes()
}

// --- Strict schemas

/// True for a schema that describes an object.
fn is_object_schema(map: &Map<String, Value>) -> bool {
    map.contains_key("properties")
        || match map.get("type") {
            Some(Value::String(t)) => t == "object",
            Some(Value::Array(types)) => types.iter().any(|t| t == "object"),
            _ => false,
        }
}

/// Lets a property take null: `type` gains `"null"` and so does `enum`;
/// a schema without a plain `type` (`anyOf`, `$ref`) is wrapped.
fn make_nullable(schema: &mut Value) {
    if let Value::Object(map) = schema {
        match map.get_mut("type") {
            Some(Value::String(t)) => {
                if t != "null" {
                    let first = std::mem::take(t);
                    map.insert(
                        "type".to_owned(),
                        Value::Array(vec![first.into(), "null".into()]),
                    );
                }
            }
            Some(Value::Array(types)) => {
                if !types.iter().any(|t| t == "null") {
                    types.push("null".into());
                }
            }
            _ => {
                wrap_nullable(schema);
                return;
            }
        }
        if let Some(Value::Array(values)) = map.get_mut("enum")
            && !values.contains(&Value::Null)
        {
            values.push(Value::Null);
        }
    } else {
        wrap_nullable(schema);
    }
}

fn wrap_nullable(schema: &mut Value) {
    let original = std::mem::take(schema);
    *schema = serde_json::json!({ "anyOf": [original, { "type": "null" }] });
}

fn strictify(schema: &mut Value) {
    let Value::Object(map) = schema else { return };

    for key in ["anyOf", "oneOf", "allOf", "prefixItems"] {
        if let Some(Value::Array(items)) = map.get_mut(key) {
            items.iter_mut().for_each(strictify);
        }
    }
    match map.get_mut("items") {
        Some(Value::Array(items)) => items.iter_mut().for_each(strictify),
        Some(items) => strictify(items),
        None => {}
    }
    for key in ["$defs", "definitions"] {
        if let Some(Value::Object(defs)) = map.get_mut(key) {
            defs.values_mut().for_each(strictify);
        }
    }

    if !is_object_schema(map) {
        return;
    }
    if !matches!(map.get("properties"), Some(Value::Object(_))) {
        // An object with a schema for its extra keys is a map. Strict mode
        // cannot express a map, so it is left as it is and the API refuses it.
        let is_map = matches!(map.get("additionalProperties"), Some(Value::Object(_)));
        if !is_map {
            map.insert("additionalProperties".to_owned(), Value::Bool(false));
        }
        return;
    }
    let required: Vec<String> = match map.get("required") {
        Some(Value::Array(names)) => names
            .iter()
            .filter_map(|n| n.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    };
    let mut names = Vec::new();
    if let Some(Value::Object(properties)) = map.get_mut("properties") {
        for (name, property) in properties.iter_mut() {
            strictify(property);
            if !required.contains(name) {
                make_nullable(property);
            }
            names.push(Value::String(name.clone()));
        }
    }
    map.insert("required".to_owned(), Value::Array(names));
    map.insert("additionalProperties".to_owned(), Value::Bool(false));
}

/// Rewrites a JSON schema into the strict form the Responses API demands for
/// structured output: no root `$schema`, every object closed
/// (`additionalProperties: false`), every property required, and a property
/// that was optional made nullable. [`strip_added_nulls`] undoes the nulls
/// afterwards.
///
/// An object whose extra keys have a schema (a map) cannot be written in
/// strict mode; it is left unchanged and the API refuses it.
pub fn strict_schema(schema: &Value) -> Value {
    let mut out = schema.clone();
    if let Value::Object(map) = &mut out {
        map.remove("$schema");
    }
    strictify(&mut out);
    out
}

/// Looks up a local `#/$defs/<name>` or `#/definitions/<name>` reference.
fn resolve_ref<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    let (section, name) = if let Some(name) = reference.strip_prefix("#/$defs/") {
        ("$defs", name)
    } else {
        ("definitions", reference.strip_prefix("#/definitions/")?)
    };
    root.get(section)?.get(name)
}

/// The schemas a value must satisfy at this point: the schema itself with a
/// local `$ref` followed, plus the branches of `anyOf`, `oneOf` and `allOf`.
fn applicable<'a>(root: &'a Value, schema: &'a Value, depth: u8, out: &mut Vec<&'a Value>) {
    if depth > 8 {
        return;
    }
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        if let Some(target) = resolve_ref(root, reference) {
            applicable(root, target, depth + 1, out);
        }
        return;
    }
    out.push(schema);
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(Value::Array(branches)) = schema.get(key) {
            for branch in branches {
                applicable(root, branch, depth + 1, out);
            }
        }
    }
}

fn is_required(schema: &Value, key: &str) -> bool {
    schema
        .get("required")
        .and_then(Value::as_array)
        .is_some_and(|names| names.iter().any(|n| n.as_str() == Some(key)))
}

fn strip(root: &Value, schema: &Value, value: Value, depth: u8) -> Value {
    if depth > 32 {
        return value;
    }
    let mut schemas = Vec::new();
    applicable(root, schema, 0, &mut schemas);
    match value {
        Value::Object(map) => map
            .into_iter()
            .filter_map(|(key, value)| {
                let children: Vec<&Value> = schemas
                    .iter()
                    .filter_map(|s| s.get("properties")?.get(&key))
                    .collect();
                // Optional in any schema that knows the key: the null was added.
                let optional = schemas.iter().any(|s| {
                    s.get("properties").and_then(|p| p.get(&key)).is_some() && !is_required(s, &key)
                });
                if value.is_null() && optional {
                    return None;
                }
                let value = children
                    .into_iter()
                    .fold(value, |v, child| strip(root, child, v, depth + 1));
                Some((key, value))
            })
            .collect::<Map<_, _>>()
            .into(),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .enumerate()
                .map(|(index, item)| {
                    let mut item = item;
                    for s in &schemas {
                        let child = match (s.get("prefixItems"), s.get("items")) {
                            (Some(Value::Array(prefix)), _) if index < prefix.len() => {
                                prefix.get(index)
                            }
                            (_, Some(Value::Array(tuple))) => tuple.get(index),
                            (_, Some(single @ Value::Object(_))) => Some(single),
                            _ => None,
                        };
                        if let Some(child) = child {
                            item = strip(root, child, item, depth + 1);
                        }
                    }
                    item
                })
                .collect(),
        ),
        other => other,
    }
}

/// Removes the nulls [`strict_schema`] allowed: a null value under a key that
/// the original schema did not require, so the reply validates against the
/// original again. It follows the places `strict_schema` changed: `properties`,
/// `items` and `prefixItems` (by index), the branches of `anyOf`, `oneOf` and
/// `allOf`, and local `$defs` and `definitions` references. In a union a key
/// that is optional in any branch declaring it loses its null.
pub fn strip_added_nulls(original: &Value, output: Value) -> Value {
    strip(original, original, output, 0)
}

// --- The event stream

#[derive(Debug)]
enum Final {
    Completed,
    Failed(String),
}

/// Reads the JSON lines of one turn.
#[derive(Debug, Default)]
struct CodexStream {
    started: bool,
    last_text: Option<String>,
    /// Messages of `error` events. Codex sends its retry notices as `error`,
    /// so they do not end the turn; they only help classify a later failure.
    errors: Vec<String>,
    end: Option<Final>,
}

impl CodexStream {
    fn push(&mut self, line: &Value, on_event: &mut dyn FnMut(Event)) -> LineFlow {
        if !self.started {
            self.started = true;
            on_event(Event::Started);
        }
        match line["type"].as_str() {
            Some("item.completed") if line["item"]["type"] == "agent_message" => {
                if let Some(text) = line["item"]["text"].as_str() {
                    self.last_text = Some(text.to_owned());
                }
            }
            Some("error") => {
                if let Some(message) = line["message"].as_str() {
                    self.errors.push(message.to_owned());
                }
            }
            Some("turn.completed") => {
                self.end = Some(Final::Completed);
                return LineFlow::Stop;
            }
            Some("turn.failed") => {
                let message = line["error"]["message"].as_str().unwrap_or_default();
                self.end = Some(Final::Failed(message.to_owned()));
                return LineFlow::Stop;
            }
            _ => {}
        }
        LineFlow::Continue
    }

    fn finish(
        self,
        process: Result<Finished, ProcessError>,
        schema: Option<&Value>,
    ) -> Result<RunOutput, AgentError> {
        let earlier: Vec<&str> = self.errors.iter().map(String::as_str).collect();
        match self.end {
            Some(Final::Completed) => {
                let text = self
                    .last_text
                    .ok_or_else(|| AgentError::Protocol("no reply".to_owned()))?;
                let json = match schema {
                    Some(schema) => {
                        let value: Value = serde_json::from_str(&text).map_err(|_| {
                            AgentError::Protocol("the reply was not JSON".to_owned())
                        })?;
                        strip_added_nulls(schema, value)
                    }
                    None => Value::String(text),
                };
                Ok(RunOutput {
                    json: Some(json),
                    image: None,
                })
            }
            Some(Final::Failed(message)) => Err(classify(&message)
                .or_else(|| earlier.iter().find_map(|text| classify(text)))
                .unwrap_or_else(|| AgentError::Protocol("the turn failed".to_owned()))),
            None => Err(missing_final(
                process,
                &earlier,
                "the CLI ended without a final event",
            )),
        }
    }
}

impl AgentCli for CodexExec {
    fn detect(&self) -> Detection {
        detect(self.find(), &PROBE)
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
        let write_error = |_| AgentError::Protocol("could not write a file for the CLI".to_owned());
        let schema_file = match &req.schema {
            Some(schema) => {
                let path = dir.path().join("output-schema.json");
                std::fs::write(&path, strict_schema(schema).to_string()).map_err(write_error)?;
                Some(path)
            }
            None => None,
        };
        let mut image_files = Vec::new();
        for (index, bytes) in images.iter().enumerate() {
            let path = dir.path().join(format!("input-{index}.png"));
            std::fs::write(&path, bytes).map_err(write_error)?;
            image_files.push(path);
        }

        let spec = ProcessSpec {
            program: executable,
            args: build_args(schema_file.as_deref(), &image_files, req.model.as_deref()),
            env: adapter_env(&[LOGIN_ENV]),
            stdin: Some(stdin_text(&req.system, &req.prompt)),
            timeout: req.timeout,
        };
        let mut stream = CodexStream::default();
        let process = run_process(&spec, dir.path(), cancel, &mut |line| {
            stream.push(&line, &mut *on_event)
        });
        let result = stream.finish(process, req.schema.as_ref());
        log::debug!(
            "codex turn: {}",
            result
                .as_ref()
                .map_or_else(|e| format!("{e:?}"), |_| "ok".to_owned())
        );
        result
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SCHEMA_OK: &str = include_str!("../tests/fixtures/codex/exec-schema-ok.jsonl");
    const IMAGE_OK: &str = include_str!("../tests/fixtures/codex/exec-image-ok.jsonl");
    const REJECTED: &str = include_str!("../tests/fixtures/codex/exec-schema-rejected.jsonl");
    const CANCELLED: &str = include_str!("../tests/fixtures/codex/exec-cancelled.jsonl");
    const LOGIN_IN: &str =
        include_str!("../tests/fixtures/codex/login-status-logged-in.stderr.txt");
    const LOGIN_OUT: &str =
        include_str!("../tests/fixtures/codex/login-status-logged-out.stderr.txt");

    /// Feeds lines like the runner does: in order, up to the first `Stop`.
    fn feed(lines: &str) -> (CodexStream, Vec<Event>, usize) {
        let mut stream = CodexStream::default();
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

    #[allow(clippy::unnecessary_wraps)]
    fn ok() -> Result<Finished, ProcessError> {
        Ok(Finished::default())
    }

    #[test]
    fn a_schema_turn_returns_the_last_agent_message_as_json() {
        let schema = json!({"type": "object", "properties": {"layers": {"type": "array"}}, "required": ["layers"]});
        let (stream, events, fed) = feed(SCHEMA_OK);
        assert_eq!(events, [Event::Started]);
        assert_eq!(fed, SCHEMA_OK.lines().count());
        let out = stream.finish(ok(), Some(&schema)).unwrap();
        assert_eq!(out.json.unwrap()["layers"][1]["kind"], "radial");
    }

    #[test]
    fn a_turn_without_a_schema_returns_the_text() {
        let (stream, _, _) = feed(IMAGE_OK);
        let out = stream.finish(ok(), None).unwrap();
        assert_eq!(out.json, Some(json!("left=red right=blue")));
    }

    #[test]
    fn a_reply_that_is_not_json_is_a_protocol_error() {
        let (stream, _, _) = feed(IMAGE_OK);
        assert_eq!(
            stream
                .finish(ok(), Some(&json!({"type": "object"})))
                .unwrap_err(),
            AgentError::Protocol("the reply was not JSON".to_owned())
        );
    }

    #[test]
    fn a_refused_schema_ends_the_stream_at_turn_failed() {
        let (stream, _, fed) = feed(REJECTED);
        // The `error` line before it is not final: the stream ran on to the
        // last line, `turn.failed`.
        assert_eq!(fed, REJECTED.lines().count());
        assert_eq!(
            stream.finish(ok(), Some(&json!({}))).unwrap_err(),
            AgentError::Protocol("the CLI refused the schema".to_owned())
        );
    }

    #[test]
    fn a_cut_stream_is_cancelled_timed_out_or_a_protocol_error() {
        let finish = |process| {
            let (stream, _, fed) = feed(CANCELLED);
            assert_eq!(fed, CANCELLED.lines().count());
            stream.finish(process, None).unwrap_err()
        };
        assert_eq!(finish(Err(ProcessError::Cancelled)), AgentError::Cancelled);
        assert_eq!(finish(Err(ProcessError::Timeout)), AgentError::Timeout);
        assert_eq!(
            finish(ok()),
            AgentError::Protocol("the CLI ended without a final event".to_owned())
        );
    }

    #[test]
    fn login_status_reads_the_exit_code_and_stderr() {
        assert_eq!(parse_login(Some(0), "", LOGIN_IN), Some(true));
        assert_eq!(parse_login(Some(1), "", LOGIN_OUT), Some(false));
        assert_eq!(parse_login(Some(1), "", "something else"), None);
        assert_eq!(parse_login(None, "", LOGIN_OUT), None);
    }

    // The next two are inferred: the strings come from the CLI's code, not
    // from a recorded run.
    #[test]
    fn inferred_a_usage_limit_turn_failure_is_a_usage_limit() {
        let lines = [
            r#"{"type":"turn.started"}"#,
            r#"{"type":"turn.failed","error":{"message":"{\"error\":{\"code\":\"usage_limit_reached\"}}"}}"#,
        ]
        .join("\n");
        let (stream, _, _) = feed(&lines);
        assert_eq!(
            stream.finish(ok(), None).unwrap_err(),
            AgentError::UsageLimit
        );
    }

    #[test]
    fn inferred_an_error_event_then_a_clean_exit_keeps_its_cause() {
        let lines = [
            r#"{"type":"turn.started"}"#,
            r#"{"type":"error","message":"usage_limit_reached"}"#,
        ]
        .join("\n");
        let (stream, _, _) = feed(&lines);
        assert_eq!(
            stream.finish(ok(), None).unwrap_err(),
            AgentError::UsageLimit
        );
    }

    #[test]
    fn inferred_a_retry_notice_does_not_end_the_turn() {
        let lines = [
            r#"{"type":"turn.started"}"#,
            r#"{"type":"error","message":"Reconnecting... 1/5"}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"done"}}"#,
            r#"{"type":"turn.completed"}"#,
        ]
        .join("\n");
        let (stream, _, fed) = feed(&lines);
        assert_eq!(fed, 4);
        assert_eq!(stream.finish(ok(), None).unwrap().json, Some(json!("done")));
    }

    #[test]
    fn the_arguments_are_fixed_and_the_prompt_is_not_among_them() {
        let args = build_args(
            Some(Path::new("/t/output-schema.json")),
            &[PathBuf::from("/t/input-0.png")],
            Some("gpt-5"),
        );
        let mut expected: Vec<String> = [
            "exec",
            "--json",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--ignore-user-config",
            "--ignore-rules",
            "-c",
            "model_reasoning_effort=\"low\"",
            "-c",
            "project_doc_max_bytes=0",
            "-c",
            "web_search=\"disabled\"",
        ]
        .map(str::to_owned)
        .to_vec();
        for feature in DISABLED_FEATURES {
            expected.push("--disable".to_owned());
            expected.push((*feature).to_owned());
        }
        expected.extend(
            [
                "--output-schema=/t/output-schema.json",
                "--image=/t/input-0.png",
                "--model=gpt-5",
            ]
            .map(str::to_owned),
        );
        let expected: Vec<OsString> = expected.into_iter().map(OsString::from).collect();
        assert_eq!(args, expected);
    }

    #[test]
    fn the_prompt_goes_on_stdin_after_the_isolation_note() {
        let text = String::from_utf8(stdin_text("--system", "--prompt")).unwrap();
        assert_eq!(text, format!("{ISOLATION_NOTE}\n\n--system\n\n--prompt"));
        let text = String::from_utf8(stdin_text("", "p")).unwrap();
        assert_eq!(text, format!("{ISOLATION_NOTE}\n\np"));
    }

    #[test]
    fn a_flag_like_model_is_refused_before_anything_starts() {
        let adapter = CodexExec::with_executable(PathBuf::from("/does/not/matter"));
        let req = RunRequest {
            system: "--system".to_owned(),
            prompt: "--prompt".to_owned(),
            schema: None,
            images: Vec::new(),
            want_image: false,
            model: Some("--config".to_owned()),
            timeout: std::time::Duration::from_secs(5),
        };
        assert_eq!(
            adapter
                .run(req, &CancelToken::new(), &mut |_| {})
                .unwrap_err(),
            AgentError::Protocol("invalid model name".to_owned())
        );
    }

    fn sorted_required(schema: &Value) -> Vec<String> {
        let mut names: Vec<String> = schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_str().unwrap().to_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn strict_schema_requires_every_property_and_makes_optional_ones_nullable() {
        let schema = json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "color": {"type": "string", "pattern": "^#"},
                "name": {"type": "string"},
                "kind": {"type": "string", "enum": ["a", "b"]},
                "tags": {"type": ["array"], "items": {"type": "object", "properties": {"id": {"type": "number"}}, "required": ["id"]}},
                "any": {"anyOf": [{"type": "string"}, {"type": "number"}]},
                "nested": {"type": "object", "properties": {"x": {"type": "number"}}}
            },
            "required": ["color"]
        });
        let strict = strict_schema(&schema);
        assert!(strict.get("$schema").is_none());
        assert_eq!(strict["additionalProperties"], false);
        assert_eq!(
            sorted_required(&strict),
            ["any", "color", "kind", "name", "nested", "tags"]
        );
        let p = &strict["properties"];
        assert_eq!(p["color"], json!({"type": "string", "pattern": "^#"}));
        assert_eq!(p["name"]["type"], json!(["string", "null"]));
        assert_eq!(p["kind"]["type"], json!(["string", "null"]));
        assert_eq!(p["kind"]["enum"], json!(["a", "b", null]));
        assert_eq!(p["tags"]["type"], json!(["array", "null"]));
        assert_eq!(p["tags"]["items"]["additionalProperties"], false);
        assert_eq!(
            p["any"],
            json!({"anyOf": [{"anyOf": [{"type": "string"}, {"type": "number"}]}, {"type": "null"}]})
        );
        // A nested object is closed and nullable.
        assert_eq!(p["nested"]["type"], json!(["object", "null"]));
        assert_eq!(p["nested"]["additionalProperties"], false);
        assert_eq!(p["nested"]["required"], json!(["x"]));
    }

    #[test]
    fn strict_schema_leaves_a_strict_schema_alone() {
        let schema = json!({
            "type": "object",
            "properties": {"a": {"type": "string"}, "b": {"type": "array", "items": {"type": "number"}}},
            "required": ["a", "b"],
            "additionalProperties": false
        });
        assert_eq!(strict_schema(&schema), schema);
    }

    #[test]
    fn strict_schema_leaves_a_map_for_the_api_to_refuse() {
        let schema = json!({"type": "object", "additionalProperties": {"type": "string"}});
        assert_eq!(strict_schema(&schema), schema);
    }

    #[test]
    fn strict_schema_reaches_into_defs_and_combinators() {
        let schema = json!({
            "$defs": {"d": {"type": "object", "properties": {"a": {"type": "string"}}}},
            "anyOf": [{"type": "object", "properties": {"b": {"type": "string"}}, "required": ["b"]}]
        });
        let strict = strict_schema(&schema);
        assert_eq!(strict["$defs"]["d"]["additionalProperties"], false);
        assert_eq!(strict["anyOf"][0]["additionalProperties"], false);
    }

    #[test]
    fn nulls_are_removed_in_unions_refs_and_tuples() {
        let original = json!({
            "type": "object",
            "properties": {
                "u": {"anyOf": [
                    {"type": "object", "properties": {"a": {"type": "string"}, "k": {"const": "x"}}, "required": ["k"]},
                    {"type": "object", "properties": {"b": {"type": "string"}}}
                ]},
                "r": {"$ref": "#/$defs/item"},
                "t": {"type": "array", "prefixItems": [{"type": "object", "properties": {"p": {"type": "string"}}}, {"type": "string"}]}
            },
            "required": ["u", "r", "t"],
            "$defs": {"item": {"type": "object", "properties": {"q": {"type": "number"}}}}
        });
        let output = json!({
            "u": {"k": "x", "a": null, "b": null},
            "r": {"q": null},
            "t": [{"p": null}, "s"]
        });
        assert_eq!(
            strip_added_nulls(&original, output),
            json!({"u": {"k": "x"}, "r": {}, "t": [{}, "s"]})
        );
    }

    #[test]
    fn added_nulls_are_removed_but_required_nulls_stay() {
        let original = json!({
            "type": "object",
            "properties": {
                "a": {"type": ["string", "null"]},
                "b": {"type": "string"},
                "n": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}}, "required": ["x"]},
                "list": {"type": "array", "items": {"type": "object", "properties": {"k": {"type": "string"}}}}
            },
            "required": ["a"]
        });
        let output = json!({
            "a": null,
            "b": null,
            "n": {"x": null, "y": null},
            "list": [{"k": null}, {"k": "v"}],
            "unknown": null
        });
        assert_eq!(
            strip_added_nulls(&original, output),
            json!({"a": null, "n": {"x": null}, "list": [{}, {"k": "v"}], "unknown": null})
        );
    }
}
