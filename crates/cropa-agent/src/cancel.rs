//! A cancel flag that a run polls and a pause can wait on.

use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

/// Shared between the code that starts a run and the run itself. Clones all
/// refer to the same flag; once cancelled it stays cancelled.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<(Mutex<bool>, Condvar)>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Marks the run cancelled and wakes everything waiting on the token.
    pub fn cancel(&self) {
        let (flag, wake) = &*self.0;
        *flag.lock().unwrap_or_else(PoisonError::into_inner) = true;
        wake.notify_all();
    }

    pub fn is_cancelled(&self) -> bool {
        *self.0.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Sleeps for `duration` or until cancelled, whichever comes first.
    /// Returns true when the token is cancelled.
    pub fn wait_timeout(&self, duration: Duration) -> bool {
        let (flag, wake) = &*self.0;
        let guard = flag.lock().unwrap_or_else(PoisonError::into_inner);
        let (guard, _) = wake
            .wait_timeout_while(guard, duration, |cancelled| !*cancelled)
            .unwrap_or_else(PoisonError::into_inner);
        *guard
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    #[test]
    fn cancel_wakes_a_waiter_at_once() {
        let token = CancelToken::new();
        let sleeper = std::thread::spawn({
            let token = token.clone();
            move || {
                let start = Instant::now();
                let cancelled = token.wait_timeout(Duration::from_secs(10));
                (cancelled, start.elapsed())
            }
        });
        std::thread::sleep(Duration::from_millis(50));
        token.cancel();
        let (cancelled, waited) = sleeper.join().unwrap();
        assert!(cancelled);
        assert!(waited < Duration::from_secs(2));
    }

    #[test]
    fn an_uncancelled_wait_times_out_false() {
        let token = CancelToken::new();
        assert!(!token.wait_timeout(Duration::from_millis(20)));
        assert!(!token.is_cancelled());
    }
}
