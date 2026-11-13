//! Runs real processes (the `cropa-agent-fake-cli` helper) through the runner.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use cropa_agent::{
    AgentError, BASE_ENV_ALLOWLIST, CancelToken, LineFlow, ProcessError, ProcessSpec, TurnDir,
    base_env, filter_env, run_capture, run_process,
};
use serde_json::{Value, json};

fn fake_cli() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_cropa-agent-fake-cli"))
}

fn spec(args: &[&str], timeout: Duration) -> ProcessSpec {
    ProcessSpec {
        program: fake_cli(),
        args: args.iter().map(OsString::from).collect(),
        env: base_env(),
        stdin: None,
        timeout,
    }
}

fn run(
    spec: &ProcessSpec,
    cancel: &CancelToken,
) -> (Result<cropa_agent::Finished, ProcessError>, Vec<Value>) {
    let dir = TurnDir::new().unwrap();
    let mut lines = Vec::new();
    let result = run_process(spec, dir.path(), cancel, &mut |v| {
        lines.push(v);
        LineFlow::Continue
    });
    (result, lines)
}

#[cfg(windows)]
fn process_exists(pid: u64) -> bool {
    let out = std::process::Command::new(r"C:\Windows\System32\tasklist.exe")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .expect("tasklist");
    String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
}

#[cfg(windows)]
fn assert_all_gone(pids: &[u64]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while pids.iter().any(|&pid| process_exists(pid)) {
        assert!(Instant::now() < deadline, "processes still alive: {pids:?}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn lines_arrive_in_order() {
    let (result, lines) = run(
        &spec(&["lines", "5", "20"], Duration::from_secs(10)),
        &CancelToken::new(),
    );
    result.unwrap();
    let seqs: Vec<_> = lines.iter().map(|l| l["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, [0, 1, 2, 3, 4]);
}

#[cfg(windows)]
#[test]
fn timeout_kills_the_child_and_its_grandchild() {
    let mut pids = Vec::new();
    let dir = TurnDir::new().unwrap();
    let result = run_process(
        &spec(&["grandchild"], Duration::from_secs(1)),
        dir.path(),
        &CancelToken::new(),
        &mut |v| {
            pids.push(v["pid"].as_u64().unwrap());
            pids.push(v["grandchild"].as_u64().unwrap());
            LineFlow::Continue
        },
    );
    assert_eq!(result.unwrap_err(), ProcessError::Timeout);
    assert_eq!(pids.len(), 2);
    assert_all_gone(&pids);
}

#[cfg(windows)]
#[test]
fn cancel_kills_the_child_and_its_grandchild() {
    let cancel = CancelToken::new();
    let (tx, rx) = mpsc::channel::<()>();
    let canceller = std::thread::spawn({
        let cancel = cancel.clone();
        move || {
            if rx.recv().is_ok() {
                cancel.cancel();
            }
        }
    });
    let mut pids = Vec::new();
    let dir = TurnDir::new().unwrap();
    let result = run_process(
        &spec(&["grandchild"], Duration::from_secs(30)),
        dir.path(),
        &cancel,
        &mut |v| {
            pids.push(v["pid"].as_u64().unwrap());
            pids.push(v["grandchild"].as_u64().unwrap());
            let _ = tx.send(());
            LineFlow::Continue
        },
    );
    drop(tx);
    canceller.join().unwrap();
    assert_eq!(result.unwrap_err(), ProcessError::Cancelled);
    assert_all_gone(&pids);
}

#[cfg(windows)]
#[test]
fn a_child_that_exits_is_done_even_if_a_grandchild_holds_stdout() {
    let start = Instant::now();
    let (result, lines) = run(
        &spec(&["orphan"], Duration::from_secs(30)),
        &CancelToken::new(),
    );
    result.unwrap();
    assert!(start.elapsed() < Duration::from_secs(5));
    assert_eq!(lines.len(), 1);
    assert_all_gone(&[lines[0]["grandchild"].as_u64().unwrap()]);
}

#[test]
fn a_failing_exit_is_an_error_with_the_stderr_tail() {
    let (result, _) = run(
        &spec(&["exit", "3"], Duration::from_secs(10)),
        &CancelToken::new(),
    );
    let err = result.unwrap_err();
    match &err {
        ProcessError::Exit { code, stderr_tail } => {
            assert_eq!(*code, Some(3));
            assert!(stderr_tail.contains("fake cli failure"));
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(
        AgentError::from(err),
        AgentError::Protocol("exit code 3".to_owned())
    );
}

#[test]
fn a_line_that_is_not_json_is_a_protocol_error() {
    let (result, lines) = run(
        &spec(&["not-json"], Duration::from_secs(10)),
        &CancelToken::new(),
    );
    assert_eq!(lines.len(), 0);
    let err = result.unwrap_err();
    assert_eq!(err, ProcessError::NotJson);
    assert!(matches!(AgentError::from(err), AgentError::Protocol(_)));
}

#[test]
fn the_child_runs_in_the_given_dir_and_the_dir_goes_away_after_a_kill() {
    let dir = TurnDir::new().unwrap();
    let path = dir.path().to_path_buf();
    let mut lines = Vec::new();
    run_process(
        &spec(&["cwd"], Duration::from_secs(10)),
        dir.path(),
        &CancelToken::new(),
        &mut |v| {
            lines.push(v);
            LineFlow::Continue
        },
    )
    .unwrap();
    let cwd = PathBuf::from(lines[0]["cwd"].as_str().unwrap());
    assert_eq!(cwd.canonicalize().unwrap(), path.canonicalize().unwrap());

    // A killed child must not keep the directory alive.
    let result = run_process(
        &spec(&["sleep", "600000"], Duration::from_millis(300)),
        dir.path(),
        &CancelToken::new(),
        &mut |_| LineFlow::Continue,
    );
    assert_eq!(result.unwrap_err(), ProcessError::Timeout);
    drop(dir);
    assert!(!path.exists());
}

#[test]
fn the_child_sees_only_the_allowed_environment() {
    let source: Vec<(OsString, OsString)> = std::env::vars_os()
        .chain([(OsString::from("CROPA_TEST_SECRET"), OsString::from("1"))])
        .collect();
    let mut process = spec(&["env"], Duration::from_secs(10));
    process.env = filter_env(source, BASE_ENV_ALLOWLIST);
    let given: Vec<String> = process
        .env
        .iter()
        .map(|(name, _)| name.to_string_lossy().to_lowercase())
        .collect();
    let (result, lines) = run(&process, &CancelToken::new());
    result.unwrap();
    let names: Vec<String> = lines[0]["names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap().to_lowercase())
        .collect();
    assert!(!names.contains(&"cropa_test_secret".to_owned()));
    for name in &names {
        // Windows may add hidden per-drive variables such as `=C:`.
        assert!(
            name.starts_with('=') || given.contains(name),
            "unexpected variable {name}"
        );
    }
}

#[test]
fn stdin_is_written_once_and_closed() {
    let mut process = spec(&["stdin"], Duration::from_secs(10));
    let data = vec![b'p'; 300_000];
    process.stdin = Some(data.clone());
    let (result, lines) = run(&process, &CancelToken::new());
    result.unwrap();
    assert_eq!(lines, [json!({ "len": data.len() })]);
}

#[test]
fn a_relative_program_is_refused() {
    let mut process = spec(&["lines", "1", "0"], Duration::from_secs(10));
    process.program = Path::new("cropa-agent-fake-cli").to_path_buf();
    let (result, _) = run(&process, &CancelToken::new());
    assert!(matches!(result.unwrap_err(), ProcessError::Spawn(_)));
}

#[test]
fn a_missing_program_means_not_installed() {
    let mut process = spec(&["lines", "1", "0"], Duration::from_secs(10));
    process.program = fake_cli().with_file_name("does-not-exist.exe");
    let (result, _) = run(&process, &CancelToken::new());
    let err = result.unwrap_err();
    assert_eq!(err, ProcessError::NotFound);
    assert_eq!(AgentError::from(err), AgentError::NotInstalled);
}

#[test]
fn a_missing_cwd_is_not_reported_as_not_installed() {
    let dir = TurnDir::new().unwrap();
    let gone = dir.path().join("gone");
    let err = run_process(
        &spec(&["lines", "1", "0"], Duration::from_secs(10)),
        &gone,
        &CancelToken::new(),
        &mut |_| LineFlow::Continue,
    )
    .unwrap_err();
    assert!(matches!(err, ProcessError::Spawn(_)));
    assert!(matches!(AgentError::from(err), AgentError::Protocol(_)));
}

#[test]
fn debug_output_leaves_out_the_stderr_tail() {
    let err = ProcessError::Exit {
        code: Some(1),
        stderr_tail: "secret output".to_owned(),
    };
    assert!(!format!("{err:?}").contains("secret output"));
}

#[test]
fn stop_returns_at_once_and_kills_the_child() {
    let mut pids = Vec::new();
    let dir = TurnDir::new().unwrap();
    let start = Instant::now();
    let result = run_process(
        &spec(&["grandchild"], Duration::from_secs(60)),
        dir.path(),
        &CancelToken::new(),
        &mut |v| {
            pids.push(v["pid"].as_u64().unwrap());
            pids.push(v["grandchild"].as_u64().unwrap());
            LineFlow::Stop
        },
    );
    result.unwrap();
    assert!(start.elapsed() < Duration::from_secs(10));
    assert_eq!(pids.len(), 2);
    #[cfg(windows)]
    assert_all_gone(&pids);
}

#[test]
fn capture_returns_the_exit_code_and_both_streams() {
    let dir = TurnDir::new().unwrap();
    let captured = run_capture(
        &spec(&["capture", "3"], Duration::from_secs(10)),
        dir.path(),
        &CancelToken::new(),
    )
    .unwrap();
    assert_eq!(captured.code, Some(3));
    assert_eq!(captured.stdout.trim(), "captured out");
    assert_eq!(captured.stderr.trim(), "captured err");
    assert!(!format!("{captured:?}").contains("captured"));
}
