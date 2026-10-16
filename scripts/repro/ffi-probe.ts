try {
  const ffi = await import('bun:ffi')
  console.log('keys', Object.keys(ffi).join(','))
  const lib = ffi.dlopen('kernel32.dll', { GetCurrentProcessId: { args: [], returns: ffi.FFIType.u32 } })
  console.log('pid', lib.symbols.GetCurrentProcessId(), process.pid)
} catch (error) { console.log('FFI-ERROR', error instanceof Error ? `${error.name}: ${error.message}` : String(error)) }
