//! The Codex adapter: `codex exec --json` in a fresh scratch folder with the
//! sandbox read-only and every tool, plugin and user setting switched off. The
//! prompt goes on stdin.
//!
//! An image turn leaves the image tool on. The stream never names the file the
//! tool writes, so after `turn.completed` the adapter reads the one PNG in
//! `<Codex home>/generated_images/<thread id>/`, where the thread id is the one
//! of this turn. Nothing else under the Codex home is read, and nothing there
//! is ever deleted.
//!
//! Logs hold the provider and the outcome kind, never a prompt, an output or
//! the path or bytes of an image.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

use serde::Deserialize;
use serde_json::{Map, Value, json};

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
    image_out: true,
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
/// `image_generation` leaves the image tool on; every other feature stays off.
fn build_args(
    schema_file: Option<&Path>,
    images: &[PathBuf],
    model: Option<&str>,
    effort: Effort,
    image_generation: bool,
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
        "project_doc_max_bytes=0",
        "-c",
        "web_search=\"disabled\"",
        "-c",
        "model_reasoning_summary=\"auto\"",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    // From the enum, so it is one of three fixed words.
    args.push("-c".into());
    args.push(format!("model_reasoning_effort=\"{}\"", effort.as_arg()).into());
    for feature in DISABLED_FEATURES {
        if image_generation && *feature == "image_generation" {
            continue;
        }
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

// --- The generated image

/// The largest PNG file read from the Codex home.
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
/// The side limits and the area limit of that PNG.
const IMAGE_SIDE: std::ops::RangeInclusive<u32> = 64..=8192;
const MAX_IMAGE_PIXELS: u64 = 16_000_000;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// A thread id is 1 to 64 characters of `[0-9A-Za-z-]`, so it can only ever
/// name one folder.
fn valid_thread_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The Codex home from the values of `CODEX_HOME` and the user's home folder:
/// `CODEX_HOME` when it is set and absolute, else `.codex` in the home folder.
fn codex_home_from(codex_home: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    codex_home
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            let home = PathBuf::from(home?);
            home.is_absolute().then(|| home.join(".codex"))
        })
}

/// The Codex home of this process: `USERPROFILE` is the home folder on
/// Windows, `HOME` elsewhere.
fn codex_home() -> Option<PathBuf> {
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    codex_home_from(std::env::var_os(LOGIN_ENV), std::env::var_os(home_var))
}

fn not_a_png() -> AgentError {
    AgentError::Protocol("the CLI's image is not a usable PNG".to_owned())
}

/// Checks the signature and the `IHDR` size of a PNG without decoding it.
fn check_png(bytes: &[u8]) -> Result<(), AgentError> {
    if bytes.len() < 24 || !bytes.starts_with(PNG_SIGNATURE) || &bytes[12..16] != b"IHDR" {
        return Err(not_a_png());
    }
    let side =
        |at: usize| u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    let (width, height) = (side(16), side(20));
    if !IMAGE_SIDE.contains(&width)
        || !IMAGE_SIDE.contains(&height)
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return Err(not_a_png());
    }
    Ok(())
}

/// Reads the PNG a turn generated: the most recently modified regular `.png`
/// file in `<codex_home>/generated_images/<thread_id>/`. Only that one folder
/// is listed, a symbolic link is never followed, and the file is left where it
/// is. No folder or no PNG in it is [`AgentError::NoImage`].
fn read_generated_image(codex_home: &Path, thread_id: &str) -> Result<Vec<u8>, AgentError> {
    if !valid_thread_id(thread_id) {
        return Err(AgentError::Protocol("unexpected thread id".to_owned()));
    }
    let dir = codex_home.join("generated_images").join(thread_id);
    let is_real_dir = std::fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir());
    if !is_real_dir {
        return Err(AgentError::NoImage);
    }
    let entries = std::fs::read_dir(&dir).map_err(|_| AgentError::NoImage)?;
    let mut newest: Option<(SystemTime, PathBuf, u64)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_png = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("png"));
        // `DirEntry::metadata` does not follow a symbolic link, so a link is not a file.
        let Ok(meta) = entry.metadata() else { continue };
        if !is_png || !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if newest.as_ref().is_none_or(|(best, _, _)| modified > *best) {
            newest = Some((modified, path, meta.len()));
        }
    }
    let (_, path, len) = newest.ok_or(AgentError::NoImage)?;
    if len > MAX_IMAGE_BYTES {
        return Err(not_a_png());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .and_then(|file| file.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| AgentError::Protocol("could not read the CLI's image".to_owned()))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(not_a_png());
    }
    check_png(&bytes)?;
    Ok(bytes)
}

// --- The event stream

#[derive(Debug)]
enum Final {
    Completed,
    Failed(String),
}

/// The thread of a turn, from `thread.started`.
#[derive(Debug, Default)]
enum Thread {
    #[default]
    Unknown,
    Id(String),
    /// The id is not safe to put in a path.
    Refused,
}

/// Reads the JSON lines of one turn.
#[allow(clippy::struct_excessive_bools)] // independent facts about one turn, not a state
#[derive(Debug, Default)]
struct CodexStream {
    /// Whether the turn asked for a schema: the final message is then the structured
    /// answer, not prose.
    wants_schema: bool,
    /// Whether the turn's answer is an image found by its thread id. Only then does an
    /// id of an unexpected shape end the turn; a text turn never uses the id.
    image_turn: bool,
    started: bool,
    thread: Thread,
    /// Whether a reasoning summary was already sent, so the next one follows a blank line.
    thinking_sent: bool,
    last_text: Option<String>,
    /// Messages of `error` events. Codex sends its retry notices as `error`,
    /// so they do not end the turn; they only help classify a later failure.
    errors: Vec<String>,
    end: Option<Final>,
    /// One short label per line, for the diagnostic line of a failed turn.
    #[cfg(feature = "diagnostics")]
    events: Vec<String>,
}

/// The most event labels kept.
#[cfg(feature = "diagnostics")]
const MAX_EVENT_LABELS: usize = 64;

/// `type`, and for an `item.*` line the item's type after a slash.
#[cfg(feature = "diagnostics")]
fn event_label(line: &Value) -> String {
    let mut label = line["type"].as_str().unwrap_or("?").to_owned();
    if label.starts_with("item.")
        && let Some(item) = line["item"]["type"].as_str()
    {
        label.push('/');
        label.push_str(item);
    }
    label
}

impl CodexStream {
    fn new(wants_schema: bool, image_turn: bool) -> Self {
        Self {
            wants_schema,
            image_turn,
            ..Self::default()
        }
    }

    /// The turn's failure and `error` event messages, cut short.
    #[cfg(feature = "diagnostics")]
    fn failure_summary(&self) -> Value {
        let failed = match &self.end {
            Some(Final::Failed(message)) => Some(crate::diag::head(message, 2000)),
            _ => None,
        };
        let errors: Vec<String> = self
            .errors
            .iter()
            .take(16)
            .map(|message| crate::diag::head(message, 2000))
            .collect();
        serde_json::json!({ "turn_failed": failed, "errors": errors })
    }

    fn push(&mut self, line: &Value, on_event: &mut dyn FnMut(Event)) -> LineFlow {
        if !self.started {
            self.started = true;
            on_event(Event::Started);
        }
        #[cfg(feature = "diagnostics")]
        if self.events.len() < MAX_EVENT_LABELS {
            self.events.push(event_label(line));
        }
        match line["type"].as_str() {
            Some("thread.started") => match line["thread_id"].as_str() {
                Some(id) if valid_thread_id(id) => self.thread = Thread::Id(id.to_owned()),
                _ if self.image_turn => {
                    self.thread = Thread::Refused;
                    return LineFlow::Stop;
                }
                _ => {}
            },
            Some("item.completed") if line["item"]["type"] == "agent_message" => {
                if let Some(text) = line["item"]["text"].as_str() {
                    self.last_text = Some(text.to_owned());
                    // Codex sends each message whole, never in pieces.
                    let text = text.to_owned();
                    on_event(if self.wants_schema {
                        Event::OutputDelta { text }
                    } else {
                        Event::Delta { text }
                    });
                }
            }
            Some("item.completed") if line["item"]["type"] == "reasoning" => {
                if let Some(text) = line["item"]["text"].as_str().filter(|t| !t.is_empty()) {
                    if self.thinking_sent {
                        on_event(Event::Thinking {
                            text: "\n\n".to_owned(),
                        });
                    }
                    self.thinking_sent = true;
                    on_event(Event::Thinking {
                        text: text.to_owned(),
                    });
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

    /// The result of the turn. `image_home` is the Codex home of an image
    /// turn, whose answer is the PNG the CLI generated; its reply text is
    /// optional. The folder is read only after `turn.completed`.
    fn finish(
        self,
        process: Result<Finished, ProcessError>,
        schema: Option<&Value>,
        image_home: Option<&Path>,
    ) -> Result<RunOutput, AgentError> {
        if matches!(self.thread, Thread::Refused) {
            return Err(AgentError::Protocol("unexpected thread id".to_owned()));
        }
        let earlier: Vec<&str> = self.errors.iter().map(String::as_str).collect();
        match self.end {
            Some(Final::Completed) if image_home.is_some() => {
                let Thread::Id(thread_id) = self.thread else {
                    return Err(AgentError::Protocol("no thread id".to_owned()));
                };
                let image = read_generated_image(image_home.unwrap_or(Path::new("")), &thread_id)?;
                Ok(RunOutput {
                    json: self.last_text.map(Value::String),
                    image: Some(image),
                })
            }
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

/// The id of the `model/list` request in the app-server conversation.
const LIST_REQUEST_ID: u64 = 2;

/// The arguments of the model-list call. `app-server` has no
/// `--ignore-user-config`, so it gets the same overrides and disabled features
/// as a turn. The user's MCP servers and plugin hosts start only with a
/// thread, and this conversation never starts one (see [`list_request`]).
fn list_args() -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "app-server",
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
    args
}

/// The three stdin lines of the conversation: `initialize`, `initialized`,
/// `model/list`. Nothing else: no thread is started, so no turn is spent and
/// no MCP server, plugin or tool of the user's configuration is launched.
fn list_request() -> Vec<u8> {
    let lines = [
        json!({
            "id": 1,
            "method": "initialize",
            "params": { "clientInfo": { "name": "cropa", "version": env!("CARGO_PKG_VERSION") } },
        }),
        json!({ "method": "initialized" }),
        json!({ "id": LIST_REQUEST_ID, "method": "model/list", "params": {} }),
    ];
    let mut text = String::new();
    for line in lines {
        text.push_str(&line.to_string());
        text.push('\n');
    }
    text.into_bytes()
}

/// Only the fields of a model entry that Cropa uses.
#[derive(Deserialize)]
struct ModelEntry {
    id: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default, rename = "displayName")]
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    hidden: bool,
    #[serde(default, rename = "isDefault")]
    is_default: bool,
    #[serde(default, rename = "availabilityNux")]
    availability_nux: Option<Value>,
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<ModelEntry>,
}

fn models_from(list: ModelList) -> Vec<ModelInfo> {
    list.data
        .into_iter()
        .filter(|entry| !entry.hidden)
        .map(|entry| ModelInfo {
            id: entry.model.unwrap_or(entry.id),
            display_name: entry.display_name,
            description: entry.description,
            is_default: entry.is_default,
            is_new: entry.availability_nux.is_some_and(|nux| !nux.is_null()),
        })
        .collect()
}

/// Reads one stdout line of the model-list call. Notifications (lines with a
/// `method`) are ignored; the answer is the line with the list request's id.
fn read_models_line(
    line: &Value,
    answer: &mut Option<Result<Vec<ModelInfo>, AgentError>>,
) -> LineFlow {
    if line.get("method").is_some() {
        return LineFlow::Continue;
    }
    match line["id"].as_u64() {
        Some(1) if line.get("error").is_some() => {
            *answer = Some(Err(AgentError::Protocol(
                "the CLI refused to start".to_owned(),
            )));
            LineFlow::Stop
        }
        Some(LIST_REQUEST_ID) => {
            *answer = Some(if line.get("error").is_some() {
                Err(AgentError::Protocol(
                    "the CLI refused the model list".to_owned(),
                ))
            } else {
                serde_json::from_value::<ModelList>(line["result"].clone())
                    .map(models_from)
                    .map_err(|_| {
                        AgentError::Protocol("the model list was not understood".to_owned())
                    })
            });
            LineFlow::Stop
        }
        _ => LineFlow::Continue,
    }
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

impl AgentCli for CodexExec {
    fn detect(&self) -> Detection {
        detect(self.find(), &PROBE)
    }

    fn list_models(&self, cancel: &CancelToken) -> Result<Vec<ModelInfo>, AgentError> {
        let executable = self.find().ok_or(AgentError::NotInstalled)?;
        let dir = scratch_dir()?;
        // The server quits when its input closes, so the pipe stays open until
        // the answer arrives.
        let spec = ProcessSpec {
            program: executable,
            args: list_args(),
            env: adapter_env(&[LOGIN_ENV]),
            stdin: Some(list_request()),
            keep_stdin_open: true,
            timeout: LIST_TIMEOUT,
        };
        let started = Instant::now();
        let mut answer = None;
        let process = run_process(&spec, dir.path(), cancel, &mut |line| {
            read_models_line(&line, &mut answer)
        });
        let result = models_result(answer, process).map(sanitize_models);
        log::debug!(
            "codex models: {} after {} ms",
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
        check_model(req.model.as_deref())?;
        let executable = self.find().ok_or(AgentError::NotInstalled)?;
        // The image is the answer of an image turn, so it has no schema; the
        // Codex home is found before the turn so a failure here costs no quota.
        let schema = if req.want_image {
            None
        } else {
            req.schema.as_ref()
        };
        let image_home =
            if req.want_image {
                Some(codex_home().ok_or_else(|| {
                    AgentError::Protocol("could not find the Codex home".to_owned())
                })?)
            } else {
                None
            };
        let images = req
            .images
            .iter()
            .map(|path| read_png(path))
            .collect::<Result<Vec<_>, _>>()?;

        let dir = scratch_dir()?;
        let write_error = |_| AgentError::Protocol("could not write a file for the CLI".to_owned());
        let schema_file = match schema {
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
            args: build_args(
                schema_file.as_deref(),
                &image_files,
                req.model.as_deref(),
                req.effort,
                req.want_image,
            ),
            env: adapter_env(&[LOGIN_ENV]),
            stdin: Some(stdin_text(&req.system, &req.prompt)),
            keep_stdin_open: false,
            timeout: req.timeout,
        };
        let mut stream = CodexStream::new(schema.is_some(), req.want_image);
        let process = run_process(&spec, dir.path(), cancel, &mut |line| {
            stream.push(&line, &mut *on_event)
        });
        #[cfg(feature = "diagnostics")]
        let (events, summary, stderr_tail) = (
            stream.events.clone(),
            stream.failure_summary(),
            crate::diag::stderr_of(&process),
        );
        let result = stream.finish(process, schema, image_home.as_deref());
        #[cfg(feature = "diagnostics")]
        if let Err(error) = &result {
            crate::diag::report("codex", error, &events, Some(&summary), &stderr_tail);
        }
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
    use crate::turn_dir::TurnDir;

    const SCHEMA_OK: &str = include_str!("../tests/fixtures/codex/exec-schema-ok.jsonl");
    const IMAGE_OK: &str = include_str!("../tests/fixtures/codex/exec-image-ok.jsonl");
    const IMAGE_GENERATION: &str =
        include_str!("../tests/fixtures/codex/exec-image-generation-ok.jsonl");
    const THREAD: &str = "00000000-0000-0000-0000-000000000000";
    const REASONING: &str = include_str!("../tests/fixtures/codex/exec-reasoning-summary.jsonl");
    const REJECTED: &str = include_str!("../tests/fixtures/codex/exec-schema-rejected.jsonl");
    const CANCELLED: &str = include_str!("../tests/fixtures/codex/exec-cancelled.jsonl");
    const LOGIN_IN: &str =
        include_str!("../tests/fixtures/codex/login-status-logged-in.stderr.txt");
    const LOGIN_OUT: &str =
        include_str!("../tests/fixtures/codex/login-status-logged-out.stderr.txt");

    /// Feeds lines like the runner does: in order, up to the first `Stop`.
    fn feed(lines: &str) -> (CodexStream, Vec<Event>, usize) {
        feed_as(lines, false, false)
    }

    fn feed_as(
        lines: &str,
        wants_schema: bool,
        image_turn: bool,
    ) -> (CodexStream, Vec<Event>, usize) {
        let mut stream = CodexStream::new(wants_schema, image_turn);
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

    const MODELS: &str = include_str!("../tests/fixtures/codex/app-server-model-list.jsonl");

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
        models_result(answer, process).map(sanitize_models)
    }

    #[test]
    fn the_model_list_skips_notifications_and_marks_the_default_and_the_new() {
        let models = list_from(MODELS, ok()).unwrap();
        assert_eq!(models.len(), 8);
        assert_eq!(models[0].id, "gpt-6.1-sol");
        assert_eq!(models[0].display_name, "GPT-6.1-Sol");
        assert!(models[0].is_default && models[0].is_new);
        assert!(models[1..].iter().all(|m| !m.is_default && !m.is_new));
    }

    #[test]
    fn hidden_models_are_left_out_of_the_list() {
        let line = r#"{"id":2,"result":{"data":[{"id":"a","model":"a-model","displayName":"A","hidden":true},{"id":"b","displayName":"B","hidden":false}]}}"#;
        let models = list_from(line, ok()).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "b");
    }

    #[test]
    fn an_error_answer_is_a_protocol_error() {
        let line = r#"{"id":2,"error":{"code":-32601,"message":"no"}}"#;
        assert_eq!(
            list_from(line, ok()).unwrap_err(),
            AgentError::Protocol("the CLI refused the model list".to_owned())
        );
        let line = r#"{"id":1,"error":{"code":-1,"message":"no"}}"#;
        assert_eq!(
            list_from(line, ok()).unwrap_err(),
            AgentError::Protocol("the CLI refused to start".to_owned())
        );
    }

    #[test]
    fn a_model_list_that_never_comes_is_an_error() {
        let lines = r#"{"id":1,"result":{}}
{"method":"account/updated","params":{}}"#;
        assert_eq!(
            list_from(lines, ok()).unwrap_err(),
            AgentError::Protocol("the CLI ended without a model list".to_owned())
        );
        assert_eq!(
            list_from(
                lines,
                Err(ProcessError::Exit {
                    code: Some(1),
                    stderr_tail: "Not logged in".to_owned()
                })
            )
            .unwrap_err(),
            AgentError::NotLoggedIn
        );
    }

    #[test]
    fn the_model_list_call_is_fixed_and_locked_down() {
        let mut expected: Vec<String> = [
            "app-server",
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
        let args: Vec<String> = list_args()
            .iter()
            .map(|arg| arg.to_str().unwrap().to_owned())
            .collect();
        assert_eq!(args, expected);
        assert!(!args.iter().any(|arg| arg.contains("sign-out")));

        let text = String::from_utf8(list_request()).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        // No `thread/start`: the user's MCP servers and plugins start only with a thread.
        assert!(!text.contains("thread/"));
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["method"], "initialize");
        assert_eq!(lines[0]["params"]["clientInfo"]["name"], "cropa");
        assert_eq!(lines[1], json!({ "method": "initialized" }));
        assert_eq!(lines[2]["method"], "model/list");
        assert_eq!(lines[2]["id"], 2);
    }

    #[test]
    fn a_schema_turn_returns_the_last_agent_message_as_json() {
        let schema = json!({"type": "object", "properties": {"layers": {"type": "array"}}, "required": ["layers"]});
        let (stream, events, fed) = feed_as(SCHEMA_OK, true, false);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0], Event::Started);
        assert!(matches!(&events[1], Event::OutputDelta { text } if text.starts_with('{')));
        assert_eq!(fed, SCHEMA_OK.lines().count());
        let out = stream.finish(ok(), Some(&schema), None).unwrap();
        assert_eq!(out.json.unwrap()["layers"][1]["kind"], "radial");
    }

    #[test]
    fn a_reasoning_summary_streams_as_thinking_before_the_answer() {
        let schema = json!({"type": "object"});
        let (stream, events, _) = feed_as(REASONING, true, false);
        let final_text = match events.last() {
            Some(Event::OutputDelta { text }) => text.clone(),
            other => panic!("expected the answer last, got {other:?}"),
        };
        assert_eq!(
            events[..events.len() - 1],
            [
                Event::Started,
                Event::Thinking {
                    text: "**Sizing the canvas**".to_owned()
                },
            ]
        );
        let out = stream.finish(ok(), Some(&schema), None).unwrap();
        assert_eq!(out.json, serde_json::from_str(&final_text).ok());
    }

    #[test]
    fn a_second_reasoning_summary_follows_a_blank_line_and_prose_is_a_delta() {
        let lines = [
            r#"{"type":"item.completed","item":{"type":"reasoning","text":"one"}}"#,
            r#"{"type":"item.completed","item":{"type":"reasoning","text":"two"}}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"done"}}"#,
        ]
        .join("\n");
        let (_, events, _) = feed(&lines);
        let texts: Vec<String> = events
            .into_iter()
            .map(|event| match event {
                Event::Thinking { text } => format!("t:{text}"),
                Event::Delta { text } => format!("d:{text}"),
                other => format!("{other:?}"),
            })
            .collect();
        assert_eq!(texts, ["Started", "t:one", "t:\n\n", "t:two", "d:done"]);
    }

    #[test]
    fn a_turn_without_a_schema_returns_the_text() {
        let (stream, _, _) = feed(IMAGE_OK);
        let out = stream.finish(ok(), None, None).unwrap();
        assert_eq!(out.json, Some(json!("left=red right=blue")));
    }

    #[test]
    fn a_reply_that_is_not_json_is_a_protocol_error() {
        let (stream, _, _) = feed(IMAGE_OK);
        assert_eq!(
            stream
                .finish(ok(), Some(&json!({"type": "object"})), None)
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
            stream.finish(ok(), Some(&json!({})), None).unwrap_err(),
            AgentError::Protocol("the CLI refused the schema".to_owned())
        );
    }

    #[test]
    fn a_cut_stream_is_cancelled_timed_out_or_a_protocol_error() {
        let finish = |process| {
            let (stream, _, fed) = feed(CANCELLED);
            assert_eq!(fed, CANCELLED.lines().count());
            stream.finish(process, None, None).unwrap_err()
        };
        assert_eq!(finish(Err(ProcessError::Cancelled)), AgentError::Cancelled);
        assert_eq!(finish(Err(ProcessError::Timeout)), AgentError::Timeout);
        assert_eq!(
            finish(ok()),
            AgentError::Protocol("the CLI ended without a final event".to_owned())
        );
    }

    #[cfg(feature = "diagnostics")]
    #[test]
    fn the_diagnostic_keeps_event_labels_and_the_failure_message() {
        let (stream, _, _) = feed(REJECTED);
        assert!(stream.events.iter().any(|label| label == "turn.failed"));
        let summary = stream.failure_summary();
        assert!(summary["turn_failed"].is_string());

        let (stream, _, _) = feed(SCHEMA_OK);
        assert!(
            stream
                .events
                .contains(&"item.completed/agent_message".to_owned())
        );
        assert!(stream.failure_summary()["turn_failed"].is_null());
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
            stream.finish(ok(), None, None).unwrap_err(),
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
            stream.finish(ok(), None, None).unwrap_err(),
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
        assert_eq!(
            stream.finish(ok(), None, None).unwrap().json,
            Some(json!("done"))
        );
    }

    #[test]
    fn the_arguments_are_fixed_and_the_prompt_is_not_among_them() {
        let args = build_args(
            Some(Path::new("/t/output-schema.json")),
            &[PathBuf::from("/t/input-0.png")],
            Some("gpt-5"),
            Effort::Low,
            false,
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
            "project_doc_max_bytes=0",
            "-c",
            "web_search=\"disabled\"",
            "-c",
            "model_reasoning_summary=\"auto\"",
            "-c",
            "model_reasoning_effort=\"low\"",
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
    fn an_image_turn_differs_only_by_the_image_tool_being_on() {
        let schema = Path::new("/t/output-schema.json");
        let images = [PathBuf::from("/t/input-0.png")];
        let normal = build_args(Some(schema), &images, Some("gpt-5"), Effort::Low, false);
        // An image turn has no schema: the image is the answer.
        let image = build_args(None, &images, Some("gpt-5"), Effort::Low, true);
        let strings = |args: &[OsString]| -> Vec<String> {
            args.iter()
                .map(|a| a.to_str().unwrap().to_owned())
                .collect()
        };
        let mut expected = strings(&normal);
        let at = expected
            .iter()
            .position(|a| a == "image_generation")
            .unwrap();
        assert_eq!(expected[at - 1], "--disable");
        expected.drain(at - 1..=at);
        expected.retain(|a| !a.starts_with("--output-schema="));
        let image = strings(&image);
        assert_eq!(image, expected);
        assert!(image.contains(&"--image=/t/input-0.png".to_owned()));
        assert!(image.contains(&"--sandbox".to_owned()));
        assert!(image.contains(&"--ignore-user-config".to_owned()));
        assert!(!image.iter().any(|a| a == "image_generation"));
        // Every other feature is still off.
        for feature in DISABLED_FEATURES
            .iter()
            .filter(|f| **f != "image_generation")
        {
            assert!(image.contains(&(*feature).to_owned()), "{feature}");
        }
    }

    // --- The generated image

    /// A PNG header of the given size: enough for the checks, which do not decode.
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
        bytes
    }

    /// A temporary Codex home holding `generated_images/<THREAD>/`.
    fn home_with(files: &[(&str, &[u8])]) -> TurnDir {
        let home = scratch_dir().unwrap();
        let dir = home.path().join("generated_images").join(THREAD);
        std::fs::create_dir_all(&dir).unwrap();
        for (name, bytes) in files {
            std::fs::write(dir.join(name), bytes).unwrap();
        }
        home
    }

    fn image_turn(lines: &str, home: &Path) -> Result<RunOutput, AgentError> {
        let (stream, _, _) = feed_as(lines, false, true);
        stream.finish(ok(), None, Some(home))
    }

    #[test]
    fn the_stream_keeps_the_thread_id() {
        let (stream, _, fed) = feed(IMAGE_GENERATION);
        assert!(matches!(&stream.thread, Thread::Id(id) if id == THREAD));
        assert_eq!(fed, IMAGE_GENERATION.lines().count());
    }

    #[test]
    fn an_image_turn_returns_the_png_and_leaves_the_file() {
        let bytes = png(1200, 800);
        let home = home_with(&[("exec-x.png", &bytes)]);
        let out = image_turn(IMAGE_GENERATION, home.path()).unwrap();
        assert_eq!(out.image.as_deref(), Some(bytes.as_slice()));
        assert_eq!(out.json, Some(json!("done")));
        let file = home
            .path()
            .join("generated_images")
            .join(THREAD)
            .join("exec-x.png");
        assert!(file.is_file());
    }

    #[test]
    fn an_image_turn_needs_no_reply_text_when_the_image_is_there() {
        let lines = [
            format!(r#"{{"type":"thread.started","thread_id":"{THREAD}"}}"#),
            r#"{"type":"turn.completed"}"#.to_owned(),
        ]
        .join("\n");
        let home = home_with(&[("a.png", &png(64, 64))]);
        let out = image_turn(&lines, home.path()).unwrap();
        assert!(out.image.is_some());
        assert_eq!(out.json, None);
    }

    #[test]
    fn the_newest_png_wins_and_other_files_are_ignored() {
        let (old, new) = (png(100, 100), png(200, 200));
        let home = home_with(&[
            ("old.png", &old),
            ("new.PNG", &new),
            ("notes.txt", b"x"),
            ("auth.json", b"{}"),
        ]);
        let dir = home.path().join("generated_images").join(THREAD);
        let time = |secs| SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs);
        std::fs::File::options()
            .write(true)
            .open(dir.join("old.png"))
            .unwrap()
            .set_modified(time(1_000))
            .unwrap();
        std::fs::File::options()
            .write(true)
            .open(dir.join("new.PNG"))
            .unwrap()
            .set_modified(time(2_000))
            .unwrap();
        assert_eq!(read_generated_image(home.path(), THREAD).unwrap(), new);
        // A folder named like a PNG is not a file.
        let only_dir = scratch_dir().unwrap();
        std::fs::create_dir_all(
            only_dir
                .path()
                .join("generated_images")
                .join(THREAD)
                .join("x.png"),
        )
        .unwrap();
        assert_eq!(
            read_generated_image(only_dir.path(), THREAD),
            Err(AgentError::NoImage)
        );
    }

    #[test]
    fn no_folder_or_no_png_is_no_image() {
        let none = scratch_dir().unwrap();
        assert_eq!(
            image_turn(IMAGE_GENERATION, none.path()).unwrap_err(),
            AgentError::NoImage
        );
        let empty = home_with(&[]);
        assert_eq!(
            image_turn(IMAGE_GENERATION, empty.path()).unwrap_err(),
            AgentError::NoImage
        );
        let text_only = home_with(&[("a.txt", b"x")]);
        assert_eq!(
            image_turn(IMAGE_GENERATION, text_only.path()).unwrap_err(),
            AgentError::NoImage
        );
    }

    #[test]
    fn a_file_that_is_not_a_usable_png_is_a_protocol_error() {
        let unusable = AgentError::Protocol("the CLI's image is not a usable PNG".to_owned());
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("not a png", b"hello, this is not a png at all".to_vec()),
            ("too small", png(10, 10)),
            ("too wide", png(9000, 100)),
            ("too many pixels", png(8192, 8192)),
            ("truncated", PNG_SIGNATURE.to_vec()),
        ];
        for (name, bytes) in cases {
            let home = home_with(&[("exec-x.png", &bytes)]);
            assert_eq!(
                image_turn(IMAGE_GENERATION, home.path()).unwrap_err(),
                unusable,
                "{name}"
            );
        }
    }

    #[test]
    fn a_thread_id_that_is_not_plain_is_refused_and_nothing_is_read() {
        let home = home_with(&[("exec-x.png", &png(100, 100))]);
        for bad in ["../x", "a/b", "a\\b", "", "..", "x y", &"a".repeat(65)] {
            let lines = [
                format!(r#"{{"type":"thread.started","thread_id":{}}}"#, json!(bad)),
                r#"{"type":"turn.completed"}"#.to_owned(),
            ]
            .join("\n");
            let (_, _, fed) = feed_as(&lines, false, true);
            assert_eq!(fed, 1, "the stream stops at the bad id: {bad:?}");
            assert_eq!(
                image_turn(&lines, home.path()).unwrap_err(),
                AgentError::Protocol("unexpected thread id".to_owned()),
                "{bad:?}"
            );
            assert_eq!(
                read_generated_image(home.path(), bad).unwrap_err(),
                AgentError::Protocol("unexpected thread id".to_owned()),
                "{bad:?}"
            );
        }
        assert!(valid_thread_id(THREAD));
        assert!(valid_thread_id("a"));
        assert!(valid_thread_id(&"a".repeat(64)));
    }

    #[test]
    fn a_text_turn_ignores_a_thread_id_it_does_not_use() {
        let lines = [
            r#"{"type":"thread.started","thread_id":"a/b"}"#,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}"#,
            r#"{"type":"turn.completed"}"#,
        ]
        .join("\n");
        let (stream, _, fed) = feed(&lines);
        assert_eq!(fed, 3, "the stream runs to the end of the turn");
        let out = stream.finish(ok(), None, None).unwrap();
        assert_eq!(out.json, Some(json!("hi")));
    }

    #[test]
    fn a_turn_without_a_thread_id_has_no_image_to_read() {
        let home = home_with(&[("exec-x.png", &png(100, 100))]);
        let lines = r#"{"type":"turn.completed"}"#;
        assert_eq!(
            image_turn(lines, home.path()).unwrap_err(),
            AgentError::Protocol("no thread id".to_owned())
        );
    }

    #[test]
    fn a_failed_or_cut_image_turn_reads_nothing() {
        let home = home_with(&[("exec-x.png", &png(100, 100))]);
        let failed = [
            format!(r#"{{"type":"thread.started","thread_id":"{THREAD}"}}"#),
            r#"{"type":"turn.failed","error":{"message":"boom"}}"#.to_owned(),
        ]
        .join("\n");
        assert_eq!(
            image_turn(&failed, home.path()).unwrap_err(),
            AgentError::Protocol("the turn failed".to_owned())
        );
        let limit = [
            format!(r#"{{"type":"thread.started","thread_id":"{THREAD}"}}"#),
            r#"{"type":"turn.failed","error":{"message":"usage_limit_reached"}}"#.to_owned(),
        ]
        .join("\n");
        assert_eq!(
            image_turn(&limit, home.path()).unwrap_err(),
            AgentError::UsageLimit
        );
        // The stream ends before `turn.completed`: cancelled, not an image.
        let cut = format!(r#"{{"type":"thread.started","thread_id":"{THREAD}"}}"#);
        let (stream, _, _) = feed(&cut);
        assert_eq!(
            stream
                .finish(Err(ProcessError::Cancelled), None, Some(home.path()))
                .unwrap_err(),
            AgentError::Cancelled
        );
    }

    #[test]
    fn the_codex_home_comes_from_codex_home_or_the_home_folder() {
        let os = |s: &str| Some(OsString::from(s));
        let abs = if cfg!(windows) { "C:\\codex" } else { "/codex" };
        let home = if cfg!(windows) {
            "C:\\Users\\a"
        } else {
            "/home/a"
        };
        assert_eq!(codex_home_from(os(abs), os(home)), Some(PathBuf::from(abs)));
        assert_eq!(
            codex_home_from(None, os(home)),
            Some(PathBuf::from(home).join(".codex"))
        );
        // A relative `CODEX_HOME` is not trusted.
        assert_eq!(
            codex_home_from(os("relative/codex"), os(home)),
            Some(PathBuf::from(home).join(".codex"))
        );
        assert_eq!(
            codex_home_from(os(""), os(home)),
            codex_home_from(None, os(home))
        );
        assert_eq!(codex_home_from(None, os("relative")), None);
        assert_eq!(codex_home_from(None, None), None);
    }

    #[test]
    fn each_effort_becomes_its_own_fixed_reasoning_setting() {
        for (effort, word) in [
            (Effort::Low, "low"),
            (Effort::Medium, "medium"),
            (Effort::High, "high"),
        ] {
            let args = build_args(None, &[], None, effort, false);
            let settings: Vec<&str> = args
                .iter()
                .filter_map(|a| a.to_str())
                .filter(|a| a.starts_with("model_reasoning_effort="))
                .collect();
            assert_eq!(settings, [format!("model_reasoning_effort=\"{word}\"")]);
        }
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
