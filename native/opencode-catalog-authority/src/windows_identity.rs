use std::fs::File;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
};

/// Return the stable Windows object identity of an already-open handle.
pub(super) fn file_identity(file: &File) -> Result<(u64, u64), ()> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(());
    }
    Ok((
        information.dwVolumeSerialNumber as u64,
        ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
    ))
}
