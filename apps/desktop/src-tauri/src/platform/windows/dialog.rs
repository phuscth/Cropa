//! Native file dialogs and "show in folder" through the Windows Shell.
//!
//! Every call runs on its own short-lived thread that initialises COM as a
//! single-threaded apartment and tears it down again, so it never inherits (or
//! changes) the COM state of the Tokio worker that called it.

use std::ffi::{OsString, c_void};
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use ::windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
use ::windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize, IBindCtx,
};
use ::windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use ::windows::Win32::UI::Shell::{
    FOS_FORCEFILESYSTEM, FOS_NOREADONLYRETURN, FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST,
    FOS_PICKFOLDERS, FileOpenDialog, FileSaveDialog, IFileDialog, IFileOpenDialog, IFileSaveDialog,
    ILCreateFromPathW, ILFree, IShellItem, SHCreateItemFromParsingName, SHOpenFolderAndSelectItems,
    SIGDN_FILESYSPATH,
};
use ::windows::core::{HRESULT, HSTRING, PCWSTR};

use super::super::{OwnerWindow, PlatformError, Result, SaveFileType};

fn os_error(err: &::windows::core::Error) -> PlatformError {
    PlatformError::Os(err.to_string())
}

/// Run `work` on a fresh thread with COM initialised as an STA.
fn on_sta_thread<T: Send>(work: impl FnOnce() -> Result<T> + Send) -> Result<T> {
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                // SAFETY: first COM call on a thread nothing else has used.
                let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
                if init.is_err() {
                    return Err(os_error(&::windows::core::Error::from(init)));
                }
                // Every COM object `work` creates is dropped before it returns.
                let result = work();
                // SAFETY: balances the successful CoInitializeEx above.
                unsafe { CoUninitialize() };
                result
            })
            .join()
            .unwrap_or_else(|_| Err(PlatformError::Os("the dialog thread panicked".into())))
    })
}

fn owner_hwnd(owner: Option<OwnerWindow>) -> Option<HWND> {
    owner.map(|window| HWND(window.0 as *mut c_void))
}

fn is_cancelled(err: &::windows::core::Error) -> bool {
    err.code() == HRESULT::from_win32(ERROR_CANCELLED.0)
}

/// Open `dialog` at `folder` when it is an existing directory; otherwise leave
/// the choice to Windows.
fn start_in_folder(dialog: &IFileDialog, folder: Option<&Path>) {
    let Some(folder) = folder.filter(|f| f.is_dir()) else {
        return;
    };
    let path = HSTRING::from(folder.as_os_str());
    // SAFETY: `path` is null-terminated and outlives both calls; `dialog` is a live COM object.
    unsafe {
        if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(&path, None::<&IBindCtx>)
        {
            let _ = dialog.SetFolder(&item);
        }
    }
}

/// The file-system path of the dialog's result.
fn result_path(dialog: &IFileDialog) -> Result<PathBuf> {
    // SAFETY: `dialog` is live and was shown successfully; the PWSTR returned by
    // GetDisplayName is owned by us and freed with CoTaskMemFree after copying.
    unsafe {
        let item = dialog.GetResult().map_err(|e| os_error(&e))?;
        let name = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|e| os_error(&e))?;
        let path = PathBuf::from(OsString::from_wide(name.as_wide()));
        CoTaskMemFree(Some(name.0.cast_const().cast()));
        Ok(path)
    }
}

/// Show `dialog`; `Ok(false)` when the user cancelled.
fn show(dialog: &IFileDialog, owner: Option<OwnerWindow>) -> Result<bool> {
    // SAFETY: `dialog` is a live COM object on its own STA thread; the owner is a
    // window handle the command layer took from a live Tauri window (a stale one
    // only makes Show fail).
    match unsafe { dialog.Show(owner_hwnd(owner)) } {
        Ok(()) => Ok(true),
        Err(err) if is_cancelled(&err) => Ok(false),
        Err(err) => Err(os_error(&err)),
    }
}

pub fn pick_folder(
    owner: Option<OwnerWindow>,
    title: &str,
    start_in: Option<&Path>,
) -> Result<Option<PathBuf>> {
    on_sta_thread(|| {
        let title = HSTRING::from(title);
        // SAFETY: COM is initialised on this thread; `title` outlives the calls.
        let dialog: IFileOpenDialog =
            unsafe { CoCreateInstance(&FileOpenDialog, None, CLSCTX_ALL) }
                .map_err(|e| os_error(&e))?;
        let dialog: IFileDialog = dialog.into();
        // SAFETY: as above.
        unsafe {
            let options = dialog.GetOptions().map_err(|e| os_error(&e))?;
            dialog
                .SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)
                .map_err(|e| os_error(&e))?;
            dialog.SetTitle(&title).map_err(|e| os_error(&e))?;
        }
        start_in_folder(&dialog, start_in);
        if !show(&dialog, owner)? {
            return Ok(None);
        }
        result_path(&dialog).map(Some)
    })
}

pub fn pick_save_path(
    owner: Option<OwnerWindow>,
    title: &str,
    types: &[SaveFileType<'_>],
    initial_type: usize,
    file_name: &str,
    start_in: Option<&Path>,
) -> Result<Option<(PathBuf, usize)>> {
    let initial_type = initial_type.min(types.len().saturating_sub(1));
    on_sta_thread(|| {
        let title = HSTRING::from(title);
        let file_name = HSTRING::from(file_name);
        let names: Vec<HSTRING> = types.iter().map(|t| HSTRING::from(t.label)).collect();
        let specs: Vec<HSTRING> = types
            .iter()
            .map(|t| HSTRING::from(format!("*.{}", t.extension)))
            .collect();
        let filters: Vec<COMDLG_FILTERSPEC> = names
            .iter()
            .zip(&specs)
            .map(|(name, spec)| COMDLG_FILTERSPEC {
                pszName: PCWSTR(name.as_ptr()),
                pszSpec: PCWSTR(spec.as_ptr()),
            })
            .collect();
        let default_ext = HSTRING::from(types.get(initial_type).map_or("", |t| t.extension));

        // SAFETY: COM is initialised on this thread; every string and the filter
        // list borrow HSTRINGs that live until the end of this closure.
        let dialog: IFileSaveDialog =
            unsafe { CoCreateInstance(&FileSaveDialog, None, CLSCTX_ALL) }
                .map_err(|e| os_error(&e))?;
        let dialog: IFileDialog = dialog.into();
        // SAFETY: as above.
        unsafe {
            let options = dialog.GetOptions().map_err(|e| os_error(&e))?;
            dialog
                .SetOptions(
                    options
                        | FOS_OVERWRITEPROMPT
                        | FOS_FORCEFILESYSTEM
                        | FOS_NOREADONLYRETURN
                        | FOS_PATHMUSTEXIST,
                )
                .map_err(|e| os_error(&e))?;
            dialog.SetTitle(&title).map_err(|e| os_error(&e))?;
            dialog.SetFileTypes(&filters).map_err(|e| os_error(&e))?;
            // The index is 1-based.
            dialog
                .SetFileTypeIndex(u32::try_from(initial_type + 1).unwrap_or(1))
                .map_err(|e| os_error(&e))?;
            dialog
                .SetDefaultExtension(&default_ext)
                .map_err(|e| os_error(&e))?;
            dialog.SetFileName(&file_name).map_err(|e| os_error(&e))?;
        }
        start_in_folder(&dialog, start_in);
        if !show(&dialog, owner)? {
            return Ok(None);
        }
        // SAFETY: the dialog was confirmed and is still live.
        let chosen = unsafe { dialog.GetFileTypeIndex() }.map_err(|e| os_error(&e))?;
        let chosen = usize::try_from(chosen).unwrap_or(1).saturating_sub(1);
        Ok(Some((
            result_path(&dialog)?,
            chosen.min(types.len().saturating_sub(1)),
        )))
    })
}

pub fn reveal_file(path: &Path) -> Result<()> {
    on_sta_thread(|| {
        let wide = HSTRING::from(path.as_os_str());
        // SAFETY: `wide` is null-terminated and outlives the call. The PIDL is
        // checked for null, used only while valid, and freed exactly once.
        unsafe {
            let pidl = ILCreateFromPathW(&wide);
            if pidl.is_null() {
                return Err(PlatformError::Os(
                    "Windows could not find the file".to_owned(),
                ));
            }
            // With no child items, the item itself is selected in its folder.
            let shown = SHOpenFolderAndSelectItems(pidl, None, 0);
            ILFree(Some(pidl));
            shown.map_err(|e| os_error(&e))
        }
    })
}
