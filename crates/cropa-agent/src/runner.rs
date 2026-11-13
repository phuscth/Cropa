//! Runs one CLI process that prints a JSON value per line.
//!
//! The runner never retries and never writes the prompt twice. On every path
//! it kills the whole process tree and reaps the child before it returns.
//! Logs hold the pid, timings, exit code and error kind, never arguments,
//! stdin, stdout or stderr.

use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::cancel::CancelToken;
use crate::cli::AgentError;

#[cfg(unix)]
#[path = "runner/unix.rs"]
mod tree;
#[cfg(windows)]
#[path = "runner/windows.rs"]
mod tree;

/// Longest stdout line the runner accepts.
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
/// How much of stderr is kept for the adapter to classify an error.
const STDERR_TAIL_BYTES: usize = 16 * 1024;
/// How often the calling thread checks for cancel and the deadline.
const TICK: Duration = Duration::from_millis(50);

pub struct ProcessSpec {
    /// Must be absolute.
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// The complete child environment; the runner clears the inherited one.
    pub env: Vec<(OsString, OsString)>,
    /// The prompt, written once and then closed. `None` gives the child a null
    /// stdin.
    pub stdin: Option<Vec<u8>>,
    pub timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finished {
    /// The last 16 KB of stderr. For adapters to classify errors; never logged.
    pub stderr_tail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProcessError {
    #[error("could not start the process: {0:?}")]
    Spawn(io::ErrorKind),
    #[error("the process took too long")]
    Timeout,
    #[error("the run was cancelled")]
    Cancelled,
    #[error("the process exited with an error")]
    Exit {
        code: Option<i32>,
        stderr_tail: String,
    },
    #[error("a line was not JSON")]
    NotJson,
    #[error("a line was too long")]
    LineTooLong,
    #[error("could not read the output: {0:?}")]
    Io(io::ErrorKind),
}

impl From<ProcessError> for AgentError {
    fn from(err: ProcessError) -> Self {
        let text = match err {
            ProcessError::Spawn(io::ErrorKind::NotFound) => return Self::NotInstalled,
            ProcessError::Timeout => return Self::Timeout,
            ProcessError::Cancelled => return Self::Cancelled,
            ProcessError::Spawn(_) => "could not start the process".to_owned(),
            ProcessError::Exit {
                code: Some(code), ..
            } => format!("exit code {code}"),
            ProcessError::Exit { code: None, .. } => "the process was terminated".to_owned(),
            ProcessError::NotJson => "a line was not JSON".to_owned(),
            ProcessError::LineTooLong => "a line was too long".to_owned(),
            ProcessError::Io(_) => "could not read the output".to_owned(),
        };
        Self::Protocol(text)
    }
}

/// What the stdout reader hands to the calling thread.
enum Msg {
    Line(serde_json::Value),
    Failed(ProcessError),
}

#[derive(Debug, PartialEq, Eq)]
enum LineRead {
    Eof,
    Line,
    TooLong,
}

/// Reads one line (without its `\n`) into `buf`, giving up past `cap` bytes.
fn read_line_capped<R: BufRead>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    cap: usize,
) -> io::Result<LineRead> {
    loop {
        let chunk = match reader.fill_buf() {
            Ok(chunk) => chunk,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        if chunk.is_empty() {
            return Ok(if buf.is_empty() {
                LineRead::Eof
            } else {
                LineRead::Line
            });
        }
        if let Some(end) = chunk.iter().position(|&b| b == b'\n') {
            if buf.len() + end > cap {
                return Ok(LineRead::TooLong);
            }
            buf.extend_from_slice(&chunk[..end]);
            reader.consume(end + 1);
            return Ok(LineRead::Line);
        }
        let len = chunk.len();
        if buf.len() + len > cap {
            return Ok(LineRead::TooLong);
        }
        buf.extend_from_slice(chunk);
        reader.consume(len);
    }
}

fn read_stdout(stdout: impl Read, tx: &mpsc::SyncSender<Msg>, cap: usize) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let msg = match read_line_capped(&mut reader, &mut buf, cap) {
            Ok(LineRead::Eof) => return,
            Ok(LineRead::TooLong) => Msg::Failed(ProcessError::LineTooLong),
            Err(err) => Msg::Failed(ProcessError::Io(err.kind())),
            Ok(LineRead::Line) => {
                let line = buf.trim_ascii();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_slice(line) {
                    Ok(value) => Msg::Line(value),
                    Err(_) => Msg::Failed(ProcessError::NotJson),
                }
            }
        };
        let failed = matches!(msg, Msg::Failed(_));
        if tx.send(msg).is_err() || failed {
            return;
        }
    }
}

fn read_stderr_tail(mut stderr: impl Read) -> String {
    let mut tail: Vec<u8> = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        match stderr.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                tail.extend_from_slice(&chunk[..n]);
                if tail.len() > STDERR_TAIL_BYTES {
                    tail.drain(..tail.len() - STDERR_TAIL_BYTES);
                }
            }
        }
    }
    String::from_utf8_lossy(&tail).into_owned()
}

/// The child and its tree. Dropping it kills the tree and reaps the child, so
/// every exit path, a panic in the line callback included, cleans up.
struct Running {
    child: Child,
    tree: tree::Tree,
    reaped: bool,
}

impl Running {
    fn kill_and_reap(&mut self) {
        if self.reaped {
            return;
        }
        self.reaped = true;
        self.tree.kill();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.kill_and_reap();
    }
}

fn command(spec: &ProcessSpec, cwd: &Path) -> Command {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .env_clear()
        .envs(spec.env.iter().map(|(k, v)| (k, v)))
        .current_dir(cwd)
        .stdin(if spec.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// Waits for the child to exit, checking cancel and the deadline.
fn wait_exit(
    running: &mut Running,
    cancel: &CancelToken,
    deadline: Instant,
) -> Result<ExitStatus, ProcessError> {
    loop {
        match running.child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(err) => return Err(ProcessError::Io(err.kind())),
        }
        if cancel.is_cancelled() {
            return Err(ProcessError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(ProcessError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Reads stdout lines until EOF, then waits for the exit.
fn drive(
    running: &mut Running,
    rx: &mpsc::Receiver<Msg>,
    cancel: &CancelToken,
    deadline: Instant,
    on_line: &mut dyn FnMut(serde_json::Value),
) -> Result<ExitStatus, ProcessError> {
    loop {
        if cancel.is_cancelled() {
            return Err(ProcessError::Cancelled);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ProcessError::Timeout);
        }
        match rx.recv_timeout(remaining.min(TICK)) {
            Ok(Msg::Line(value)) => on_line(value),
            Ok(Msg::Failed(err)) => return Err(err),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    wait_exit(running, cancel, deadline)
}

fn error_kind(result: &Result<Finished, ProcessError>) -> &'static str {
    match result {
        Ok(_) => "ok",
        Err(ProcessError::Spawn(_)) => "spawn",
        Err(ProcessError::Timeout) => "timeout",
        Err(ProcessError::Cancelled) => "cancelled",
        Err(ProcessError::Exit { .. }) => "exit",
        Err(ProcessError::NotJson) => "not-json",
        Err(ProcessError::LineTooLong) => "line-too-long",
        Err(ProcessError::Io(_)) => "io",
    }
}

/// Starts the process in `cwd` and calls `on_line` on the calling thread for
/// each JSON line it prints, in order.
pub fn run_process(
    spec: &ProcessSpec,
    cwd: &Path,
    cancel: &CancelToken,
    on_line: &mut dyn FnMut(serde_json::Value),
) -> Result<Finished, ProcessError> {
    if !spec.program.is_absolute() {
        return Err(ProcessError::Spawn(io::ErrorKind::InvalidInput));
    }
    let started = Instant::now();
    let mut command = command(spec, cwd);
    let (child, tree) = tree::spawn(&mut command).map_err(|err| ProcessError::Spawn(err.kind()))?;
    let pid = child.id();
    let mut running = Running {
        child,
        tree,
        reaped: false,
    };
    let (Some(stdout), Some(stderr)) = (running.child.stdout.take(), running.child.stderr.take())
    else {
        return Err(ProcessError::Spawn(io::ErrorKind::Other));
    };

    // The deadline starts right before the prompt is written.
    let deadline = Instant::now() + spec.timeout;
    let writer: Option<JoinHandle<()>> = running.child.stdin.take().map(|mut stdin| {
        let data = spec.stdin.clone().unwrap_or_default();
        std::thread::spawn(move || {
            // The child may exit without reading its input; that is not an
            // error here.
            let _ = stdin.write_all(&data);
        })
    });
    let (tx, rx) = mpsc::sync_channel(256);
    let reader = std::thread::spawn(move || read_stdout(stdout, &tx, MAX_LINE_BYTES));
    let stderr_reader = std::thread::spawn(move || read_stderr_tail(stderr));

    let outcome = drive(&mut running, &rx, cancel, deadline, on_line);
    drop(rx);
    running.kill_and_reap();
    let _ = reader.join();
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let stderr_tail = stderr_reader.join().unwrap_or_default();

    let result = match outcome {
        Ok(status) if status.success() => Ok(Finished { stderr_tail }),
        Ok(status) => Err(ProcessError::Exit {
            code: status.code(),
            stderr_tail,
        }),
        Err(err) => Err(err),
    };
    log::debug!(
        "cli process {pid} finished: {} after {} ms",
        error_kind(&result),
        started.elapsed().as_millis()
    );
    result
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn read(input: &[u8], cap: usize) -> Vec<Result<(LineRead, String), io::ErrorKind>> {
        let mut reader = BufReader::with_capacity(4, Cursor::new(input.to_vec()));
        let mut out = Vec::new();
        loop {
            let mut buf = Vec::new();
            match read_line_capped(&mut reader, &mut buf, cap) {
                Ok(LineRead::Eof) => return out,
                Ok(kind @ LineRead::TooLong) => {
                    out.push(Ok((kind, String::new())));
                    return out;
                }
                Ok(kind) => out.push(Ok((kind, String::from_utf8(buf).unwrap()))),
                Err(err) => {
                    out.push(Err(err.kind()));
                    return out;
                }
            }
        }
    }

    #[test]
    fn lines_split_across_small_reads() {
        let lines = read(b"{\"a\":1}\n\n{\"b\":2}", 100);
        let text: Vec<_> = lines.into_iter().map(|l| l.unwrap().1).collect();
        assert_eq!(text, ["{\"a\":1}", "", "{\"b\":2}"]);
    }

    #[test]
    fn a_line_over_the_cap_is_refused() {
        assert_eq!(
            read(b"0123456789\n", 5),
            [Ok((LineRead::TooLong, String::new()))]
        );
        assert_eq!(
            read(b"0123456789", 5),
            [Ok((LineRead::TooLong, String::new()))]
        );
    }

    #[test]
    fn stderr_keeps_only_the_tail() {
        let big = vec![b'x'; STDERR_TAIL_BYTES + 100];
        let mut data = big;
        data.extend_from_slice(b"END");
        let tail = read_stderr_tail(Cursor::new(data));
        assert_eq!(tail.len(), STDERR_TAIL_BYTES);
        assert!(tail.ends_with("END"));
    }
}
