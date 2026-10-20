#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <winternl.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <string_view>
#include <vector>

// WindowsNativeRealpath.hpp is a native child-local capability boundary. It is
// included by the root-owned Windows DLL wrapper with MSVC C++20, /EHsc and
// static CRT linkage (/MT). The public PODs contain no owned runtime objects:
// input strings are copied synchronously and output writes are synchronous.
// No caller pointer, HANDLE or callback is retained.
namespace opencode_v2::windows_realpath {

struct AnchorV1 {
  const wchar_t* dosPath;
  uint32_t dosChars;
  const wchar_t* ntPath;
  uint32_t ntChars;
  uint64_t volumeSerial;
  uint8_t fileId[16];
};

struct ErrorV1 {
  uint32_t operation;
  uint32_t win32;
  // Failing admission position, or 0xffffffff when the refusal is not tied to
  // one anchor. The child projects only its closed kind through startup.
  uint32_t anchorIndex;
};

enum Status : int32_t {
  OK = 0,
  NOT_APPLICABLE = 1,
  REJECTED = 2,
  CLOSED = 3,
  NATIVE_FAILURE = 4,
};

namespace detail {

enum Operation : uint32_t {
  OperationNone = 0,
  OperationOpenArguments = 1,
  OperationOpenProcessIdentity = 2,
  OperationOpenAnchor = 3,
  OperationOpenAnchorIdentity = 4,
  OperationOpenAnchorComponent = 5,
  OperationOpenDuplicateChild = 6,
  OperationOpenTable = 7,
  OperationResolveArguments = 8,
  OperationResolveContext = 9,
  OperationResolveProcessIdentity = 10,
  OperationResolveInput = 11,
  OperationResolveInputAncestor = 12,
  OperationResolveTarget = 13,
  OperationResolveTargetIdentity = 14,
  OperationResolveDosQuery = 15,
  OperationResolveDosFallback = 16,
  OperationResolveNtQuery = 17,
  OperationResolveAnchorSelection = 18,
  OperationResolveCandidateJoin = 19,
  OperationResolveCandidate = 20,
  OperationResolveCandidateIdentity = 21,
  OperationResolveHeldIdentity = 22,
  OperationResolveOutput = 23,
  OperationCloseContext = 24,
  OperationInternal = 25,
};

constexpr uint32_t kMaxAnchors = 4096;
constexpr uint32_t kMaxStringChars = 32767;
constexpr uint32_t kMaxOutputChars = 32768;
constexpr uint32_t kMaxHeldHandles = 16384;
constexpr uint32_t kMaxContexts = 4096;
constexpr DWORD kFixedQueryCapacity = 32768;

constexpr uint32_t kNoAnchorIndex = 0xffffffffu;

struct Failure {
  Status status = NATIVE_FAILURE;
  Operation operation = OperationNone;
  DWORD win32 = ERROR_SUCCESS;
  uint32_t anchorIndex = kNoAnchorIndex;
};

struct Identity {
  std::wstring ntPath;
  uint64_t volumeSerial = 0;
  uint8_t fileId[16]{};
  bool directory = false;
};

class Handle {
public:
  Handle() noexcept = default;
  explicit Handle(HANDLE value) noexcept : value_(validValue(value) ? value : nullptr) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value_(other.release()) {}
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other)
      reset(other.release());
    return *this;
  }
  ~Handle() noexcept { reset(); }

  HANDLE get() const noexcept { return value_; }
  explicit operator bool() const noexcept { return value_ != nullptr; }
  HANDLE release() noexcept {
    HANDLE result = value_;
    value_ = nullptr;
    return result;
  }
  void reset(HANDLE replacement = nullptr) noexcept {
    HANDLE old = value_;
    value_ = validValue(replacement) ? replacement : nullptr;
    if (old != nullptr)
      CloseHandle(old);
  }

private:
  static bool validValue(HANDLE value) noexcept {
    return value != nullptr && value != INVALID_HANDLE_VALUE;
  }

  HANDLE value_ = nullptr;
};

struct HeldAnchor {
  std::wstring dosPath;
  std::wstring ntPath;
  uint64_t volumeSerial = 0;
  uint8_t fileId[16]{};
  std::vector<Handle> handles;
  std::vector<Identity> identities;
};

struct OpenedPath {
  std::vector<Handle> handles;
  std::vector<Identity> identities;
  const Identity& object() const noexcept { return identities.back(); }
};

enum class CloseState : int32_t {
  Open = 0,
  Closing = 1,
  Closed = 2,
  Unknown = 3,
};

struct Context {
  uint64_t id = 0;
  uint32_t expectedPid = 0;
  uint64_t expectedCreationFiletime = 0;
  std::vector<HeldAnchor> anchors;
  std::mutex callMutex;
  std::atomic<CloseState> closeState{CloseState::Open};
  std::atomic<uint32_t> closeOperation{OperationNone};
  std::atomic<uint32_t> closeWin32{ERROR_SUCCESS};
};

inline void clearError(ErrorV1* error) noexcept {
  if (error != nullptr) {
    error->operation = OperationNone;
    error->win32 = ERROR_SUCCESS;
    error->anchorIndex = kNoAnchorIndex;
  }
}

inline void setError(ErrorV1* error, const Failure& failure) noexcept {
  if (error != nullptr) {
    error->operation = failure.operation;
    error->win32 = failure.win32;
    error->anchorIndex = failure.anchorIndex;
  }
}

inline Failure failure(Status status, Operation operation, DWORD win32) noexcept {
  return Failure{status, operation, win32};
}

inline Failure invalid(Operation operation) noexcept {
  return failure(REJECTED, operation, ERROR_INVALID_PARAMETER);
}

inline Failure denied(Operation operation) noexcept {
  return failure(REJECTED, operation, ERROR_ACCESS_DENIED);
}

inline Failure nativeFailure(Operation operation, DWORD win32) noexcept {
  return failure(NATIVE_FAILURE, operation, win32 == ERROR_SUCCESS ? ERROR_GEN_FAILURE : win32);
}

inline int32_t finishFailure(const Failure& value, ErrorV1* error) noexcept {
  setError(error, value);
  return value.status;
}

inline int32_t allocationFailure(ErrorV1* error) noexcept {
  return finishFailure(nativeFailure(OperationInternal, ERROR_NOT_ENOUGH_MEMORY), error);
}

inline uint64_t filetimeValue(const FILETIME& value) noexcept {
  ULARGE_INTEGER combined{};
  combined.LowPart = value.dwLowDateTime;
  combined.HighPart = value.dwHighDateTime;
  return combined.QuadPart;
}

inline int compareOrdinal(std::wstring_view left, std::wstring_view right,
                          bool ignoreCase) noexcept {
  if (left.size() > static_cast<size_t>(std::numeric_limits<int>::max()) ||
      right.size() > static_cast<size_t>(std::numeric_limits<int>::max()))
    return CSTR_GREATER_THAN;
  return CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(),
                              static_cast<int>(right.size()), ignoreCase ? TRUE : FALSE);
}

inline bool equalOrdinal(std::wstring_view left, std::wstring_view right,
                         bool ignoreCase) noexcept {
  return left.size() == right.size() &&
         compareOrdinal(left, right, ignoreCase) == CSTR_EQUAL;
}

inline bool isPathSeparator(wchar_t value) noexcept {
  return value == L'\\' || value == L'/';
}

inline bool isDriveAbsolute(std::wstring_view path) noexcept {
  return path.size() >= 3 &&
         ((path[0] >= L'A' && path[0] <= L'Z') ||
          (path[0] >= L'a' && path[0] <= L'z')) &&
         path[1] == L':' && isPathSeparator(path[2]);
}

inline std::wstring driveRoot(std::wstring_view path) {
  return std::wstring(path.substr(0, 3));
}

inline bool invalidPathCharacter(wchar_t value, bool allowDriveColon) noexcept {
  if (value < 32)
    return true;
  if (value == L':' && !allowDriveColon)
    return true;
  return value == L'<' || value == L'>' || value == L'"' || value == L'|' ||
         value == L'?' || value == L'*';
}

inline std::vector<std::wstring> splitDos(std::wstring_view path) {
  std::vector<std::wstring> result;
  if (path.size() <= 3)
    return result;
  size_t begin = 3;
  for (size_t index = 3; index <= path.size(); ++index) {
    if (index == path.size() || isPathSeparator(path[index])) {
      if (index > begin)
        result.emplace_back(path.substr(begin, index - begin));
      begin = index + 1;
    }
  }
  return result;
}

inline std::vector<std::wstring> splitNt(std::wstring_view path) {
  std::vector<std::wstring> result;
  size_t begin = 0;
  for (size_t index = 0; index <= path.size(); ++index) {
    if (index == path.size() || path[index] == L'\\') {
      if (index > begin)
        result.emplace_back(path.substr(begin, index - begin));
      begin = index + 1;
    }
  }
  return result;
}

inline bool validateDosComponents(std::wstring_view path, bool canonical) {
  if (!isDriveAbsolute(path))
    return false;
  if (canonical && path.size() != 3 && path.back() == L'\\')
    return false;
  for (size_t index = 0; index < path.size(); ++index) {
    if (invalidPathCharacter(path[index], index == 1))
      return false;
    if (path[index] == L'/' && canonical)
      return false;
  }
  for (const std::wstring& part : splitDos(path)) {
    if (part.empty() || part == L"." || part == L"..")
      return false;
  }
  return true;
}

inline bool validateRawPath(std::wstring_view path) {
  if (path.empty() || path.size() > kMaxStringChars ||
      path.find(L'\0') != std::wstring_view::npos)
    return false;
  if (path[0] == L'\\' || path[0] == L'/')
    return false;

  const bool drive = isDriveAbsolute(path);
  if (path.size() >= 2 && path[1] == L':' && !drive)
    return false;
  for (size_t index = 0; index < path.size(); ++index)
    if (invalidPathCharacter(path[index], drive && index == 1))
      return false;

  const size_t begin = drive ? 3 : 0;
  size_t componentBegin = begin;
  bool sawAny = false;
  for (size_t index = begin; index <= path.size(); ++index) {
    const bool separator = index != path.size() && isPathSeparator(path[index]);
    if (!separator && index != path.size())
      continue;
    const size_t length = index - componentBegin;
    if (length == 0) {
      // Accept one optional trailing separator. Empty internal and leading
      // components remain ambiguous and unsupported.
      if (index != path.size() || componentBegin == begin || !sawAny)
        return false;
    } else {
      const std::wstring_view component = path.substr(componentBegin, length);
      if (component == L"." || component == L"..")
        return false;
      sawAny = true;
    }
    componentBegin = index + 1;
  }
  return true;
}

inline bool validateCanonicalInput(std::wstring_view path) {
  return validateDosComponents(path, true);
}

inline bool validateNtPath(std::wstring_view path) {
  constexpr std::wstring_view prefix = L"\\Device\\";
  if (path.empty() || path.size() > kMaxStringChars ||
      path.find(L'\0') != std::wstring_view::npos ||
      path.size() <= prefix.size() ||
      compareOrdinal(path.substr(0, prefix.size()), prefix, false) != CSTR_EQUAL ||
      path.back() == L'\\')
    return false;
  const std::vector<std::wstring> parts = splitNt(path);
  if (parts.size() < 2 || !equalOrdinal(parts[0], L"Device", false))
    return false;
  for (const std::wstring& part : parts) {
    if (part.empty() || part == L"." || part == L"..")
      return false;
    for (wchar_t value : part)
      if (invalidPathCharacter(value, false))
        return false;
  }
  return true;
}

inline std::wstring joinDos(std::wstring_view anchor, std::wstring_view suffix) {
  std::wstring result(anchor);
  while (result.size() > 3 && result.back() == L'\\')
    result.pop_back();
  if (suffix.empty())
    return result;
  if (!result.empty() && result.back() == L'\\' && suffix.front() == L'\\')
    result.append(suffix.substr(1));
  else
    result.append(suffix);
  return result;
}

inline bool ntPrefixContains(std::wstring_view value, std::wstring_view prefix) noexcept {
  if (value.size() < prefix.size())
    return false;
  if (compareOrdinal(value.substr(0, prefix.size()), prefix, true) != CSTR_EQUAL)
    return false;
  return value.size() == prefix.size() || value[prefix.size()] == L'\\';
}

inline std::wstring_view lastNtComponent(std::wstring_view path) noexcept {
  const size_t slash = path.find_last_of(L'\\');
  return slash == std::wstring_view::npos ? path : path.substr(slash + 1);
}

inline bool tailMatchesDos(std::wstring_view dosPath, std::wstring_view ntPath) {
  const std::vector<std::wstring> dosParts = splitDos(dosPath);
  const std::vector<std::wstring> ntParts = splitNt(ntPath);
  if (dosParts.size() > ntParts.size())
    return false;
  const size_t offset = ntParts.size() - dosParts.size();
  for (size_t index = 0; index < dosParts.size(); ++index)
    if (!equalOrdinal(dosParts[index], ntParts[offset + index], true))
      return false;
  return true;
}

inline bool sameFileId(const uint8_t (&left)[16], const uint8_t (&right)[16]) noexcept {
  return std::memcmp(left, right, 16) == 0;
}

inline bool sameIdentity(const Identity& left, const Identity& right) noexcept {
  return left.volumeSerial == right.volumeSerial &&
         sameFileId(left.fileId, right.fileId) &&
         equalOrdinal(left.ntPath, right.ntPath, false) &&
         left.directory == right.directory;
}

struct FileIdentity {
  uint64_t volumeSerial = 0;
  uint8_t fileId[16]{};
  bool directory = false;
  std::wstring ntPath;
};

// Query buffers are not zero-filled: only the `count` characters written by
// the successful call are read, and each file resolution issues dozens of
// these 64 KiB queries.
inline bool queryNormalizedNt(HANDLE handle, std::wstring& result, DWORD& win32) {
  std::array<wchar_t, kFixedQueryCapacity> buffer;
  SetLastError(ERROR_SUCCESS);
  const DWORD count = GetFinalPathNameByHandleW(
      handle, buffer.data(), static_cast<DWORD>(buffer.size()), VOLUME_NAME_NT);
  win32 = count == 0 ? GetLastError() : ERROR_SUCCESS;
  if (count == 0 || count >= buffer.size())
    return false;
  result.assign(buffer.data(), count);
  return true;
}

inline bool queryNormalizedDos(HANDLE handle, std::wstring& result, DWORD& win32,
                               DWORD& countOut) {
  std::array<wchar_t, kFixedQueryCapacity> buffer;
  SetLastError(ERROR_SUCCESS);
  const DWORD count = GetFinalPathNameByHandleW(
      handle, buffer.data(), static_cast<DWORD>(buffer.size()), VOLUME_NAME_DOS);
  countOut = count;
  win32 = count == 0 ? GetLastError() : ERROR_SUCCESS;
  if (count == 0 || count >= buffer.size())
    return false;
  result.assign(buffer.data(), count);
  return true;
}

inline bool queryFileIdentity(HANDLE handle, FileIdentity& result, Failure& failureOut,
                              Operation stage) {
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag)) == 0)
    return failureOut = nativeFailure(stage, GetLastError()), false;

  FILE_ID_INFO fileId{};
  if (GetFileInformationByHandleEx(handle, FileIdInfo, &fileId, sizeof(fileId)) == 0)
    return failureOut = nativeFailure(stage, GetLastError()), false;

  if (GetFileType(handle) != FILE_TYPE_DISK)
    return failureOut = denied(stage), false;
  if ((tag.FileAttributes & (FILE_ATTRIBUTE_DEVICE | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      tag.ReparseTag != 0)
    return failureOut = denied(stage), false;
  result.volumeSerial = fileId.VolumeSerialNumber;
  std::memcpy(result.fileId, &fileId.FileId, sizeof(result.fileId));
  result.directory = (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if (!queryNormalizedNt(handle, result.ntPath, failureOut.win32))
    return failureOut = nativeFailure(stage, failureOut.win32), false;
  return true;
}

inline bool optionalCanonicalDosMatches(HANDLE handle, std::wstring_view expected,
                                        Failure& failureOut, Operation stage) {
  std::wstring actual;
  DWORD win32 = ERROR_SUCCESS;
  DWORD count = 0;
  if (queryNormalizedDos(handle, actual, win32, count)) {
    std::wstring_view spelling = actual;
    constexpr std::wstring_view extended = L"\\\\?\\";
    if (spelling.size() >= extended.size() &&
        compareOrdinal(spelling.substr(0, extended.size()), extended, true) == CSTR_EQUAL)
      spelling.remove_prefix(extended.size());
    std::wstring normalizedExpected(expected);
    while (normalizedExpected.size() > 3 && normalizedExpected.back() == L'\\')
      normalizedExpected.pop_back();
    std::wstring normalizedActual(spelling);
    while (normalizedActual.size() > 3 && normalizedActual.back() == L'\\')
      normalizedActual.pop_back();
    if (!equalOrdinal(normalizedActual, normalizedExpected, true)) {
      failureOut = denied(stage);
      return false;
    }
    return true;
  }
  if (count == 0) {
    if (win32 == ERROR_ACCESS_DENIED)
      return true;
    failureOut = nativeFailure(stage, win32);
    return false;
  }
  failureOut = nativeFailure(stage, ERROR_INSUFFICIENT_BUFFER);
  return false;
}

using NtCreateFileFunction = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
                                              PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG,
                                              ULONG, ULONG, PVOID, ULONG);
using NtStatusErrorFunction = ULONG(NTAPI*)(NTSTATUS);

struct NativeFileApi {
  NtCreateFileFunction create = nullptr;
  NtStatusErrorFunction statusError = nullptr;
};

inline const NativeFileApi& nativeFileApi() noexcept {
  static const NativeFileApi api = []() noexcept {
    NativeFileApi value;
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll != nullptr) {
      value.create = reinterpret_cast<NtCreateFileFunction>(GetProcAddress(ntdll, "NtCreateFile"));
      value.statusError = reinterpret_cast<NtStatusErrorFunction>(
          GetProcAddress(ntdll, "RtlNtStatusToDosError"));
    }
    return value;
  }();
  return api;
}

constexpr ULONG kObjectCaseInsensitive = 0x00000040;  // OBJ_CASE_INSENSITIVE, as CreateFileW
constexpr ULONG kFileOpen = 0x00000001;               // FILE_OPEN, as OPEN_EXISTING
constexpr ULONG kSynchronousNonAlert = 0x00000020;    // FILE_SYNCHRONOUS_IO_NONALERT
constexpr ULONG kOpenForBackupIntent = 0x00004000;    // FILE_FLAG_BACKUP_SEMANTICS
constexpr ULONG kOpenReparsePoint = 0x00200000;       // FILE_FLAG_OPEN_REPARSE_POINT

// Opens one already validated component relative to the directory HANDLE
// opened and identity-checked just before it. The access, share, disposition
// and options equal the former CreateFileW call. FILE_OPEN_REPARSE_POINT now
// applies to every component because each one is the final name of its own
// open, so no intermediate reparse point is ever traversed by the kernel.
inline bool openRelativeComponent(HANDLE parent, const std::wstring& component, DWORD share,
                                  Operation stage, Handle& result, Failure& failureOut) noexcept {
  const NativeFileApi& api = nativeFileApi();
  if (api.create == nullptr || api.statusError == nullptr)
    return failureOut = nativeFailure(stage, ERROR_PROC_NOT_FOUND), false;
  if (parent == nullptr || component.empty() || component.size() > kMaxStringChars)
    return failureOut = invalid(stage), false;
  UNICODE_STRING name{};
  name.Buffer = const_cast<wchar_t*>(component.data());
  name.Length = static_cast<USHORT>(component.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &name;
  attributes.Attributes = kObjectCaseInsensitive;
  IO_STATUS_BLOCK completion{};
  HANDLE raw = nullptr;
  const NTSTATUS status = api.create(
      &raw, FILE_READ_ATTRIBUTES | SYNCHRONIZE, &attributes, &completion, nullptr, 0, share,
      kFileOpen, kOpenForBackupIntent | kOpenReparsePoint | kSynchronousNonAlert, nullptr, 0);
  Handle handle(raw);
  if (status != 0 || completion.Status != 0 || !handle) {
    const NTSTATUS native = status != 0 ? status : completion.Status;
    const ULONG code = native == 0 ? ERROR_GEN_FAILURE : api.statusError(native);
    failureOut = failure(REJECTED, stage,
                         code == ERROR_SUCCESS ? ERROR_GEN_FAILURE : static_cast<DWORD>(code));
    return false;
  }
  result = std::move(handle);
  return true;
}

// Every opened object keeps the former per-object checks: disk file, no
// device/reparse attribute or tag, FileID and normalized NT path capture,
// directory requirement and the exact expected component name.
inline bool admitOpenedObject(Handle handle, bool requireDirectory,
                              std::wstring_view expectedComponent, Operation objectStage,
                              Operation componentStage, OpenedPath& opened,
                              Failure& failureOut) {
  FileIdentity identity;
  if (!queryFileIdentity(handle.get(), identity, failureOut, objectStage))
    return false;
  if (requireDirectory && !identity.directory)
    return failureOut = invalid(objectStage), false;
  if (!expectedComponent.empty() &&
      !equalOrdinal(lastNtComponent(identity.ntPath), expectedComponent, true))
    return failureOut = denied(componentStage), false;

  opened.handles.emplace_back(std::move(handle));
  Identity retained;
  retained.ntPath = std::move(identity.ntPath);
  retained.volumeSerial = identity.volumeSerial;
  std::memcpy(retained.fileId, identity.fileId, sizeof(retained.fileId));
  retained.directory = identity.directory;
  opened.identities.emplace_back(std::move(retained));
  return true;
}

// Opens each component relative to the held HANDLE of its parent. Only the
// held chain is followed, so a later component cannot be re-routed through a
// changed ancestor name. `parent` must remain open until this call returns.
inline bool openHeldRelativeChain(HANDLE parent, const std::vector<std::wstring>& components,
                                  bool finalDirectory, DWORD finalShare, Operation objectStage,
                                  Operation componentStage, OpenedPath& opened,
                                  Failure& failureOut) {
  if (components.empty() || components.size() > kMaxHeldHandles ||
      opened.handles.size() + components.size() > kMaxHeldHandles)
    return failureOut = invalid(objectStage), false;
  for (size_t index = 0; index < components.size(); ++index) {
    const bool object = index + 1 == components.size();
    const DWORD share = object ? finalShare : (FILE_SHARE_READ | FILE_SHARE_WRITE);
    const Operation stage = object ? objectStage : componentStage;
    Handle handle;
    if (!openRelativeComponent(parent, components[index], share, stage, handle, failureOut))
      return false;
    if (!admitOpenedObject(std::move(handle), !object || finalDirectory, components[index],
                           stage, componentStage, opened, failureOut))
      return false;
    parent = opened.handles.back().get();
  }
  return true;
}

inline bool openCheckedPath(std::wstring_view path, bool finalDirectory, DWORD finalShare,
                            Operation openStage, Operation componentStage,
                            OpenedPath& opened, Failure& failureOut) {
  if (!validateCanonicalInput(path))
    return failureOut = invalid(openStage), false;
  const std::wstring full(path);
  const std::wstring root = driveRoot(full);
  if (GetDriveTypeW(root.c_str()) != DRIVE_FIXED)
    return failureOut = denied(openStage), false;

  const std::vector<std::wstring> parts = splitDos(full);
  const size_t objectCount = parts.size() + 1;
  if (objectCount > kMaxHeldHandles ||
      opened.handles.size() + objectCount > kMaxHeldHandles)
    return failureOut = invalid(openStage), false;

  // Only the drive root is opened by its DOS name. Each later component is
  // opened relative to the component HANDLE opened before it in this chain,
  // instead of re-parsing the whole prefix from the drive root again.
  const bool rootIsObject = objectCount == 1;
  const DWORD rootShare = rootIsObject ? finalShare : (FILE_SHARE_READ | FILE_SHARE_WRITE);
  const std::wstring kernelRoot = L"\\\\?\\" + root;
  HANDLE raw = CreateFileW(kernelRoot.c_str(), FILE_READ_ATTRIBUTES, rootShare, nullptr,
                           OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                           nullptr);
  if (raw == INVALID_HANDLE_VALUE) {
    const DWORD code = GetLastError();
    failureOut = failure(REJECTED, rootIsObject ? openStage : componentStage, code);
    return false;
  }
  if (!admitOpenedObject(Handle(raw), !rootIsObject || finalDirectory, std::wstring_view(),
                         rootIsObject ? openStage : componentStage, componentStage, opened,
                         failureOut))
    return false;
  if (rootIsObject)
    return true;
  return openHeldRelativeChain(opened.handles.back().get(), parts, finalDirectory, finalShare,
                               openStage, componentStage, opened, failureOut);
}

inline bool processIdentityMatches(uint32_t expectedPid, uint64_t expectedCreation,
                                   Failure& failureOut, Operation stage) noexcept {
  if (GetCurrentProcessId() != expectedPid)
    return failureOut = denied(stage), false;
  FILETIME creation{}, exitTime{}, kernel{}, user{};
  if (GetProcessTimes(GetCurrentProcess(), &creation, &exitTime, &kernel, &user) == 0)
    return failureOut = nativeFailure(stage, GetLastError()), false;
  if (filetimeValue(creation) != expectedCreation)
    return failureOut = denied(stage), false;
  return true;
}

inline std::mutex& tableMutex() noexcept {
  static std::mutex mutex;
  return mutex;
}

inline std::map<uint64_t, std::shared_ptr<Context>>& contextTable() noexcept {
  static std::map<uint64_t, std::shared_ptr<Context>> table;
  return table;
}

inline std::atomic<uint64_t>& nextContextId() noexcept {
  static std::atomic<uint64_t> value{1};
  return value;
}

inline bool revalidateAnchor(const HeldAnchor& anchor, Failure& failureOut) {
  if (anchor.handles.size() != anchor.identities.size() || anchor.handles.empty())
    return failureOut = denied(OperationResolveHeldIdentity), false;
  for (size_t index = 0; index < anchor.handles.size(); ++index) {
    FileIdentity held;
    if (!queryFileIdentity(anchor.handles[index].get(), held, failureOut,
                           OperationResolveHeldIdentity))
      return false;
    const Identity& captured = anchor.identities[index];
    if (held.volumeSerial != captured.volumeSerial ||
        !sameFileId(held.fileId, captured.fileId) ||
        !equalOrdinal(held.ntPath, captured.ntPath, false) ||
        held.directory != captured.directory)
      return failureOut = denied(OperationResolveHeldIdentity), false;
  }
  OpenedPath reopened;
  if (!openCheckedPath(anchor.dosPath, true, FILE_SHARE_READ | FILE_SHARE_WRITE,
                       OperationResolveHeldIdentity, OperationResolveHeldIdentity,
                       reopened, failureOut))
    return false;
  if (reopened.identities.size() != anchor.identities.size())
    return failureOut = denied(OperationResolveHeldIdentity), false;
  for (size_t index = 0; index < anchor.identities.size(); ++index)
    if (!sameIdentity(reopened.identities[index], anchor.identities[index]))
      return failureOut = denied(OperationResolveHeldIdentity), false;
  const Identity& root = anchor.identities.back();
  return root.volumeSerial == anchor.volumeSerial &&
         sameFileId(root.fileId, anchor.fileId) &&
         equalOrdinal(root.ntPath, anchor.ntPath, false);
}

inline bool revalidateContext(const Context& context, Failure& failureOut) {
  for (const HeldAnchor& anchor : context.anchors)
    if (!revalidateAnchor(anchor, failureOut))
      return false;
  return true;
}

inline void cleanupContext(Context& context) noexcept {
  bool unknown = false;
  Operation firstOperation = OperationNone;
  DWORD firstError = ERROR_SUCCESS;
  for (HeldAnchor& anchor : context.anchors) {
    for (Handle& handle : anchor.handles) {
      HANDLE raw = handle.release();
      if (raw != nullptr && CloseHandle(raw) == 0) {
        const DWORD code = GetLastError();
        if (!unknown) {
          unknown = true;
          firstOperation = OperationCloseContext;
          firstError = code == ERROR_SUCCESS ? ERROR_GEN_FAILURE : code;
        }
      }
    }
    anchor.handles.clear();
  }
  context.anchors.clear();
  context.closeOperation.store(firstOperation, std::memory_order_release);
  context.closeWin32.store(firstError, std::memory_order_release);
  context.closeState.store(unknown ? CloseState::Unknown : CloseState::Closed,
                           std::memory_order_release);
}

inline int32_t openImpl(uint32_t expectedPid, uint64_t expectedCreationFiletime,
                        const AnchorV1* anchors, uint32_t anchorCount,
                        uint64_t* outContext, ErrorV1* outError) {
  *outContext = 0;
  clearError(outError);
  if (anchors == nullptr || anchorCount == 0 || anchorCount > kMaxAnchors)
    return finishFailure(invalid(OperationOpenArguments), outError);

  Failure failureOut;
  if (!processIdentityMatches(expectedPid, expectedCreationFiletime, failureOut,
                              OperationOpenProcessIdentity))
    return finishFailure(failureOut, outError);

  std::unique_lock<std::mutex> tableLock(tableMutex());
  if (contextTable().size() >= kMaxContexts) {
    tableLock.unlock();
    return finishFailure(nativeFailure(OperationOpenTable, ERROR_TOO_MANY_OPEN_FILES), outError);
  }
  for (const auto& entry : contextTable()) {
    const Context& existing = *entry.second;
    if (existing.expectedPid == expectedPid &&
        existing.expectedCreationFiletime == expectedCreationFiletime) {
      tableLock.unlock();
      return finishFailure(failure(REJECTED, OperationOpenDuplicateChild, ERROR_ALREADY_EXISTS),
                           outError);
    }
  }
  tableLock.unlock();

  std::unique_ptr<Context> context(new (std::nothrow) Context());
  if (!context)
    return allocationFailure(outError);
  context->expectedPid = expectedPid;
  context->expectedCreationFiletime = expectedCreationFiletime;
  size_t projectedHandles = 0;

  for (uint32_t index = 0; index < anchorCount; ++index) {
    // Every anchor-scoped refusal keeps its admission position so the child can
    // name the closed anchor kind without ever leaving a raw path.
    const auto anchored = [&](Failure value) noexcept {
      value.anchorIndex = index;
      return finishFailure(value, outError);
    };
    const AnchorV1& source = anchors[index];
    if (source.dosPath == nullptr || source.ntPath == nullptr ||
        source.dosChars == 0 || source.dosChars > kMaxStringChars ||
        source.ntChars == 0 || source.ntChars > kMaxStringChars)
      return anchored(invalid(OperationOpenArguments));
    if (std::wstring_view(source.dosPath, source.dosChars).find(L'\0') !=
            std::wstring_view::npos ||
        std::wstring_view(source.ntPath, source.ntChars).find(L'\0') !=
            std::wstring_view::npos)
      return anchored(invalid(OperationOpenArguments));

    HeldAnchor anchor;
    anchor.dosPath.assign(source.dosPath, source.dosChars);
    anchor.ntPath.assign(source.ntPath, source.ntChars);
    anchor.volumeSerial = source.volumeSerial;
    std::memcpy(anchor.fileId, source.fileId, sizeof(anchor.fileId));
    if (!validateDosComponents(anchor.dosPath, true) ||
        !validateNtPath(anchor.ntPath) ||
        !tailMatchesDos(anchor.dosPath, anchor.ntPath))
      return anchored(invalid(OperationOpenArguments));
    if (GetDriveTypeW(driveRoot(anchor.dosPath).c_str()) != DRIVE_FIXED)
      return anchored(denied(OperationOpenArguments));

    OpenedPath opened;
    if (!openCheckedPath(anchor.dosPath, true, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         OperationOpenAnchor, OperationOpenAnchorComponent,
                         opened, failureOut))
      return anchored(failureOut);
    projectedHandles += opened.handles.size();
    if (projectedHandles > kMaxHeldHandles)
      return anchored(invalid(OperationOpenArguments));
    const Identity& observed = opened.object();
    if (observed.volumeSerial != anchor.volumeSerial ||
        !sameFileId(observed.fileId, anchor.fileId) ||
        !equalOrdinal(observed.ntPath, anchor.ntPath, false))
      return anchored(failure(REJECTED, OperationOpenAnchorIdentity, ERROR_ACCESS_DENIED));
    if (!optionalCanonicalDosMatches(opened.handles.back().get(), anchor.dosPath,
                                     failureOut, OperationOpenAnchorIdentity))
      return anchored(failureOut);

    for (const HeldAnchor& existing : context->anchors)
      if (existing.volumeSerial == anchor.volumeSerial &&
          sameFileId(existing.fileId, anchor.fileId))
        return anchored(denied(OperationOpenAnchorIdentity));
    anchor.identities = std::move(opened.identities);
    anchor.handles = std::move(opened.handles);
    context->anchors.emplace_back(std::move(anchor));
  }

  tableLock.lock();
  if (contextTable().size() >= kMaxContexts) {
    tableLock.unlock();
    return finishFailure(nativeFailure(OperationOpenTable, ERROR_TOO_MANY_OPEN_FILES), outError);
  }
  for (const auto& entry : contextTable()) {
    const Context& existing = *entry.second;
    if (existing.expectedPid == expectedPid &&
        existing.expectedCreationFiletime == expectedCreationFiletime) {
      tableLock.unlock();
      return finishFailure(failure(REJECTED, OperationOpenDuplicateChild, ERROR_ALREADY_EXISTS),
                           outError);
    }
  }
  const uint64_t rawId = nextContextId().fetch_add(1, std::memory_order_relaxed);
  if (rawId == 0 || rawId == std::numeric_limits<uint64_t>::max()) {
    tableLock.unlock();
    return finishFailure(nativeFailure(OperationOpenTable, ERROR_NO_SYSTEM_RESOURCES), outError);
  }
  context->id = rawId;
  std::shared_ptr<Context> retained(context.release());
  try {
    contextTable().emplace(rawId, retained);
  } catch (...) {
    tableLock.unlock();
    return allocationFailure(outError);
  }
  tableLock.unlock();
  *outContext = rawId;
  return OK;
}

inline std::shared_ptr<Context> lookupContext(uint64_t id) {
  std::lock_guard<std::mutex> lock(tableMutex());
  auto found = contextTable().find(id);
  return found == contextTable().end() ? std::shared_ptr<Context>() : found->second;
}

// Longest held anchor whose canonical DOS path is a strict component prefix
// of the routed input. The prefix is never opened by name on this path, so it
// must be spelled exactly as the anchor that revalidateAnchor reopens; only
// the drive letter is case-insensitive. Any other spelling, drive-root
// anchors and the anchor itself use the complete root walk below.
inline const HeldAnchor* lexicalAnchor(const Context& context,
                                       std::wstring_view routed) noexcept {
  const HeldAnchor* selected = nullptr;
  for (const HeldAnchor& anchor : context.anchors) {
    const std::wstring_view prefix = anchor.dosPath;
    if (prefix.size() <= 3 || routed.size() <= prefix.size() + 1 ||
        routed[prefix.size()] != L'\\' ||
        compareOrdinal(routed.substr(0, 1), prefix.substr(0, 1), true) != CSTR_EQUAL ||
        compareOrdinal(routed.substr(1, prefix.size() - 1), prefix.substr(1), false) != CSTR_EQUAL)
      continue;
    if (selected == nullptr || prefix.size() > selected->dosPath.size())
      selected = &anchor;
  }
  return selected;
}

// Resolves an input inside `anchor` from the anchor's held HANDLE instead of
// opening the input and then its canonical spelling from the drive root.
// The authorizing anchor's complete held/reopened chain is revalidated before
// and after; the target components keep the per-object no-reparse, identity
// and name checks, and the existing DOS-denied and target-identity gates.
// Returns false only when the NT longest-prefix authorization would select a
// different anchor; the caller then uses the complete root walk unchanged.
inline bool resolveFromHeldAnchor(const Context& context, const HeldAnchor& anchor,
                                  const std::wstring& routedPath, wchar_t* output,
                                  uint32_t outputCapacity, uint32_t* outChars, ErrorV1* outError,
                                  int32_t& status) {
  const auto finish = [&](const Failure& value) {
    status = finishFailure(value, outError);
    return true;
  };
  Failure failureOut;
  if (!revalidateAnchor(anchor, failureOut))
    return finish(failureOut);

  std::vector<std::wstring> components;
  const std::wstring_view rest = std::wstring_view(routedPath).substr(anchor.dosPath.size() + 1);
  for (size_t begin = 0, index = 0; index <= rest.size(); ++index) {
    if (index != rest.size() && rest[index] != L'\\')
      continue;
    if (index == begin)
      return finish(invalid(OperationResolveInput));
    components.emplace_back(rest.substr(begin, index - begin));
    begin = index + 1;
  }

  OpenedPath inputPath;
  if (!openHeldRelativeChain(anchor.handles.back().get(), components, false,
                             FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             OperationResolveTarget, OperationResolveInputAncestor, inputPath,
                             failureOut))
    return finish(failureOut);
  const Identity heldTarget = inputPath.object();

  std::wstring dosName;
  DWORD dosWin32 = ERROR_SUCCESS;
  DWORD dosCount = 0;
  if (queryNormalizedDos(inputPath.handles.back().get(), dosName, dosWin32, dosCount))
    return finish(failure(NOT_APPLICABLE, OperationResolveDosQuery, ERROR_SUCCESS));
  if (dosCount != 0)
    return finish(nativeFailure(OperationResolveDosQuery, ERROR_INSUFFICIENT_BUFFER));
  if (dosWin32 != ERROR_ACCESS_DENIED)
    return finish(failure(NOT_APPLICABLE, OperationResolveDosFallback, dosWin32));

  const std::wstring& targetNt = heldTarget.ntPath;
  const HeldAnchor* selected = nullptr;
  for (const HeldAnchor& candidate : context.anchors) {
    if (candidate.volumeSerial != heldTarget.volumeSerial ||
        !ntPrefixContains(targetNt, candidate.ntPath))
      continue;
    if (selected == nullptr || candidate.ntPath.size() > selected->ntPath.size())
      selected = &candidate;
  }
  if (selected == nullptr)
    return finish(denied(OperationResolveAnchorSelection));
  if (selected != &anchor)
    return false;

  const std::wstring suffix = targetNt.substr(anchor.ntPath.size());
  const std::wstring candidatePath = joinDos(anchor.dosPath, suffix);
  if (candidatePath.size() > kMaxStringChars || !validateCanonicalInput(candidatePath) ||
      !equalOrdinal(candidatePath, routedPath, true))
    return finish(invalid(OperationResolveCandidateJoin));
  const size_t candidateChars = candidatePath.size();
  if (candidateChars + 1 > outputCapacity)
    return finish(failure(REJECTED, OperationResolveOutput, ERROR_INSUFFICIENT_BUFFER));

  FileIdentity refreshedTarget;
  if (!queryFileIdentity(inputPath.handles.back().get(), refreshedTarget, failureOut,
                         OperationResolveTargetIdentity))
    return finish(failureOut);
  if (refreshedTarget.volumeSerial != heldTarget.volumeSerial ||
      !sameFileId(refreshedTarget.fileId, heldTarget.fileId) ||
      !equalOrdinal(refreshedTarget.ntPath, heldTarget.ntPath, false))
    return finish(denied(OperationResolveTargetIdentity));
  if (!revalidateAnchor(anchor, failureOut))
    return finish(failureOut);

  std::copy(candidatePath.begin(), candidatePath.end(), output);
  output[candidateChars] = L'\0';
  *outChars = static_cast<uint32_t>(candidateChars);
  status = OK;
  return true;
}

inline int32_t resolveImpl(uint64_t contextId, const wchar_t* input, uint32_t inputChars,
                           wchar_t* output, uint32_t outputCapacity, uint32_t* outChars,
                           ErrorV1* outError) {
  *outChars = 0;
  clearError(outError);
  if (input == nullptr || output == nullptr || inputChars == 0 ||
      inputChars > kMaxStringChars || outputCapacity == 0 ||
      outputCapacity > kMaxOutputChars)
    return finishFailure(invalid(OperationResolveArguments), outError);
  if (std::wstring_view(input, inputChars).find(L'\0') != std::wstring_view::npos)
    return finishFailure(invalid(OperationResolveArguments), outError);

  const std::shared_ptr<Context> context = lookupContext(contextId);
  if (!context)
    return finishFailure(failure(CLOSED, OperationResolveContext, ERROR_INVALID_HANDLE), outError);
  if (context->closeState.load(std::memory_order_acquire) != CloseState::Open)
    return finishFailure(failure(CLOSED, OperationResolveContext, ERROR_INVALID_HANDLE), outError);
  std::lock_guard<std::mutex> callLock(context->callMutex);
  if (context->closeState.load(std::memory_order_acquire) != CloseState::Open)
    return finishFailure(failure(CLOSED, OperationResolveContext, ERROR_INVALID_HANDLE), outError);

  Failure failureOut;
  if (!processIdentityMatches(context->expectedPid, context->expectedCreationFiletime,
                              failureOut, OperationResolveProcessIdentity))
    return finishFailure(failureOut, outError);

  const std::wstring rawInput(input, inputChars);
  if (!validateRawPath(rawInput))
    return finishFailure(invalid(OperationResolveInput), outError);
  std::array<wchar_t, kMaxOutputChars> routed;  // Only routedCount characters are read.
  const DWORD routedCount = GetFullPathNameW(
      rawInput.c_str(), static_cast<DWORD>(routed.size()), routed.data(), nullptr);
  if (routedCount == 0)
    return finishFailure(nativeFailure(OperationResolveInput, GetLastError()), outError);
  if (routedCount >= routed.size())
    return finishFailure(nativeFailure(OperationResolveInput, ERROR_INSUFFICIENT_BUFFER), outError);
  const std::wstring routedPath(routed.data(), routedCount);
  if (!validateCanonicalInput(routedPath))
    return finishFailure(invalid(OperationResolveInput), outError);

  if (const HeldAnchor* lexical = lexicalAnchor(*context, routedPath)) {
    int32_t status = NATIVE_FAILURE;
    if (resolveFromHeldAnchor(*context, *lexical, routedPath, output, outputCapacity, outChars,
                              outError, status))
      return status;
  }

  OpenedPath inputPath;
  if (!openCheckedPath(routedPath, false, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       OperationResolveTarget, OperationResolveInputAncestor,
                       inputPath, failureOut))
    return finishFailure(failureOut, outError);
  const Identity heldTarget = inputPath.object();

  std::wstring dosName;
  DWORD dosWin32 = ERROR_SUCCESS;
  DWORD dosCount = 0;
  const bool dosAvailable = queryNormalizedDos(inputPath.handles.back().get(), dosName, dosWin32,
                                                dosCount);
  if (dosAvailable) {
    return finishFailure(failure(NOT_APPLICABLE, OperationResolveDosQuery, ERROR_SUCCESS),
                         outError);
  }
  if (dosCount != 0)
    return finishFailure(nativeFailure(OperationResolveDosQuery, ERROR_INSUFFICIENT_BUFFER),
                         outError);
  if (dosWin32 != ERROR_ACCESS_DENIED)
    return finishFailure(failure(NOT_APPLICABLE, OperationResolveDosFallback, dosWin32), outError);

  const std::wstring& targetNt = heldTarget.ntPath;

  const HeldAnchor* selected = nullptr;
  for (const HeldAnchor& anchor : context->anchors) {
    if (anchor.volumeSerial != heldTarget.volumeSerial ||
        !ntPrefixContains(targetNt, anchor.ntPath))
      continue;
    if (selected == nullptr || anchor.ntPath.size() > selected->ntPath.size())
      selected = &anchor;
  }
  if (selected == nullptr)
    return finishFailure(denied(OperationResolveAnchorSelection), outError);

  // Only this longest-prefix anchor authorizes the result. Revalidate its
  // complete held/reopened chain before and after target identity checks;
  // unrelated anchors do not authorize this path.
  if (!revalidateAnchor(*selected, failureOut))
    return finishFailure(failureOut, outError);

  const std::wstring suffix = targetNt.substr(selected->ntPath.size());
  const std::wstring candidatePath = joinDos(selected->dosPath, suffix);
  if (candidatePath.size() > kMaxStringChars || !validateCanonicalInput(candidatePath))
    return finishFailure(invalid(OperationResolveCandidateJoin), outError);
  const size_t candidateChars = candidatePath.size();
  if (candidateChars + 1 > outputCapacity)
    return finishFailure(failure(REJECTED, OperationResolveOutput, ERROR_INSUFFICIENT_BUFFER),
                         outError);

  OpenedPath candidate;
  if (!openCheckedPath(candidatePath, heldTarget.directory,
                       FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       OperationResolveCandidate, OperationResolveInputAncestor,
                       candidate, failureOut))
    return finishFailure(failureOut, outError);
  const Identity& candidateIdentity = candidate.object();
  if (candidateIdentity.volumeSerial != heldTarget.volumeSerial ||
      !sameFileId(candidateIdentity.fileId, heldTarget.fileId))
    return finishFailure(denied(OperationResolveCandidateIdentity), outError);

  FileIdentity refreshedTarget;
  if (!queryFileIdentity(inputPath.handles.back().get(), refreshedTarget, failureOut,
                         OperationResolveTargetIdentity))
    return finishFailure(failureOut, outError);

  if (refreshedTarget.volumeSerial != heldTarget.volumeSerial ||
      !sameFileId(refreshedTarget.fileId, heldTarget.fileId) ||
      !equalOrdinal(refreshedTarget.ntPath, heldTarget.ntPath, false))
    return finishFailure(denied(OperationResolveTargetIdentity), outError);
  if (!revalidateAnchor(*selected, failureOut))
    return finishFailure(failureOut, outError);

  std::copy(candidatePath.begin(), candidatePath.end(), output);
  output[candidateChars] = L'\0';
  *outChars = static_cast<uint32_t>(candidateChars);
  return OK;
}

inline int32_t closeImpl(uint64_t contextId, ErrorV1* outError) {
  clearError(outError);
  const std::shared_ptr<Context> context = lookupContext(contextId);
  if (!context)
    return finishFailure(failure(REJECTED, OperationCloseContext, ERROR_INVALID_HANDLE), outError);

  CloseState state = context->closeState.load(std::memory_order_acquire);
  if (state == CloseState::Closed)
    return OK;
  if (state == CloseState::Unknown) {
    return finishFailure(nativeFailure(
                             static_cast<Operation>(
                                 context->closeOperation.load(std::memory_order_acquire)),
                             context->closeWin32.load(std::memory_order_acquire)),
                         outError);
  }

  if (state == CloseState::Open) {
    CloseState expected = CloseState::Open;
    if (!context->closeState.compare_exchange_strong(expected, CloseState::Closing,
                                                     std::memory_order_acq_rel)) {
      state = expected;
      if (state == CloseState::Closed)
        return OK;
      if (state == CloseState::Unknown)
        return finishFailure(nativeFailure(
                                 static_cast<Operation>(
                                     context->closeOperation.load(std::memory_order_acquire)),
                                 context->closeWin32.load(std::memory_order_acquire)),
                             outError);
    }
  }

  std::lock_guard<std::mutex> callLock(context->callMutex);
  state = context->closeState.load(std::memory_order_acquire);
  if (state == CloseState::Closed)
    return OK;
  if (state == CloseState::Unknown)
    return finishFailure(nativeFailure(
                             static_cast<Operation>(
                                 context->closeOperation.load(std::memory_order_acquire)),
                             context->closeWin32.load(std::memory_order_acquire)),
                         outError);
  cleanupContext(*context);
  if (context->closeState.load(std::memory_order_acquire) == CloseState::Unknown)
    return finishFailure(nativeFailure(
                             static_cast<Operation>(
                                 context->closeOperation.load(std::memory_order_acquire)),
                             context->closeWin32.load(std::memory_order_acquire)),
                         outError);
  return OK;
}

}  // namespace detail

inline int32_t OpenV1(uint32_t expectedPid, uint64_t expectedCreationFiletime,
                      const AnchorV1* anchors, uint32_t anchorCount,
                      uint64_t* outContext, ErrorV1* outError) noexcept {
  if (outContext != nullptr)
    *outContext = 0;
  if (outContext == nullptr || outError == nullptr)
    return detail::finishFailure(
        detail::invalid(detail::OperationOpenArguments), outError);
  *outContext = 0;
  try {
    return detail::openImpl(expectedPid, expectedCreationFiletime, anchors, anchorCount,
                            outContext, outError);
  } catch (const std::bad_alloc&) {
    *outContext = 0;
    return detail::allocationFailure(outError);
  } catch (...) {
    *outContext = 0;
    return detail::finishFailure(
        detail::nativeFailure(detail::OperationInternal, ERROR_UNHANDLED_EXCEPTION), outError);
  }
}

inline int32_t ResolveV1(uint64_t context, const wchar_t* input, uint32_t inputChars,
                         wchar_t* output, uint32_t outputCapacity, uint32_t* outChars,
                         ErrorV1* outError) noexcept {
  if (outChars != nullptr)
    *outChars = 0;
  if (outChars == nullptr || outError == nullptr)
    return detail::finishFailure(
        detail::invalid(detail::OperationResolveArguments), outError);
  *outChars = 0;
  try {
    return detail::resolveImpl(context, input, inputChars, output, outputCapacity,
                               outChars, outError);
  } catch (const std::bad_alloc&) {
    *outChars = 0;
    return detail::allocationFailure(outError);
  } catch (...) {
    *outChars = 0;
    return detail::finishFailure(
        detail::nativeFailure(detail::OperationInternal, ERROR_UNHANDLED_EXCEPTION), outError);
  }
}

inline int32_t CloseV1(uint64_t context, ErrorV1* outError) noexcept {
  if (outError == nullptr)
    return NATIVE_FAILURE;
  try {
    return detail::closeImpl(context, outError);
  } catch (const std::bad_alloc&) {
    return detail::allocationFailure(outError);
  } catch (...) {
    return detail::finishFailure(
        detail::nativeFailure(detail::OperationInternal, ERROR_UNHANDLED_EXCEPTION), outError);
  }
}

#if defined(_M_X64) || defined(_M_ARM64)
static_assert(sizeof(wchar_t) == 2, "WindowsNativeRealpath ABI requires UTF-16 wchar_t");
static_assert(sizeof(void*) == 8, "WindowsNativeRealpath ABI targets x64/arm64");
static_assert(sizeof(AnchorV1) == 56, "AnchorV1 ABI layout changed");
static_assert(alignof(AnchorV1) == 8, "AnchorV1 ABI alignment changed");
static_assert(offsetof(AnchorV1, dosPath) == 0, "AnchorV1 dosPath offset changed");
static_assert(offsetof(AnchorV1, dosChars) == 8, "AnchorV1 dosChars offset changed");
static_assert(offsetof(AnchorV1, ntPath) == 16, "AnchorV1 ntPath offset changed");
static_assert(offsetof(AnchorV1, ntChars) == 24, "AnchorV1 ntChars offset changed");
static_assert(offsetof(AnchorV1, volumeSerial) == 32, "AnchorV1 volumeSerial offset changed");
static_assert(offsetof(AnchorV1, fileId) == 40, "AnchorV1 fileId offset changed");
static_assert(sizeof(ErrorV1) == 8, "ErrorV1 ABI layout changed");
static_assert(alignof(ErrorV1) == 4, "ErrorV1 ABI alignment changed");
static_assert(offsetof(ErrorV1, operation) == 0, "ErrorV1 operation offset changed");
static_assert(offsetof(ErrorV1, win32) == 4, "ErrorV1 win32 offset changed");
#endif

}  // namespace opencode_v2::windows_realpath
