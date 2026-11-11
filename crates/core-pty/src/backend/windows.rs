//! ConPTY, driven directly.
//!
//! `portable-pty` builds the command line itself and quotes every argument,
//! so the `/c "…"` line an npm shim's sign-in needs reaches `cmd.exe` wrapped
//! in a second layer of quotes it cannot read. Here the command line is
//! exactly what `cmdline::command_line` returns.
//!
//! The process starts suspended inside a job object that kills everything in
//! it when its last handle closes. A kill terminates the job, which ends the
//! whole tree the way `taskkill /T /F` did, and nothing outlives the core.
#![allow(unsafe_code)]

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString, c_void};
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::sync::{Arc, Mutex};
use std::{mem, ptr};

use windows_sys::Win32::Foundation::{HANDLE, S_OK, WAIT_OBJECT_0};
use windows_sys::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION,
    ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

use super::cmdline::command_line;
use super::{Process, SpawnSpec, Spawned};

/// The exit code a killed tree reports, as `taskkill /F` gave it.
const KILLED_EXIT_CODE: u32 = 1;

struct PseudoConsole(HPCON);

impl Drop for PseudoConsole {
    fn drop(&mut self) {
        unsafe { ClosePseudoConsole(self.0) };
    }
}

struct WindowsProcess {
    console: Arc<Mutex<Option<PseudoConsole>>>,
    job: OwnedHandle,
}

impl Process for WindowsProcess {
    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let console = self.console.lock().unwrap_or_else(|e| e.into_inner());
        match console.as_ref() {
            Some(console) => check(unsafe { ResizePseudoConsole(console.0, coord(cols, rows)) }),
            None => Ok(()),
        }
    }

    fn kill(&self) {
        unsafe { TerminateJobObject(raw(&self.job), KILLED_EXIT_CODE) };
    }
}

pub fn spawn(spec: SpawnSpec) -> io::Result<Spawned> {
    let (input_read, input_write) = pipe()?;
    let (output_read, output_write) = pipe()?;
    let mut handle: HPCON = 0;
    check(unsafe {
        CreatePseudoConsole(
            coord(spec.cols, spec.rows),
            raw(&input_read),
            raw(&output_write),
            0,
            &mut handle,
        )
    })?;
    let console = PseudoConsole(handle);
    // The console host holds its own duplicates of these ends.
    drop(input_read);
    drop(output_write);

    let mut attributes = AttributeList::with_pseudo_console(console.0)?;
    let mut startup: STARTUPINFOEXW = unsafe { mem::zeroed() };
    startup.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
    // Otherwise a child inherits whatever this process's stdio is redirected
    // to instead of writing to the console (microsoft/terminal#4380).
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.lpAttributeList = attributes.as_mut_ptr();

    let mut line = wide(OsStr::new(&command_line(&spec.command, &spec.args)));
    let environment = environment_block(&spec.env);
    let cwd = wide(spec.cwd.as_os_str());
    let mut info: PROCESS_INFORMATION = unsafe { mem::zeroed() };
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
    let process = unsafe { owned(info.hProcess) };
    let thread = unsafe { owned(info.hThread) };

    let job = match job_holding(&process) {
        Ok(job) => job,
        Err(error) => {
            unsafe { TerminateProcess(raw(&process), KILLED_EXIT_CODE) };
            return Err(error);
        }
    };
    if unsafe { ResumeThread(raw(&thread)) } == u32::MAX {
        let error = io::Error::last_os_error();
        unsafe { TerminateJobObject(raw(&job), KILLED_EXIT_CODE) };
        return Err(error);
    }
    drop(thread);

    let console = Arc::new(Mutex::new(Some(console)));
    let closer = Arc::clone(&console);
    Ok(Spawned {
        process: Arc::new(WindowsProcess { console, job }),
        input: Box::new(File::from(input_write)),
        output: Box::new(File::from(output_read)),
        wait: Box::new(move || {
            let code = wait_for_exit(&process);
            // ConPTY holds the output pipe open until the console closes.
            let console = closer.lock().unwrap_or_else(|e| e.into_inner()).take();
            drop(console);
            code
        }),
    })
}

fn wait_for_exit(process: &OwnedHandle) -> i64 {
    let mut code = KILLED_EXIT_CODE;
    unsafe {
        if WaitForSingleObject(raw(process), INFINITE) == WAIT_OBJECT_0 {
            GetExitCodeProcess(raw(process), &mut code);
        }
    }
    i64::from(code)
}

fn job_holding(process: &OwnedHandle) -> io::Result<OwnedHandle> {
    let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { owned(handle) };
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let set = unsafe {
        SetInformationJobObject(
            raw(&job),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast::<c_void>(),
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if set == 0 || unsafe { AssignProcessToJobObject(raw(&job), raw(process)) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

/// `PROC_THREAD_ATTRIBUTE_LIST` carrying the pseudo-console, freed on drop.
struct AttributeList {
    buffer: Vec<usize>,
}

impl AttributeList {
    fn with_pseudo_console(console: HPCON) -> io::Result<Self> {
        let mut size = 0;
        // Fails by design: it only reports the size the list needs.
        unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size) };
        let mut list = Self {
            buffer: vec![0; size.div_ceil(mem::size_of::<usize>())],
        };
        if unsafe { InitializeProcThreadAttributeList(list.as_mut_ptr(), 1, 0, &mut size) } == 0 {
            list.buffer.clear();
            return Err(io::Error::last_os_error());
        }
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
            unsafe { DeleteProcThreadAttributeList(self.as_mut_ptr()) };
        }
    }
}

fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let mut read: HANDLE = ptr::null_mut();
    let mut write: HANDLE = ptr::null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, ptr::null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (owned(read), owned(write)) })
}

/// # Safety
/// `handle` must be open and owned by nothing else.
unsafe fn owned(handle: HANDLE) -> OwnedHandle {
    unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

fn check(result: i32) -> io::Result<()> {
    if result == S_OK {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(result))
    }
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
