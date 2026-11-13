//! A scriptable [`AgentCli`] for the UI and for tests: no process, no login.

use std::time::{Duration, Instant};

use crate::cancel::CancelToken;
use crate::cli::{AgentCli, AgentError, Detection, Event, RunOutput, RunRequest};

/// What a mock run does. `delay` is spread evenly: the run waits one slice
/// before each event and one more before the outcome, so the whole run takes
/// `delay`. `Started` is emitted first, with no wait.
#[derive(Debug, Clone)]
pub struct MockScript {
    pub delay: Duration,
    pub events: Vec<Event>,
    pub outcome: Result<serde_json::Value, AgentError>,
}

#[derive(Debug, Clone)]
pub struct Mock {
    script: MockScript,
}

impl Mock {
    pub fn new(script: MockScript) -> Self {
        Self { script }
    }
}

/// Waits up to `slice`, stopping at the deadline or on cancel.
fn pause(cancel: &CancelToken, slice: Duration, deadline: Instant) -> Result<(), AgentError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if cancel.wait_timeout(slice.min(remaining)) {
        return Err(AgentError::Cancelled);
    }
    if slice > remaining {
        return Err(AgentError::Timeout);
    }
    Ok(())
}

impl AgentCli for Mock {
    fn detect(&self) -> Detection {
        Detection {
            executable: None,
            version: Some("mock".to_owned()),
            logged_in: Some(true),
            image_in: true,
            image_out: false,
        }
    }

    fn run(
        &self,
        req: RunRequest,
        cancel: &CancelToken,
        on_event: &mut dyn FnMut(Event),
    ) -> Result<RunOutput, AgentError> {
        let deadline = Instant::now() + req.timeout;
        let slices = u32::try_from(self.script.events.len() + 1).unwrap_or(u32::MAX);
        let slice = self.script.delay / slices;

        on_event(Event::Started);
        for event in &self.script.events {
            pause(cancel, slice, deadline)?;
            on_event(event.clone());
        }
        pause(cancel, slice, deadline)?;
        self.script.outcome.clone().map(|json| RunOutput {
            json: Some(json),
            image: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request(timeout: Duration) -> RunRequest {
        RunRequest {
            system: String::new(),
            prompt: String::new(),
            schema: None,
            images: Vec::new(),
            want_image: false,
            model: None,
            timeout,
        }
    }

    fn script(delay: Duration, outcome: Result<serde_json::Value, AgentError>) -> MockScript {
        MockScript {
            delay,
            events: vec![
                Event::Delta { text: "a".into() },
                Event::Delta { text: "b".into() },
            ],
            outcome,
        }
    }

    fn run(
        mock: &Mock,
        timeout: Duration,
        cancel: &CancelToken,
    ) -> (Result<RunOutput, AgentError>, Vec<Event>) {
        let mut seen = Vec::new();
        let result = mock.run(request(timeout), cancel, &mut |e| seen.push(e));
        (result, seen)
    }

    #[test]
    fn success_streams_started_then_the_events_in_order() {
        let mock = Mock::new(script(Duration::from_millis(30), Ok(json!({"ok": true}))));
        let (result, seen) = run(&mock, Duration::from_secs(5), &CancelToken::new());
        assert_eq!(result.unwrap().json, Some(json!({"ok": true})));
        assert_eq!(
            seen,
            vec![
                Event::Started,
                Event::Delta { text: "a".into() },
                Event::Delta { text: "b".into() },
            ]
        );
    }

    #[test]
    fn every_scripted_error_comes_back() {
        for error in [
            AgentError::NotInstalled,
            AgentError::NotLoggedIn,
            AgentError::UsageLimit,
            AgentError::Unsupported,
            AgentError::Timeout,
            AgentError::Protocol("exit code 3".into()),
            AgentError::Cancelled,
        ] {
            let mock = Mock::new(script(Duration::ZERO, Err(error.clone())));
            let (result, _) = run(&mock, Duration::from_secs(5), &CancelToken::new());
            assert_eq!(result.unwrap_err(), error);
        }
    }

    #[test]
    fn cancel_during_the_delay_returns_quickly() {
        let mock = Mock::new(script(Duration::from_secs(10), Ok(json!({}))));
        let cancel = CancelToken::new();
        let canceller = std::thread::spawn({
            let cancel = cancel.clone();
            move || {
                std::thread::sleep(Duration::from_millis(100));
                cancel.cancel();
            }
        });
        let start = Instant::now();
        let (result, _) = run(&mock, Duration::from_secs(60), &cancel);
        canceller.join().unwrap();
        assert_eq!(result.unwrap_err(), AgentError::Cancelled);
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_delay_longer_than_the_timeout_times_out_at_the_timeout() {
        let mock = Mock::new(script(Duration::from_secs(10), Ok(json!({}))));
        let start = Instant::now();
        let (result, _) = run(&mock, Duration::from_millis(100), &CancelToken::new());
        assert_eq!(result.unwrap_err(), AgentError::Timeout);
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
