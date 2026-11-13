//! Windows tree kill: the child runs in a Job Object that kills every member
//! when the job closes or is terminated.
//!
//! The child starts suspended, joins the job, and only then runs, so it cannot
//! start a grandchild before the job holds it.
// The Win32 calls below are the only unsafe code in this crate; each block
// says why it is sound.
#![allow(unsafe_code)]

use std::io;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
};
use windows::core::PCWSTR;

/// Owns the job handle; closing it kills whatever still runs in the job, which
/// also covers a crash of Cropa itself.
pub struct Tree(HANDLE);

impl Tree {
    /// Kills every process in the job.
    pub fn kill(&self) {
        // SAFETY: `self.0` is a job handle this struct owns until `drop`.
        let _ = unsafe { TerminateJobObject(self.0, 1) };
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        // SAFETY: the handle is valid, owned here and closed exactly once.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn new_job() -> io::Result<Tree> {
    // SAFETY: no security attributes and no name; the call has no pointer
    // arguments to keep alive.
    let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(io::Error::other)?;
    let tree = Tree(job);
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: `info` is a live, correctly sized struct of the class named in
    // the call, and the job handle is valid.
    unsafe {
        SetInformationJobObject(
            tree.0,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&info).cast(),
            u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                .map_err(io::Error::other)?,
        )
    }
    .map_err(io::Error::other)?;
    Ok(tree)
}

/// Resumes the threads of the suspended process `pid`. Errors when none was
/// resumed.
fn resume_threads(pid: u32) -> io::Result<()> {
    // SAFETY: a thread snapshot takes no pointers; the handle is closed below.
    let snapshot =
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }.map_err(io::Error::other)?;
    let mut entry = THREADENTRY32 {
        dwSize: u32::try_from(size_of::<THREADENTRY32>()).map_err(io::Error::other)?,
        ..Default::default()
    };
    let mut resumed = 0_u32;
    // SAFETY: `snapshot` is valid, and `entry` is a live struct whose `dwSize`
    // is set as the API requires.
    let mut more = unsafe { Thread32First(snapshot, &raw mut entry) }.is_ok();
    while more {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: opens a handle to a thread id the snapshot just listed.
            if let Ok(thread) =
                unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }
            {
                // SAFETY: `thread` was opened with the resume right and is
                // closed right after.
                unsafe {
                    if ResumeThread(thread) != u32::MAX {
                        resumed += 1;
                    }
                    let _ = CloseHandle(thread);
                }
            }
        }
        // SAFETY: same as `Thread32First` above.
        more = unsafe { Thread32Next(snapshot, &raw mut entry) }.is_ok();
    }
    // SAFETY: `snapshot` is valid and closed exactly once.
    let _ = unsafe { CloseHandle(snapshot) };
    if resumed == 0 {
        return Err(io::Error::other("could not resume the process"));
    }
    Ok(())
}

/// Spawns `command` suspended, puts it in a new job and lets it run.
pub fn spawn(command: &mut Command) -> io::Result<(Child, Tree)> {
    let tree = new_job()?;
    command.creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0);
    let mut child = command.spawn()?;
    let setup = || -> io::Result<()> {
        // SAFETY: both handles are valid: the job is owned by `tree`, the
        // process by `child`, which outlives the call.
        unsafe { AssignProcessToJobObject(tree.0, HANDLE(child.as_raw_handle())) }
            .map_err(io::Error::other)?;
        resume_threads(child.id())
    };
    if let Err(err) = setup() {
        let _ = child.kill();
        let _ = child.wait();
        return Err(err);
    }
    Ok((child, tree))
}
