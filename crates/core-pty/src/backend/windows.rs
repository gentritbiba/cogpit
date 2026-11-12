//! ConPTY, driven directly.
//!
//! `portable-pty` builds the command line itself and quotes every argument,
//! so the `/c "…"` line an npm shim's sign-in needs reaches `cmd.exe` wrapped
//! in a second layer of quotes it cannot read. Here the command line is
//! exactly what `cmdline::command_line` returns.
//!
//! A kill is `taskkill /T /F` on the shell, as it always was: it ends the
//! shell and its descendants by parent, and spares a program whose launcher
//! already exited, such as an editor opened with `code .`. Once the shell is
//! gone, by a kill or on its own, nothing else of the terminal is ended.
//!
//! The process also starts suspended inside a job object that kills
//! everything in it when its last handle closes. That is the backstop for a
//! core that dies without stopping its terminals: it cannot leave a shell
//! running. Programs may still ask to leave the job.
#![allow(unsafe_code)]
#![warn(clippy::undocumented_unsafe_blocks)]

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString, c_void};
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::{mem, ptr};

use windows_sys::Win32::Foundation::{HANDLE, S_OK, WAIT_OBJECT_0};
use windows_sys::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES,
    STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
};

use super::cmdline::command_line;
use super::{Args, Process, SpawnSpec, Spawned};

/// The exit code a killed tree reports, as `taskkill /F` gave it.
const KILLED_EXIT_CODE: u32 = 1;

/// A pseudo-console and, until a reader takes it, the read end of its output.
///
/// `ClosePseudoConsole` can block until the console host has written its last
/// output, so it must never run while that output is neither read nor
/// discarded. Dropping this closes the read end first when nobody took it, so
/// the host's writes fail instead of blocking; a reader that took it drains it
/// until the end of the stream on its own thread.
struct PseudoConsole {
    handle: HPCON,
    output: Option<OwnedHandle>,
}

impl PseudoConsole {
    fn new(cols: u16, rows: u16) -> io::Result<(Self, OwnedHandle)> {
        let (input_read, input_write) = pipe()?;
        let (output_read, output_write) = pipe()?;
        let mut handle: HPCON = 0;
        // SAFETY: both pipe ends are open handles this function owns, and
        // `handle` is a valid place for the new console's handle.
        check(unsafe {
            CreatePseudoConsole(
                coord(cols, rows),
                raw(&input_read),
                raw(&output_write),
                0,
                &mut handle,
            )
        })?;
        // The console host holds its own duplicates of the ends it uses, so
        // `input_read` and `output_write` close here.
        let console = Self {
            handle,
            output: Some(output_read),
        };
        Ok((console, input_write))
    }

    fn take_output(&mut self) -> OwnedHandle {
        self.output
            .take()
            .expect("the output is taken once, right after spawning")
    }
}

impl Drop for PseudoConsole {
    fn drop(&mut self) {
        drop(self.output.take());
        // SAFETY: `handle` came from a successful CreatePseudoConsole and is
        // closed only here, once.
        unsafe { ClosePseudoConsole(self.handle) };
    }
}

struct WindowsProcess {
    pid: u32,
    console: Arc<Mutex<Option<PseudoConsole>>>,
    job: Arc<OwnedHandle>,
}

impl Process for WindowsProcess {
    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let console = self.console.lock().unwrap_or_else(|e| e.into_inner());
        let Some(console) = console.as_ref() else {
            return Ok(());
        };
        // SAFETY: the lock keeps the console open for the whole call.
        check(unsafe { ResizePseudoConsole(console.handle, coord(cols, rows)) })
    }

    fn kill(&self) {
        let killed = Command::new("taskkill")
            .args(["/PID", &self.pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .is_ok_and(|status| status.success());
        if killed {
            release(&self.job);
        } else {
            // SAFETY: `job` is an open job handle owned by `self`.
            unsafe { TerminateJobObject(raw(&self.job), KILLED_EXIT_CODE) };
        }
    }
}

pub fn spawn(spec: SpawnSpec) -> io::Result<Spawned> {
    reject_nul(&spec)?;
    let (mut console, input) = PseudoConsole::new(spec.cols, spec.rows)?;
    let mut attributes = AttributeList::with_pseudo_console(console.handle)?;
    // SAFETY: STARTUPINFOEXW is plain data; all zeroes is its empty value.
    let mut startup: STARTUPINFOEXW = unsafe { mem::zeroed() };
    startup.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
    // Otherwise a child inherits whatever this process's stdio is redirected
    // to instead of writing to the console (microsoft/terminal#4380).
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.lpAttributeList = attributes.as_mut_ptr();

    let mut line = wide(OsStr::new(&command_line(&spec.command, &spec.args)));
    let environment = environment_block(&spec.env);
    let cwd = wide(spec.cwd.as_os_str());
    // SAFETY: PROCESS_INFORMATION is plain data; all zeroes is its empty value.
    let mut info: PROCESS_INFORMATION = unsafe { mem::zeroed() };
    // SAFETY: `line`, `environment` and `cwd` are NUL-terminated buffers that
    // outlive the call (`line` is writable, as CreateProcessW requires), and
    // `startup` points at an initialized attribute list that `attributes`
    // keeps alive until after the call.
    let created = unsafe {
        CreateProcessW(
            ptr::null(),
            line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
            environment.as_ptr().cast::<c_void>(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut info,
        )
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    drop(attributes);
    // SAFETY: CreateProcessW succeeded, so both handles are open and ours.
    let (process, thread) = unsafe { (owned(info.hProcess), owned(info.hThread)) };

    let job = match job_holding(&process).map(Arc::new) {
        Ok(job) => job,
        Err(error) => {
            // SAFETY: `process` is open; the child is suspended and in no job.
            unsafe { TerminateProcess(raw(&process), KILLED_EXIT_CODE) };
            return Err(error);
        }
    };
    // SAFETY: `thread` is the open handle of the child's suspended main thread.
    if unsafe { ResumeThread(raw(&thread)) } == u32::MAX {
        let error = io::Error::last_os_error();
        // SAFETY: `job` is open and holds the child.
        unsafe { TerminateJobObject(raw(&job), KILLED_EXIT_CODE) };
        return Err(error);
    }
    drop(thread);

    let output = console.take_output();
    let console = Arc::new(Mutex::new(Some(console)));
    let closer = Arc::clone(&console);
    let exited_job = Arc::clone(&job);
    Ok(Spawned {
        process: Arc::new(WindowsProcess {
            pid: info.dwProcessId,
            console,
            job,
        }),
        input: Box::new(File::from(input)),
        output: Box::new(File::from(output)),
        wait: Box::new(move || {
            let code = wait_for_exit(&process);
            release(&exited_job);
            // ConPTY holds the output pipe open until the console closes. The
            // registry's reader owns `output` and drains it meanwhile.
            let console = closer.lock().unwrap_or_else(|e| e.into_inner()).take();
            drop(console);
            code
        }),
    })
}

fn wait_for_exit(process: &OwnedHandle) -> i64 {
    let mut code = KILLED_EXIT_CODE;
    // SAFETY: `process` is an open process handle and `code` a valid place
    // for its exit code.
    unsafe {
        if WaitForSingleObject(raw(process), INFINITE) == WAIT_OBJECT_0 {
            GetExitCodeProcess(raw(process), &mut code);
        }
    }
    i64::from(code)
}

fn job_holding(process: &OwnedHandle) -> io::Result<OwnedHandle> {
    // SAFETY: null attributes and name ask for a default, unnamed job.
    let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateJobObjectW returned an open handle that nothing else owns.
    let job = unsafe { owned(handle) };
    set_limits(
        &job,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    )?;
    // SAFETY: `job` and `process` are open handles.
    if unsafe { AssignProcessToJobObject(raw(&job), raw(process)) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

/// Stops the job killing what is left in it when it closes.
fn release(job: &OwnedHandle) {
    if let Err(err) = set_limits(job, JOB_OBJECT_LIMIT_BREAKAWAY_OK) {
        tracing::warn!(%err, "could not release a terminal's job");
    }
}

fn set_limits(job: &OwnedHandle, flags: JOB_OBJECT_LIMIT) -> io::Result<()> {
    // SAFETY: the limits struct is plain data; all zeroes means no limits.
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = flags;
    // SAFETY: `job` is open, and `limits` is the struct this information class
    // names, passed with its size.
    let set = unsafe {
        SetInformationJobObject(
            raw(job),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast::<c_void>(),
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if set == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// `PROC_THREAD_ATTRIBUTE_LIST` carrying the pseudo-console, freed on drop.
struct AttributeList {
    buffer: Vec<usize>,
}

impl AttributeList {
    fn with_pseudo_console(console: HPCON) -> io::Result<Self> {
        let mut size = 0;
        // SAFETY: a null list with a count asks only for the size; this call
        // fails by design.
        unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size) };
        let mut list = Self {
            buffer: vec![0; size.div_ceil(mem::size_of::<usize>())],
        };
        // SAFETY: `buffer` holds at least `size` bytes, aligned for the list.
        if unsafe { InitializeProcThreadAttributeList(list.as_mut_ptr(), 1, 0, &mut size) } == 0 {
            // Not initialized, so there is nothing for Drop to delete.
            list.buffer.clear();
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the list is initialized with room for one attribute; the
        // pseudo-console attribute takes the HPCON value itself, which the
        // caller keeps open for as long as the list is used.
        let updated = unsafe {
            UpdateProcThreadAttribute(
                list.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                console as *const c_void,
                mem::size_of::<HPCON>(),
                ptr::null_mut(),
                ptr::null(),
            )
        };
        if updated == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(list)
    }

    fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr().cast()
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if !self.buffer.is_empty() {
            // SAFETY: a non-empty buffer holds an initialized list, deleted once.
            unsafe { DeleteProcThreadAttributeList(self.as_mut_ptr()) };
        }
    }
}

fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let mut read: HANDLE = ptr::null_mut();
    let mut write: HANDLE = ptr::null_mut();
    // SAFETY: `read` and `write` are valid places for the two new handles.
    if unsafe { CreatePipe(&mut read, &mut write, ptr::null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreatePipe succeeded, so both are open handles nothing else owns.
    Ok(unsafe { (owned(read), owned(write)) })
}

/// # Safety
/// `handle` must be open and owned by nothing else.
unsafe fn owned(handle: HANDLE) -> OwnedHandle {
    // SAFETY: guaranteed by the caller.
    unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

/// An HRESULT as an error that reads well: a wrapped Win32 code becomes
/// that code's message, anything else its hex value.
fn check(result: i32) -> io::Result<()> {
    const FACILITY_WIN32: u32 = 0x8007_0000;
    let bits = result as u32;
    match result {
        S_OK => Ok(()),
        _ if bits & 0xFFFF_0000 == FACILITY_WIN32 => {
            Err(io::Error::from_raw_os_error((bits & 0xFFFF) as i32))
        }
        _ => Err(io::Error::other(format!("HRESULT {bits:#010x}"))),
    }
}

/// A NUL would cut a string short in the Win32 call, and in the environment
/// block it would start a variable of its own.
fn reject_nul(spec: &SpawnSpec) -> io::Result<()> {
    let args: Vec<&str> = match &spec.args {
        Args::List(args) => args.iter().map(String::as_str).collect(),
        Args::CommandLine(line) => vec![line.as_str()],
    };
    let cwd = spec.cwd.to_string_lossy();
    let texts = [spec.command.as_str(), cwd.as_ref()]
        .into_iter()
        .chain(args)
        .chain(spec.env.iter().flat_map(|(k, v)| [k.as_str(), v.as_str()]));
    for text in texts {
        if text.contains('\0') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a command, argument, folder or environment entry contains a NUL character",
            ));
        }
    }
    Ok(())
}

fn coord(cols: u16, rows: u16) -> COORD {
    COORD {
        X: i16::try_from(cols).unwrap_or(i16::MAX),
        Y: i16::try_from(rows).unwrap_or(i16::MAX),
    }
}

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain([0]).collect()
}

/// This process's environment with `overlay` on top. Windows compares names
/// case-insensitively and wants the block sorted that way.
fn environment_block(overlay: &[(String, String)]) -> Vec<u16> {
    let mut vars: BTreeMap<String, (OsString, OsString)> = BTreeMap::new();
    let overlay = overlay
        .iter()
        .map(|(key, value)| (OsString::from(key), OsString::from(value)));
    for (key, value) in std::env::vars_os().chain(overlay) {
        vars.insert(key.to_string_lossy().to_uppercase(), (key, value));
    }
    let mut block = Vec::new();
    for (key, value) in vars.values() {
        block.extend(key.encode_wide());
        block.push(u16::from(b'='));
        block.extend(value.encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}
