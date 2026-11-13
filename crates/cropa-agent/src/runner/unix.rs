//! Unix tree kill: the child leads its own process group and the group gets
//! SIGKILL.

use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

/// The process group id of the child.
pub struct Tree(u32);

impl Tree {
    /// Kills every process in the group. Runs `/bin/kill` by its fixed path
    /// because the standard library can only signal a single pid.
    pub fn kill(&self) {
        let _ = Command::new("/bin/kill")
            .args(["-KILL", "--"])
            .arg(format!("-{}", self.0))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

pub fn spawn(command: &mut Command) -> io::Result<(Child, Tree)> {
    command.process_group(0);
    let child = command.spawn()?;
    let tree = Tree(child.id());
    Ok((child, tree))
}
