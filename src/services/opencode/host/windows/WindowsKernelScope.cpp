#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <aclapi.h>
#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <sddl.h>
#include <string>
#include <thread>
#include <userenv.h>
#include <vector>
#include <windows.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/base.h>
#include <winternl.h>
using namespace winrt::Windows::Data::Json;
static constexpr size_t CONTROL_PACKET_LIMIT = 16 * 1024 * 1024;
struct NativeError {
  std::string code;
  DWORD win32 = 0;
  const char *stage = nullptr;
  DWORD nativeStatus = 0;
};
static void require(bool value, const char *code) {
  if (!value)
    throw NativeError{code};
}
struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE v) : value(v) {}
  Handle(const Handle &) = delete;
  Handle &operator=(const Handle &) = delete;
  Handle(Handle &&other) noexcept : value(other.value) { other.value = nullptr; }
  Handle &operator=(Handle &&other) noexcept {
    if (this != &other) {
      reset();
      value = other.value;
      other.value = nullptr;
    }
    return *this;
  }
  ~Handle() { reset(); }
  void reset() {
    if (value && value != INVALID_HANDLE_VALUE)
      CloseHandle(value);
    value = nullptr;
  }
  explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
};
struct LocalMemory {
  void *value = nullptr;
  bool freeSid = false;
  ~LocalMemory() {
    if (value) {
      if (freeSid)
        FreeSid(value);
      else
        LocalFree(value);
    }
  }
};
static std::wstring wide(const std::string &value) {
  if (value.empty())
    return {};
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                              static_cast<int>(value.size()), nullptr, 0);
  require(n > 0, "execution_invalid_response");
  std::wstring out(n, 0);
  require(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                              static_cast<int>(value.size()), out.data(), n) == n,
          "execution_invalid_response");
  return out;
}
static std::string narrow(const std::wstring &value) {
  if (value.empty())
    return {};
  int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                              static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  require(n > 0, "execution_invalid_response");
  std::string out(n, 0);
  require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                              static_cast<int>(value.size()), out.data(), n, nullptr, nullptr) == n,
          "execution_invalid_response");
  return out;
}
static std::wstring text(const JsonObject &object, const wchar_t *key) {
  require(object.HasKey(key) && object.GetNamedValue(key).ValueType() == JsonValueType::String,
          "execution_invalid_response");
  auto value = std::wstring(object.GetNamedString(key));
  require(value.find(L'\0') == std::wstring::npos, "execution_invalid_response");
  return value;
}
static JsonObject object(const JsonObject &value, const wchar_t *key) {
  require(value.HasKey(key) && value.GetNamedValue(key).ValueType() == JsonValueType::Object,
          "execution_invalid_response");
  return value.GetNamedObject(key);
}
static void str(JsonObject &object, const wchar_t *key, const std::wstring &value) {
  object.SetNamedValue(key, JsonValue::CreateStringValue(value));
}
static void num(JsonObject &object, const wchar_t *key, std::uint64_t value) {
  require(value <= 9007199254740991ULL, "execution_invalid_response");
  object.SetNamedValue(key, JsonValue::CreateNumberValue(static_cast<double>(value)));
}
static void flag(JsonObject &object, const wchar_t *key, bool value) {
  object.SetNamedValue(key, JsonValue::CreateBooleanValue(value));
}
static std::wstring decimal(std::uint64_t value) { return std::to_wstring(value); }
static std::uint64_t filetime(FILETIME value) {
  return (static_cast<std::uint64_t>(value.dwHighDateTime) << 32) | value.dwLowDateTime;
}
static JsonObject birth(HANDLE process) {
  FILETIME creation{}, exit{}, kernel{}, user{};
  require(GetProcessTimes(process, &creation, &exit, &kernel, &user) != 0,
          "execution_identity_mismatch");
  JsonObject value;
  str(value, L"format", L"windows-filetime");
  str(value, L"value", decimal(filetime(creation)));
  value.SetNamedValue(L"bootId", JsonValue::CreateNullValue());
  return value;
}
static std::wstring image(HANDLE process) {
  std::vector<wchar_t> bytes(32768);
  DWORD count = static_cast<DWORD>(bytes.size());
  require(QueryFullProcessImageNameW(process, 0, bytes.data(), &count) != 0,
          "execution_identity_mismatch");
  return std::wstring(bytes.data(), count);
}
static JsonObject identity(HANDLE process, DWORD pid) {
  JsonObject value;
  num(value, L"hostPID", pid);
  num(value, L"nativePID", pid);
  value.SetNamedValue(L"birth", birth(process));
  str(value, L"executablePath", image(process));
  return value;
}
static std::wstring extended(const std::wstring &value) {
  require(value.size() >= 3 && value[1] == L':' && value[2] == L'\\' &&
              value.find(L"\\..") == std::wstring::npos &&
              value.find(L"\\.\\") == std::wstring::npos,
          "execution_path_alias");
  return L"\\\\?\\" + value;
}
static std::wstring finalPath(HANDLE file, DWORD volume = VOLUME_NAME_DOS) {
  std::vector<wchar_t> bytes(32768);
  DWORD count = GetFinalPathNameByHandleW(file, bytes.data(), static_cast<DWORD>(bytes.size()),
                                          FILE_NAME_NORMALIZED | volume);
  require(count > 0 && count < bytes.size(), "execution_path_alias");
  return std::wstring(bytes.data(), count);
}
static bool equalPath(const std::wstring &a, const std::wstring &b) {
  return CompareStringOrdinal(a.data(), static_cast<int>(a.size()), b.data(),
                              static_cast<int>(b.size()), TRUE) == CSTR_EQUAL;
}
static std::wstring currentSid() {
  Handle token;
  HANDLE raw = nullptr;
  require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw) != 0, "execution_owner_unknown");
  token = Handle(raw);
  DWORD size = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
  std::vector<BYTE> bytes(size);
  require(GetTokenInformation(token.value, TokenUser, bytes.data(), size, &size) != 0,
          "execution_owner_unknown");
  LPWSTR value = nullptr;
  require(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER *>(bytes.data())->User.Sid, &value) !=
              0,
          "execution_owner_unknown");
  LocalMemory memory{value};
  return value;
}
static bool privateAcl(HANDLE file, const std::wstring &owner, PSID selectedPackage = nullptr) {
  PACL acl = nullptr;
  PSID ownerSid = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  require(GetSecurityInfo(file, SE_FILE_OBJECT,
                          OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &ownerSid,
                          nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS,
          "execution_owner_unknown");
  LocalMemory memory{descriptor};
  require(acl && ownerSid, "execution_owner_unknown");
  LPWSTR ownerString = nullptr;
  require(ConvertSidToStringSidW(ownerSid, &ownerString) != 0, "execution_owner_unknown");
  LocalMemory ownerMemory{ownerString};
  require(owner == ownerString, "execution_owner_not_private");
  for (DWORD i = 0; i < acl->AceCount; i++) {
    void *raw = nullptr;
    require(GetAce(acl, i, &raw) != 0, "execution_owner_unknown");
    auto header = reinterpret_cast<ACE_HEADER *>(raw);
    if (header->AceType == ACCESS_DENIED_ACE_TYPE)
      continue; // Denies add no external access, including the private package deny.
    require(header->AceType == ACCESS_ALLOWED_ACE_TYPE, "execution_owner_not_private");
    auto ace = reinterpret_cast<ACCESS_ALLOWED_ACE *>(raw);
    LPWSTR trustee = nullptr;
    require(ConvertSidToStringSidW(&ace->SidStart, &trustee) != 0, "execution_owner_unknown");
    LocalMemory trusteeMemory{trustee};
    require(owner == trustee || std::wstring(trustee) == L"S-1-5-18" ||
                (selectedPackage && EqualSid(&ace->SidStart, selectedPackage)),
            "execution_owner_not_private");
  }
  return true;
}
static JsonObject fileIdentity(HANDLE file, const std::wstring &owner, bool directory,
                               PSID selectedPackage = nullptr) {
  FILE_ID_INFO id{};
  FILE_ATTRIBUTE_TAG_INFO tag{};
  FILE_STANDARD_INFO standard{};
  require(GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id)) &&
              GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) &&
              GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)),
          "execution_owner_unknown");
  require(!(tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
              !!standard.Directory == directory && standard.NumberOfLinks == 1,
          "execution_owner_alias");
  privateAcl(file, owner, selectedPackage);
  static const wchar_t hex[] = L"0123456789abcdef";
  std::wstring fileId;
  for (BYTE byte : id.FileId.Identifier) {
    fileId += hex[byte >> 4];
    fileId += hex[byte & 15];
  }
  JsonObject value;
  str(value, L"volumeSerial", decimal(id.VolumeSerialNumber));
  str(value, L"fileId", fileId);
  str(value, L"ownerSid", owner);
  return value;
}
static Handle canonicalDirectory(const std::wstring &value,
                                 DWORD access = FILE_READ_ATTRIBUTES | READ_CONTROL) {
  auto full = extended(value);
  Handle handle(CreateFileW(full.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                            OPEN_EXISTING,
                            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!handle)
    throw NativeError{"execution_owner_unknown", GetLastError(), "owner_canonical_open"};
  FILE_ATTRIBUTE_TAG_INFO tag{};
  require(GetFileInformationByHandleEx(handle.value, FileAttributeTagInfo, &tag, sizeof(tag)) &&
              (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
              !(tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
              equalPath(finalPath(handle.value), full),
          "execution_path_alias");
  return handle;
}
static std::vector<Handle> ancestors(const std::wstring &path) {
  require(path.size() >= 3 && GetDriveTypeW(path.substr(0, 3).c_str()) == DRIVE_FIXED,
          "execution_owner_local_volume_required");
  std::vector<Handle> values;
  values.push_back(canonicalDirectory(path.substr(0, 3)));
  for (size_t i = 3; i < path.size(); i++)
    if (path[i] == L'\\')
      values.push_back(canonicalDirectory(path.substr(0, i)));
  return values;
}
// Physical admission is independent of owner-private ACL qualification: vendor
// roots may be shared, but every retained component must remain the same object.
static JsonObject anchorIdentity(HANDLE file) {
  FILE_ID_INFO id{};
  FILE_ATTRIBUTE_TAG_INFO tag{};
  FILE_STANDARD_INFO standard{};
  require(GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id)) &&
              GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) &&
              GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)) &&
              standard.Directory && !(tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT),
          "execution_path_alias");
  static const wchar_t hex[] = L"0123456789abcdef";
  std::wstring fileId;
  for (BYTE byte : id.FileId.Identifier) {
    fileId += hex[byte >> 4];
    fileId += hex[byte & 15];
  }
  JsonObject value;
  str(value, L"volumeSerial", decimal(id.VolumeSerialNumber));
  str(value, L"fileId", fileId);
  str(value, L"dosPath", finalPath(file));
  auto nt = finalPath(file, VOLUME_NAME_NT);
  require(nt.rfind(L"\\Device\\", 0) == 0, "execution_path_alias");
  str(value, L"ntPath", nt);
  return value;
}
struct RetainedAnchorComponent {
  Handle handle;
  std::wstring path;
  JsonObject identity;
  explicit RetainedAnchorComponent(Handle owned)
      : handle(std::move(owned)), identity(anchorIdentity(handle.value)) {
    auto dos = text(identity, L"dosPath");
    require(dos.rfind(L"\\\\?\\", 0) == 0, "execution_path_alias");
    path = dos.substr(4);
  }
  void assertLive() const {
    require(anchorIdentity(handle.value).Stringify() == identity.Stringify(),
            "execution_path_alias");
    auto reopened = canonicalDirectory(path);
    require(anchorIdentity(reopened.value).Stringify() == identity.Stringify(),
            "execution_path_alias");
  }
};
struct RetainedRealpathAnchor {
  std::wstring kind, path;
  std::vector<RetainedAnchorComponent> components;
  RetainedRealpathAnchor(const std::wstring &root, const std::wstring &accessKind,
                         std::vector<Handle> parents)
      : kind(accessKind), path(root) {
    for (auto &parent : parents)
      components.emplace_back(std::move(parent));
    components.emplace_back(canonicalDirectory(root));
  }
  void assertLive() const {
    for (const auto &component : components)
      component.assertLive();
  }
  JsonObject receipt() const {
    require(!components.empty(), "execution_path_alias");
    auto value = JsonObject::Parse(components.back().identity.Stringify());
    // Child path mapping uses ordinary DOS syntax; its NT suffix retains case.
    str(value, L"dosPath", components.back().path);
    str(value, L"admittedPath", path);
    str(value, L"kind", kind);
    return value;
  }
};
static std::string base64(const std::vector<BYTE> &bytes) {
  static const char *alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (size_t i = 0; i < bytes.size(); i += 3) {
    unsigned v = static_cast<unsigned>(bytes[i]) << 16;
    if (i + 1 < bytes.size())
      v |= static_cast<unsigned>(bytes[i + 1]) << 8;
    if (i + 2 < bytes.size())
      v |= bytes[i + 2];
    out += alphabet[(v >> 18) & 63];
    out += alphabet[(v >> 12) & 63];
    out += i + 1 < bytes.size() ? alphabet[(v >> 6) & 63] : '=';
    out += i + 2 < bytes.size() ? alphabet[v & 63] : '=';
  }
  return out;
}
static std::vector<BYTE> unbase64(const std::wstring &value) {
  require(value.size() % 4 == 0 && value.size() <= 21848, "execution_owner_unknown");
  std::vector<BYTE> out;
  auto digit = [](wchar_t c) -> int {
    if (c >= L'A' && c <= L'Z')
      return c - L'A';
    if (c >= L'a' && c <= L'z')
      return c - L'a' + 26;
    if (c >= L'0' && c <= L'9')
      return c - L'0' + 52;
    if (c == L'+')
      return 62;
    if (c == L'/')
      return 63;
    return -1;
  };
  for (size_t i = 0; i < value.size(); i += 4) {
    int a = digit(value[i]), b = digit(value[i + 1]),
        c = value[i + 2] == L'=' ? 0 : digit(value[i + 2]),
        d = value[i + 3] == L'=' ? 0 : digit(value[i + 3]);
    require(a >= 0 && b >= 0 && c >= 0 && d >= 0 &&
                (i + 4 == value.size() || (value[i + 2] != L'=' && value[i + 3] != L'=')) &&
                !(value[i + 2] == L'=' && value[i + 3] != L'='),
            "execution_owner_unknown");
    unsigned v = (a << 18) | (b << 12) | (c << 6) | d;
    out.push_back(static_cast<BYTE>(v >> 16));
    if (value[i + 2] != L'=')
      out.push_back(static_cast<BYTE>(v >> 8));
    if (value[i + 3] != L'=')
      out.push_back(static_cast<BYTE>(v));
  }
  require(out.size() <= 16384, "execution_owner_unknown");
  return out;
}
using NtCreateFileFunction = NTSTATUS(NTAPI *)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
                                               PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG,
                                               ULONG, ULONG, PVOID, ULONG);
using NtQueryFileFunction = NTSTATUS(NTAPI *)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG,
                                              FILE_INFORMATION_CLASS);
// Native FileRenameInformation(10) accepts the already-held source HANDLE
// and a basename relative to the already-held parent HANDLE. No path reopen,
// no replace flag, no post-failure alternate rename are involved.
using NtSetFileFunction = NTSTATUS(NTAPI *)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG,
                                            FILE_INFORMATION_CLASS);
using NtStatusErrorFunction = ULONG(NTAPI *)(NTSTATUS);
static_assert(sizeof(void *) == 8 && offsetof(FILE_RENAME_INFO, RootDirectory) == 8 &&
                  offsetof(FILE_RENAME_INFO, FileNameLength) == 16 &&
                  offsetof(FILE_RENAME_INFO, FileName) == 20,
              "x64/arm64 native FILE_RENAME_INFORMATION ABI");
static DWORD directoryMode(HANDLE file) {
  auto query = reinterpret_cast<NtQueryFileFunction>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationFile"));
  require(query != nullptr, "execution_owner_unknown");
  IO_STATUS_BLOCK status{};
  DWORD mode = 0;
  require(query(file, &status, &mode, sizeof(mode), static_cast<FILE_INFORMATION_CLASS>(16)) >= 0 &&
              (mode & 2) != 0,
          "execution_owner_write_through_pending");
  wchar_t filesystem[64]{};
  require(
      GetVolumeInformationByHandleW(file, nullptr, 0, nullptr, nullptr, nullptr, filesystem, 64) &&
          std::wstring(filesystem) == L"NTFS",
      "execution_owner_ntfs_required");
  return mode;
}
static Handle ownerDirectory(const std::wstring &path, bool create, const std::wstring &owner) {
  auto createFile = reinterpret_cast<NtCreateFileFunction>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
  require(createFile != nullptr, "execution_owner_unknown");
  LocalMemory descriptor;
  if (create) {
    // Newly created private directories preserve trusted owner access in child files.
    // Existing project ACLs and explicit private record descriptors are unchanged.
    std::wstring sddl = L"O:" + owner + L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + owner + L")";
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                                 &descriptor.value, nullptr) != 0,
            "execution_owner_unknown");
  }
  auto checked = extended(path);
  std::wstring native = L"\\??\\" + path;
  require(native.size() <= 32760, "execution_owner_path_invalid");
  UNICODE_STRING name{};
  name.Buffer = native.data();
  name.Length = static_cast<USHORT>(native.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.ObjectName = &name;
  attributes.Attributes = 0x40;
  attributes.SecurityDescriptor = descriptor.value;
  IO_STATUS_BLOCK status{};
  HANDLE raw = nullptr;
  NTSTATUS result = createFile(
      &raw,
      FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE | (create ? DELETE : 0),
      &attributes, &status, nullptr, FILE_ATTRIBUTE_DIRECTORY,
      FILE_SHARE_READ | FILE_SHARE_WRITE | (create ? 0 : FILE_SHARE_DELETE), create ? 2 : 1,
      0x1 | 0x2 | 0x20 | 0x200000, nullptr, 0);
  if (result != 0 || status.Status != 0) {
    auto statusError = reinterpret_cast<NtStatusErrorFunction>(
        GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
    auto native = result != 0 ? result : status.Status;
    throw NativeError{"execution_owner_unknown", statusError ? statusError(native) : 0,
                      create ? "owner_directory_create" : "owner_directory_open",
                      static_cast<DWORD>(native)};
  }
  Handle handle(raw);
  require(equalPath(finalPath(handle.value), checked), "execution_path_alias");
  directoryMode(handle.value);
  fileIdentity(handle.value, owner, true);
  return handle;
}
struct OwnerDirectory {
  Handle file;
  std::vector<Handle> parents;
  std::wstring path, owner;
  JsonObject identity;
  bool writable = false;
};
struct SelectedProfileDirectory {
  Handle file;
  std::vector<Handle> ancestors;
  std::wstring path;
  JsonObject identity;
};
struct SelectedProfile {
  Handle root, parent, database;
  std::vector<Handle> ancestors;
  std::wstring rootPath, parentPath, databasePath, owner;
  JsonObject rootIdentity, parentIdentity, databaseIdentity;
  std::vector<SelectedProfileDirectory> directories;
  std::vector<std::wstring> admittedDirectories;
};
struct OwnerStore {
  std::map<std::wstring, OwnerDirectory> directories;
  std::map<std::wstring, SelectedProfile> selectedProfiles;
  // This SID is assigned only from the helper's own private kernel Scope,
  // never from a request. Temporary grants to that contained package preserve
  // the selected profile identity; no other package principal is admitted.
  PSID selectedPackage = nullptr;
  std::uint64_t next = 0;
  Handle holdSelectedDirectory(const std::wstring &path) {
    for (auto &entry : directories) {
      if (!equalPath(entry.second.path, path))
        continue;
      require(equalPath(finalPath(entry.second.file.value), extended(path)) &&
                  fileIdentity(entry.second.file.value, entry.second.owner, true).Stringify() ==
                      entry.second.identity.Stringify(),
              "execution_owner_unknown");
      HANDLE duplicate = nullptr;
      require(DuplicateHandle(GetCurrentProcess(), entry.second.file.value, GetCurrentProcess(),
                              &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS) != 0,
              "execution_owner_unknown");
      return Handle(duplicate);
    }
    return canonicalDirectory(path, FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL);
  }
  std::pair<Handle, std::wstring> createSpool(const JsonObject &input, const std::wstring &nonce) {
    for (auto root : input.GetNamedArray(L"protectedRoots")) {
      require(root.ValueType() == JsonValueType::String, "execution_owner_unknown");
      std::wstring selected(root.GetString());
      for (auto &entry : directories) {
        auto &directory = entry.second;
        if (!directory.writable || !equalPath(directory.path, selected))
          continue;
        require(equalPath(finalPath(directory.file.value), extended(directory.path)) &&
                    fileIdentity(directory.file.value, directory.owner, true).Stringify() ==
                        directory.identity.Stringify(),
                "execution_owner_unknown");
        auto path = directory.path + L"\\native-stdio-" + nonce;
        return {ownerDirectory(path, true, directory.owner), path};
      }
    }
    throw NativeError{"execution_native_stdio_owner_unknown"};
  }
  JsonObject validateSelectedProfile(const JsonObject &input) {
    auto root = text(input, L"root"), database = text(input, L"databasePath");
    require(database.size() > root.size() + 1 && equalPath(database.substr(0, root.size()), root) &&
                database[root.size()] == L'\\',
            "execution_database_alias");
    auto parent = database.substr(0, database.find_last_of(L'\\'));
    std::vector<std::wstring> admitted;
    for (auto name :
         {L"home", L"config", L"data", L"cache", L"state", L"tmp", L"appdata", L"localappdata"})
      admitted.push_back(root + L"\\" + name);
    require(input.HasKey(L"directories") && input.GetNamedArray(L"directories").Size() <= 64,
            "execution_profile_changed");
    for (auto item : input.GetNamedArray(L"directories")) {
      require(item.ValueType() == JsonValueType::String, "execution_profile_changed");
      std::wstring path(item.GetString());
      require(path == root ||
                  (path.size() > root.size() + 1 && equalPath(path.substr(0, root.size()), root) &&
                   path[root.size()] == L'\\'),
              "execution_profile_changed");
      if (std::find(admitted.begin(), admitted.end(), path) == admitted.end())
        admitted.push_back(path);
    }
    auto key = root + L"|" + database;
    auto found = selectedProfiles.find(key);
    if (found == selectedProfiles.end()) {
      SelectedProfile value;
      value.owner = currentSid();
      value.rootPath = root;
      value.parentPath = parent;
      value.databasePath = database;
      value.ancestors = ancestors(database);
      value.root = holdSelectedDirectory(root);
      value.parent = holdSelectedDirectory(parent);
      value.rootIdentity = fileIdentity(value.root.value, value.owner, true, selectedPackage);
      value.parentIdentity = fileIdentity(value.parent.value, value.owner, true, selectedPackage);
      value.admittedDirectories = admitted;
      for (const auto &path : admitted) {
        SelectedProfileDirectory directory;
        directory.path = path;
        directory.ancestors = ancestors(path);
        directory.file = holdSelectedDirectory(path);
        directory.identity = fileIdentity(directory.file.value, value.owner, true, selectedPackage);
        value.directories.push_back(std::move(directory));
      }
      wchar_t filesystem[64]{};
      require(GetVolumeInformationByHandleW(value.root.value, nullptr, 0, nullptr, nullptr, nullptr,
                                            filesystem, 64) &&
                  std::wstring(filesystem) == L"NTFS",
              "execution_owner_ntfs_required");
      found = selectedProfiles.emplace(key, std::move(value)).first;
    }
    auto &selected = found->second;
    require(
        equalPath(finalPath(selected.root.value), extended(root)) &&
            equalPath(finalPath(selected.parent.value), extended(parent)) &&
            fileIdentity(selected.root.value, selected.owner, true, selectedPackage).Stringify() ==
                selected.rootIdentity.Stringify() &&
            fileIdentity(selected.parent.value, selected.owner, true, selectedPackage)
                    .Stringify() == selected.parentIdentity.Stringify(),
        "execution_owner_unknown");
    if (!selected.database) {
      Handle file(CreateFileW(extended(database).c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
                              FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                              FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      if (!file)
        require(GetLastError() == ERROR_FILE_NOT_FOUND, "execution_database_alias");
      else {
        require(equalPath(finalPath(file.value), extended(database)), "execution_database_alias");
        selected.databaseIdentity =
            fileIdentity(file.value, selected.owner, false, selectedPackage);
        selected.database = std::move(file);
      }
    } else
      require(equalPath(finalPath(selected.database.value), extended(database)) &&
                  fileIdentity(selected.database.value, selected.owner, false, selectedPackage)
                          .Stringify() == selected.databaseIdentity.Stringify(),
              "execution_database_alias");
    JsonObject result;
    num(result, L"schema", 1);
    flag(result, L"ok", true);
    str(result, L"root", root);
    str(result, L"databasePath", database);
    result.SetNamedValue(L"rootIdentity", selected.rootIdentity);
    result.SetNamedValue(L"parentIdentity", selected.parentIdentity);
    if (selected.database)
      result.SetNamedValue(L"databaseIdentity", selected.databaseIdentity);
    else
      result.SetNamedValue(L"databaseIdentity", JsonValue::CreateNullValue());
    flag(result, L"privateAcl", true);
    flag(result, L"reparse", false);
    str(result, L"filesystem", L"NTFS");
    return result;
  }
  JsonObject describe(OwnerDirectory &directory) {
    JsonObject result;
    num(result, L"schema", 1);
    flag(result, L"ok", true);
    str(result, L"path", directory.path);
    result.SetNamedValue(L"identity", directory.identity);
    flag(result, L"privateAcl", true);
    flag(result, L"reparse", false);
    flag(result, L"directory", true);
    num(result, L"nativeFileMode", directoryMode(directory.file.value));
    str(result, L"filesystem", L"NTFS");
    return result;
  }
  JsonObject open(const JsonObject &input) {
    auto path = text(input, L"path"), owner = currentSid();
    bool create = input.GetNamedBoolean(L"createExclusive", false);
    auto parents = ancestors(path);
    require(!parents.empty(), "execution_owner_path_invalid");
    auto parentPath = path.substr(0, path.find_last_of(L'\\'));
    Handle targetParent;
    // Existing creator capabilities already hold DELETE and deny sharing it.
    // A duplicate references that same kernel file object without another open
    // or a share-mode relaxation; its original traversal right is preserved.
    for (auto &entry : directories) {
      if (!equalPath(entry.second.path, parentPath))
        continue;
      require(equalPath(finalPath(entry.second.file.value), extended(parentPath)) &&
                  fileIdentity(entry.second.file.value, owner, true).Stringify() ==
                      entry.second.identity.Stringify(),
              "execution_owner_unknown");
      HANDLE duplicate = nullptr;
      if (!DuplicateHandle(GetCurrentProcess(), entry.second.file.value, GetCurrentProcess(),
                           &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS))
        throw NativeError{"execution_owner_unknown", GetLastError(), "owner_parent_duplicate"};
      targetParent = Handle(duplicate);
      break;
    }
    if (!targetParent)
      targetParent =
          canonicalDirectory(parentPath, FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL);
    parents.back() = std::move(targetParent);
    auto file = ownerDirectory(path, create, owner);
    auto id = fileIdentity(file.value, owner, true);
    auto key = decimal(++next);
    OwnerDirectory held{std::move(file), std::move(parents), path, owner, id, create};
    auto inserted = directories.emplace(key, std::move(held));
    auto result = describe(inserted.first->second);
    str(result, L"handleId", key);
    return result;
  }
  OwnerDirectory &held(const JsonObject &input) {
    auto it = directories.find(text(input, L"handleId"));
    require(it != directories.end(), "execution_owner_unknown");
    auto &directory = it->second;
    require(equalPath(finalPath(directory.file.value), extended(directory.path)) &&
                fileIdentity(directory.file.value, directory.owner, true).Stringify() ==
                    directory.identity.Stringify(),
            "execution_owner_unknown");
    directoryMode(directory.file.value);
    return directory;
  }
  JsonObject request(const std::wstring &operation, const JsonObject &input) {
    if (operation == L"ownerValidateSelectedProfile")
      return validateSelectedProfile(input);
    if (operation == L"ownerOpenDirectory")
      return open(input);
    // Close remains possible after identity/mutation uncertainty. It only drops
    // this native capability and never erases or adopts an acquisition fence.
    if (operation == L"ownerCloseDirectory") {
      auto it = directories.find(text(input, L"handleId"));
      require(it != directories.end(), "execution_owner_unknown");
      directories.erase(it);
      JsonObject result;
      num(result, L"schema", 1);
      flag(result, L"ok", true);
      flag(result, L"closed", true);
      return result;
    }
    auto &directory = held(input);
    auto result = describe(directory);
    if (operation == L"ownerAssertDirectory") {
      require(equalPath(text(input, L"path"), directory.path), "execution_owner_unknown");
      return result;
    }
    if (operation == L"ownerArchive") {
      require(directory.writable, "execution_owner_read_only");
      auto source = text(input, L"source"), destination = text(input, L"destination");
      require(source == directory.path && destination.rfind(source + L".released.", 0) == 0 &&
                  destination.size() == source.size() + 10 + 36,
              "execution_owner_path_invalid");
      auto basename = destination.substr(destination.find_last_of(L'\\') + 1);
      require(basename.find_first_of(L"\\/:\0") == std::wstring::npos && !directory.parents.empty(),
              "execution_owner_path_invalid");
      // The exact DELETE-capable original handle denies external rename/deletion.
      // Its native FILE_WRITE_THROUGH mode is queried above, never assumed.
      size_t size = sizeof(FILE_RENAME_INFO) + basename.size() * sizeof(wchar_t);
      std::vector<BYTE> bytes(size);
      auto rename = reinterpret_cast<FILE_RENAME_INFO *>(bytes.data());
      rename->ReplaceIfExists = FALSE;
      rename->RootDirectory = directory.parents.back().value;
      rename->FileNameLength = static_cast<DWORD>(basename.size() * sizeof(wchar_t));
      memcpy(rename->FileName, basename.data(), rename->FileNameLength);
      rename->FileName[basename.size()] = L'\0';
      auto set = reinterpret_cast<NtSetFileFunction>(
          GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtSetInformationFile"));
      auto statusError = reinterpret_cast<NtStatusErrorFunction>(
          GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
      require(set && statusError, "execution_owner_archive_unknown");
      IO_STATUS_BLOCK completion{};
      NTSTATUS status = set(directory.file.value, &completion, rename, static_cast<ULONG>(size),
                            static_cast<FILE_INFORMATION_CLASS>(10));
      if (status != 0 || completion.Status != 0)
        throw NativeError{"execution_owner_archive_unknown",
                          statusError(status != 0 ? status : completion.Status),
                          "owner_archive_nt_rename",
                          static_cast<DWORD>(status != 0 ? status : completion.Status)};
      directory.path = destination;
      require(equalPath(finalPath(directory.file.value), extended(destination)),
              "execution_owner_archive_path_mismatch");
      require(fileIdentity(directory.file.value, directory.owner, true).Stringify() ==
                  directory.identity.Stringify(),
              "execution_owner_archive_identity_mismatch");
      auto reopened = ownerDirectory(destination, false, directory.owner);
      require(fileIdentity(reopened.value, directory.owner, true).Stringify() ==
                  directory.identity.Stringify(),
              "execution_owner_archive_reopen_identity_mismatch");
      result = describe(directory);
      flag(result, L"writeThrough", true);
      flag(result, L"noReplace", true);
      str(result, L"primitive", L"NtSetInformationFile/FileRenameInformation");
      return result;
    }
    auto name = text(input, L"name");
    require(name == L"owner.json" || name == L"child.json" || name == L"containment.json" ||
                name == L"release.json",
            "execution_owner_unknown");
    auto target = extended(directory.path + L"\\" + name);
    if (operation == L"ownerWriteExclusive") {
      require(directory.writable, "execution_owner_read_only");
      auto data = unbase64(text(input, L"bytesBase64"));
      LocalMemory descriptor;
      std::wstring sddl =
          L"O:" + directory.owner + L"D:P(A;;FA;;;SY)(A;;FA;;;" + directory.owner + L")";
      require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                                   &descriptor.value, nullptr) != 0,
              "execution_owner_unknown");
      SECURITY_ATTRIBUTES sa{sizeof(sa), descriptor.value, FALSE};
      Handle file(CreateFileW(target.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                              FILE_SHARE_READ, &sa, CREATE_NEW,
                              FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      require(static_cast<bool>(file), "execution_owner_unknown");
      fileIdentity(file.value, directory.owner, false);
      DWORD written = 0;
      require(
          WriteFile(file.value, data.data(), static_cast<DWORD>(data.size()), &written, nullptr) &&
              written == data.size() && FlushFileBuffers(file.value),
          "execution_owner_unknown");
      num(result, L"writtenBytes", written);
      flag(result, L"flushed", true);
    } else if (operation == L"ownerReadRecord") {
      double limit = input.GetNamedNumber(L"maxBytes");
      require(limit > 0 && limit <= 16384 && limit == static_cast<DWORD>(limit),
              "execution_owner_unknown");
      Handle file(CreateFileW(target.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr,
                              OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      require(static_cast<bool>(file), "execution_owner_unknown");
      fileIdentity(file.value, directory.owner, false);
      LARGE_INTEGER size{};
      require(GetFileSizeEx(file.value, &size) && size.QuadPart >= 0 && size.QuadPart <= limit,
              "execution_owner_unknown");
      std::vector<BYTE> data(static_cast<size_t>(size.QuadPart));
      DWORD read = 0;
      require(ReadFile(file.value, data.data(), static_cast<DWORD>(data.size()), &read, nullptr) &&
                  read == data.size(),
              "execution_owner_unknown");
      str(result, L"bytesBase64", wide(base64(data)));
    } else
      throw NativeError{"execution_invalid_response"};
    num(result, L"links", 1);
    flag(result, L"reparse", false);
    flag(result, L"privateAcl", true);
    return result;
  }
};
static std::mutex outputMutex;
static void output(JsonObject value) {
  std::lock_guard<std::mutex> lock(outputMutex);
  std::cout << narrow(std::wstring(value.Stringify())) << '\n' << std::flush;
}
static void event(const wchar_t *name, JsonObject value) {
  JsonObject packet;
  num(packet, L"schema", 1);
  str(packet, L"kind", L"event");
  str(packet, L"event", name);
  packet.SetNamedValue(L"value", value);
  output(packet);
}
static std::wstring quote(const std::wstring &value) {
  std::wstring out = L"\"";
  unsigned slashes = 0;
  for (wchar_t c : value) {
    if (c == L'\\') {
      slashes++;
      continue;
    }
    if (c == L'\"') {
      out.append(slashes * 2 + 1, L'\\');
      out += c;
    } else {
      out.append(slashes, L'\\');
      out += c;
    }
    slashes = 0;
  }
  out.append(slashes * 2, L'\\');
  return out + L"\"";
}
struct AttributeList {
  std::vector<BYTE> bytes;
  bool initialized = false;
  explicit AttributeList(DWORD count) {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, count, 0, &size);
    require(GetLastError() == ERROR_INSUFFICIENT_BUFFER && size > 0 && size <= 65536,
            "execution_containment_unavailable");
    bytes.resize(size);
    require(InitializeProcThreadAttributeList(get(), count, 0, &size) != 0,
            "execution_containment_unavailable");
    initialized = true;
  }
  ~AttributeList() {
    if (initialized)
      DeleteProcThreadAttributeList(get());
  }
  LPPROC_THREAD_ATTRIBUTE_LIST get() {
    return reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(bytes.data());
  }
  void set(DWORD_PTR key, void *value, SIZE_T size) {
    require(UpdateProcThreadAttribute(get(), 0, key, value, size, nullptr, nullptr) != 0,
            "execution_containment_unavailable");
  }
};
#include "WindowsNativeCommand.hpp"
struct Scope;
static void removeGrants(Scope &scope);
struct Scope {
  Handle job, process, thread, pipe, cancel, spool, inputFile, outputFile, errorFile;
  std::unique_ptr<NativeCommandStore> commands;
  LocalMemory sid, network, pipeDescriptor;
  std::wstring profile, pipeName, cwd;
  DWORD pid = 0;
  JsonObject mapping;
  std::atomic<bool> stopping{false};
  std::thread reader;
  std::mutex pipeMutex;
  std::vector<std::wstring> aclRoots;
  std::vector<RetainedRealpathAnchor> realpathAnchors;
  void assertRealpathAnchorsLive() const {
    require(!stopping, "execution_identity_mismatch");
    for (const auto &anchor : realpathAnchors)
      anchor.assertLive();
  }
  ~Scope() {
    stopping = true;
    if (cancel)
      SetEvent(cancel.value);
    if (pipe)
      CancelIoEx(pipe.value, nullptr);
    if (job)
      TerminateJobObject(job.value, 99);
    if (process)
      WaitForSingleObject(process.value, 5000);
    if (reader.joinable())
      reader.join();
    commands.reset();
    inputFile.reset();
    outputFile.reset();
    errorFile.reset();
    spool.reset();
    process.reset();
    pipe.reset();
    bool empty = false;
    try {
      empty = !job || active() == 0;
      if (empty)
        removeGrants(*this);
    } catch (...) {
      empty = false;
    }
    job.reset();
    if (empty && !profile.empty())
      DeleteAppContainerProfile(profile.c_str());
  }
  DWORD active() {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
    require(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &info,
                                      sizeof(info), nullptr) != 0,
            "cleanup_unknown");
    return info.ActiveProcesses;
  }
  bool exited() { return WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0; }
  bool completeIo(OVERLAPPED &overlap, DWORD &transferred, DWORD timeout) {
    HANDLE events[] = {overlap.hEvent, cancel.value, process.value};
    DWORD waited = WaitForMultipleObjects(3, events, FALSE, timeout);
    if (waited == WAIT_OBJECT_0)
      return GetOverlappedResult(pipe.value, &overlap, &transferred, FALSE) != 0;

    // CancelIoEx requests cancellation; it does not establish completion. Keep
    // the OVERLAPPED, event and caller buffer alive until the kernel completes
    // this exact operation, including the already-completed race.
    CancelIoEx(pipe.value, &overlap);
    DWORD ignored = 0;
    GetOverlappedResult(pipe.value, &overlap, &ignored, TRUE);
    return false;
  }
  bool io(bool write, void *bytes, DWORD count, DWORD &transferred) {
    Handle ready(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    require(static_cast<bool>(ready), "execution_native_unknown");
    OVERLAPPED overlap{};
    overlap.hEvent = ready.value;
    BOOL result = write ? WriteFile(pipe.value, bytes, count, &transferred, &overlap)
                        : ReadFile(pipe.value, bytes, count, &transferred, &overlap);
    if (result)
      return true;
    if (GetLastError() != ERROR_IO_PENDING)
      return false;
    // Quiet sessions remain live. Writes are bounded; reads end on peer data,
    // explicit cancellation or the privately held main-process signal.
    return completeIo(overlap, transferred, write ? 15000 : INFINITE);
  }
  void send(JsonObject value) {
    std::string bytes = narrow(std::wstring(value.Stringify())) + '\n';
    require(bytes.size() <= CONTROL_PACKET_LIMIT, "execution_invalid_response");
    std::lock_guard<std::mutex> lock(pipeMutex);
    DWORD offset = 0;
    while (offset < bytes.size()) {
      DWORD count = 0;
      require(io(true, bytes.data() + offset, static_cast<DWORD>(bytes.size() - offset), count) &&
                  count > 0,
              "execution_native_unknown");
      offset += count;
    }
  }
  void read() {
    try {
      Handle ready(CreateEventW(nullptr, TRUE, FALSE, nullptr));
      require(static_cast<bool>(ready), "execution_native_unknown");
      OVERLAPPED overlap{};
      overlap.hEvent = ready.value;
      BOOL connected = ConnectNamedPipe(pipe.value, &overlap);
      DWORD error = connected ? ERROR_SUCCESS : GetLastError();
      require(connected || error == ERROR_PIPE_CONNECTED || error == ERROR_IO_PENDING,
              "execution_containment_pipe_denied");
      if (error == ERROR_IO_PENDING) {
        DWORD count = 0;
        require(completeIo(overlap, count, 15000), "execution_containment_pipe_denied");
      }
      ULONG client = 0;
      require(GetNamedPipeClientProcessId(pipe.value, &client) && client == pid && !exited(),
              "execution_identity_mismatch");
      JsonObject peer = JsonObject::Parse(mapping.Stringify());
      num(peer, L"clientPID", client);
      event(L"connected", peer);
      std::string buffer;
      while (!stopping) {
        char bytes[8192];
        DWORD count = 0;
        if (!io(false, bytes, sizeof(bytes), count) || count == 0)
          break;
        buffer.append(bytes, count);
        require(buffer.size() <= CONTROL_PACKET_LIMIT, "execution_invalid_response");
        for (size_t newline; (newline = buffer.find('\n')) != std::string::npos;) {
          auto packet = JsonObject::Parse(wide(buffer.substr(0, newline)));
          buffer.erase(0, newline + 1);
          require(!exited(), "execution_identity_mismatch");
          event(L"message", packet);
        }
      }
    } catch (...) {
      // The same terminal event covers rejected frames and unexpected EOF.
    }
    if (!stopping) {
      JsonObject value = JsonObject::Parse(mapping.Stringify());
      str(value, L"code", L"execution_containment_pipe_denied");
      num(value, L"clientPID", pid);
      event(L"failed", value);
      if (job)
        TerminateJobObject(job.value, 99);
    }
  }
  JsonObject retire() {
    stopping = true;
    SetEvent(cancel.value);
    CancelIoEx(pipe.value, nullptr);
    require(TerminateJobObject(job.value, 99) != 0, "cleanup_unknown");
    ULONGLONG deadline = GetTickCount64() + 12000;
    while ((!exited() || active() != 0) && GetTickCount64() < deadline)
      Sleep(10);
    require(exited() && active() == 0, "cleanup_unknown");
    if (reader.joinable())
      reader.join();
    if (commands)
      commands->retireAll();
    inputFile.reset();
    outputFile.reset();
    errorFile.reset();
    spool.reset();
    JsonObject value;
    flag(value, L"empty", true);
    flag(value, L"heldProcessExited", true);
    num(value, L"activeProcesses", 0);
    value.SetNamedValue(L"mapping", mapping);
    return value;
  }
};
static void grantRoot(Scope &scope, const std::wstring &path, DWORD mask, ACCESS_MODE mode) {
  auto handle = canonicalDirectory(path, READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES);
  PACL previous = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  require(GetSecurityInfo(handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr,
                          &previous, nullptr, &descriptor) == ERROR_SUCCESS,
          "execution_containment_filesystem_denied");
  LocalMemory original{descriptor};
  EXPLICIT_ACCESSW entry{};
  entry.grfAccessPermissions = mask;
  entry.grfAccessMode = mode;
  entry.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  BuildTrusteeWithSidW(&entry.Trustee, scope.sid.value);
  PACL next = nullptr;
  require(SetEntriesInAclW(1, &entry, previous, &next) == ERROR_SUCCESS,
          "execution_containment_filesystem_denied");
  LocalMemory nextMemory{next};
  scope.aclRoots.push_back(path);
  require(SetSecurityInfo(handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr,
                          next, nullptr) == ERROR_SUCCESS,
          "execution_containment_filesystem_denied");
}
static void removeGrants(Scope &scope) {
  for (auto it = scope.aclRoots.rbegin(); it != scope.aclRoots.rend(); ++it) {
    auto handle = canonicalDirectory(*it, READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES);
    PACL previous = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(GetSecurityInfo(handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr,
                            nullptr, &previous, nullptr, &descriptor) == ERROR_SUCCESS,
            "cleanup_unknown");
    LocalMemory original{descriptor};
    EXPLICIT_ACCESSW entry{};
    entry.grfAccessMode = REVOKE_ACCESS;
    BuildTrusteeWithSidW(&entry.Trustee, scope.sid.value);
    PACL next = nullptr;
    require(SetEntriesInAclW(1, &entry, previous, &next) == ERROR_SUCCESS, "cleanup_unknown");
    LocalMemory nextMemory{next};
    require(SetSecurityInfo(handle.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr,
                            nullptr, next, nullptr) == ERROR_SUCCESS,
            "cleanup_unknown");
  }
  scope.aclRoots.clear();
}
static std::unique_ptr<Scope> launch(const JsonObject &input, OwnerStore &owners) {
  auto scope = std::make_unique<Scope>();
  auto nonce = text(input, L"nonce"), lease = text(input, L"leaseOwnerId"),
       executable = text(input, L"executable"), entry = text(input, L"entry");
  require(nonce.size() == 36 && lease.size() == 36, "execution_identity_mismatch");
  scope->profile = L"AgentTeams.OpenCodeV2." + nonce;
  scope->cwd = text(input, L"cwd");
  auto parents = ancestors(scope->cwd);
  HRESULT result = CreateAppContainerProfile(scope->profile.c_str(), scope->profile.c_str(),
                                             L"OpenCode V2 private execution", nullptr, 0,
                                             reinterpret_cast<PSID *>(&scope->sid.value));
  require(SUCCEEDED(result), "execution_containment_profile_denied");
  scope->sid.freeSid = true;
  require(ConvertStringSidToSidW(L"S-1-15-3-1", &scope->network.value) != 0,
          "execution_containment_unavailable");
  SID_AND_ATTRIBUTES capability{scope->network.value, SE_GROUP_ENABLED};
  SECURITY_CAPABILITIES capabilities{scope->sid.value, &capability, 1, 0};
  for (auto kind : {L"readOnlyRoots", L"writableRoots", L"protectedRoots"}) {
    require(input.HasKey(kind) && input.GetNamedValue(kind).ValueType() == JsonValueType::Array,
            "execution_invalid_response");
    for (auto value : input.GetNamedArray(kind)) {
      require(value.ValueType() == JsonValueType::String, "execution_invalid_response");
      std::wstring root(value.GetString());
      auto checked = ancestors(root);
      if (kind != std::wstring(L"protectedRoots"))
        scope->realpathAnchors.emplace_back(
            root, kind == std::wstring(L"writableRoots") ? L"writable" : L"readOnly",
            std::move(checked));
      grantRoot(*scope, root,
                kind == std::wstring(L"protectedRoots") ? FILE_ALL_ACCESS
                : kind == std::wstring(L"writableRoots")
                    ? (FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE)
                    : (FILE_GENERIC_READ | FILE_GENERIC_EXECUTE),
                kind == std::wstring(L"protectedRoots") ? DENY_ACCESS : GRANT_ACCESS);
    }
  }
  LPWSTR sidString = nullptr;
  require(ConvertSidToStringSidW(scope->sid.value, &sidString) != 0,
          "execution_containment_unavailable");
  LocalMemory sidMemory{sidString};
  std::wstring sddl =
      L"D:P(A;;GRGW;;;SY)(A;;GRGW;;;OW)(A;;GRGW;;;" + std::wstring(sidString) + L")S:(ML;;NW;;;LW)";
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
              sddl.c_str(), SDDL_REVISION_1, &scope->pipeDescriptor.value, nullptr) != 0,
          "execution_containment_unavailable");
  SECURITY_ATTRIBUTES pipeSecurity{sizeof(pipeSecurity), scope->pipeDescriptor.value, FALSE};
  scope->pipeName = L"\\\\.\\pipe\\agt-v2-" + nonce;
  scope->pipe = Handle(
      CreateNamedPipeW(scope->pipeName.c_str(),
                       PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                       PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                       1, 65536, 65536, 0, &pipeSecurity));
  require(static_cast<bool>(scope->pipe), "execution_containment_pipe_denied");
  scope->cancel = Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  require(static_cast<bool>(scope->cancel), "execution_containment_unavailable");
  scope->job = Handle(CreateJobObjectW(nullptr, nullptr));
  require(static_cast<bool>(scope->job), "execution_containment_unavailable");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  require(SetInformationJobObject(scope->job.value, JobObjectExtendedLimitInformation, &limits,
                                  sizeof(limits)) != 0,
          "execution_containment_unavailable");
  auto ownedSpool = owners.createSpool(input, nonce);
  scope->spool = std::move(ownedSpool.first);
  scope->commands =
      std::make_unique<NativeCommandStore>(scope->job.value, scope->sid.value, scope->network.value,
                                           ownedSpool.second, currentSid(), object(input, L"env"));
  scope->inputFile = scope->commands->createFile(L"main.stdin", GENERIC_READ);
  scope->outputFile = scope->commands->createFile(L"main.stdout", GENERIC_WRITE);
  scope->errorFile = scope->commands->createFile(L"main.stderr", GENERIC_WRITE);
  HANDLE stdio[] = {scope->inputFile.value, scope->outputFile.value, scope->errorFile.value};
  AttributeList attributes(3);
  HANDLE job = scope->job.value;
  attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job));
  attributes.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities));
  attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, stdio, sizeof(stdio));
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = attributes.get();
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = stdio[0];
  startup.StartupInfo.hStdOutput = stdio[1];
  startup.StartupInfo.hStdError = stdio[2];
  auto environment = object(input, L"env");
  str(environment, L"OPENCODE_V2_WINDOWS_PIPE", scope->pipeName);
  str(environment, L"OPENCODE_V2_WINDOWS_NONCE", nonce);
  str(environment, L"OPENCODE_V2_WINDOWS_LEASE", lease);
  std::wstring block;
  for (auto pair : environment) {
    require(pair.Value().ValueType() == JsonValueType::String &&
                std::wstring(pair.Key()).find_first_of(L"=\0") == std::wstring::npos,
            "execution_invalid_response");
    auto value = std::wstring(pair.Value().GetString());
    require(value.find(L'\0') == std::wstring::npos, "execution_invalid_response");
    block += std::wstring(pair.Key()) + L"=" + value + L'\0';
  }
  block += L'\0';
  require(block.size() <= 32767, "execution_invalid_response");
  std::wstring command = quote(executable) + L" " + quote(entry);
  PROCESS_INFORMATION process{};
  require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
                         EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
                             CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                         block.data(), scope->cwd.c_str(), &startup.StartupInfo, &process) != 0,
          "execution_containment_launcher_denied");
  scope->process = Handle(process.hProcess);
  scope->thread = Handle(process.hThread);
  scope->pid = process.dwProcessId;
  BOOL member = FALSE;
  require(IsProcessInJob(scope->process.value, scope->job.value, &member) && member &&
              scope->active() == 1,
          "execution_identity_mismatch");
  JsonObject mapping;
  mapping.SetNamedValue(L"bun", identity(scope->process.value, scope->pid));
  mapping.SetNamedValue(L"supervisor", identity(GetCurrentProcess(), GetCurrentProcessId()));
  str(mapping, L"leaseOwnerId", lease);
  str(mapping, L"namespace", L"windows-job:" + nonce);
  str(mapping, L"containerSid", sidString);
  JsonObject anchors;
  str(anchors, L"nonce", nonce);
  str(anchors, L"receiptId", L"windows-anchors:" + decimal(GetCurrentProcessId()) + L":" +
                                     decimal(scope->pid) + L":" +
                                     text(birth(scope->process.value), L"value"));
  JsonArray entries;
  scope->assertRealpathAnchorsLive();
  for (const auto &anchor : scope->realpathAnchors)
    entries.Append(anchor.receipt());
  anchors.SetNamedValue(L"anchors", entries);
  mapping.SetNamedValue(L"realpathAnchors", anchors);
  str(mapping, L"nonce", nonce);
  // Bound the expanded launch/connected receipt before the child can run.
  // Remaining response envelope is small and fixed; reserve a full KiB.
  require(winrt::to_string(mapping.Stringify()).size() <= CONTROL_PACKET_LIMIT - 1024,
          "execution_invalid_response");
  scope->mapping = mapping;
  scope->reader = std::thread([value = scope.get()] {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    value->read();
  });
  require(ResumeThread(scope->thread.value) == 1, "execution_containment_launcher_denied");
  scope->thread.reset();
  return scope;
}
static bool readControlLine(std::string &line) {
  line.clear();
  for (char next; std::cin.get(next);) {
    if (next == '\n')
      return true;
    require(line.size() < CONTROL_PACKET_LIMIT, "execution_invalid_response");
    line.push_back(next);
  }
  require(line.empty(), "execution_invalid_response");
  return false;
}
int wmain(int argc, wchar_t **argv) {
  if (argc != 2 || std::wstring(argv[1]) != L"--broker")
    return 64;
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    OwnerStore owners;
    std::unique_ptr<Scope> scope;
    std::string line;
    while (readControlLine(line)) {
      require(line.size() <= CONTROL_PACKET_LIMIT, "execution_invalid_response");
      double id = 0;
      JsonObject reply;
      num(reply, L"schema", 1);
      str(reply, L"kind", L"reply");
      try {
        auto request = JsonObject::Parse(wide(line));
        id = request.GetNamedNumber(L"id");
        require(id > 0 && id <= 9007199254740991.0 && id == static_cast<std::uint64_t>(id),
                "execution_invalid_response");
        auto operation = text(request, L"operation");
        auto input = object(request, L"input");
        JsonObject value;
        if (operation.rfind(L"owner", 0) == 0)
          value = owners.request(operation, input);
        else if (operation == L"identity") {
          double raw = input.GetNamedNumber(L"pid");
          require(raw > 0 && raw <= MAXDWORD && raw == static_cast<DWORD>(raw),
                  "execution_identity_mismatch");
          Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE,
                                     static_cast<DWORD>(raw)));
          if (!process) {
            require(GetLastError() == ERROR_INVALID_PARAMETER, "execution_identity_unknown");
            flag(value, L"absent", true);
          } else {
            value = identity(process.value, static_cast<DWORD>(raw));
            flag(value, L"exited", WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0);
          }
        } else if (operation == L"launch") {
          require(!scope, "execution_containment_unavailable");
          scope = launch(input, owners);
          owners.selectedPackage = scope->sid.value;
          value = scope->mapping;
        } else if (operation.rfind(L"command", 0) == 0) {
          require(scope && scope->commands && !scope->stopping && !scope->exited(),
                  "execution_native_command_unknown");
          value = scope->commands->request(operation, input);
        } else if (operation == L"send") {
          require(scope && !scope->stopping && !scope->exited(), "execution_native_unknown");
          scope->send(object(input, L"value"));
          flag(value, L"sent", true);
        } else if (operation == L"assertLive") {
          require(scope && !scope->stopping && !scope->exited() && scope->active() > 0,
                  "execution_identity_mismatch");
          scope->assertRealpathAnchorsLive();
          value = scope->mapping;
        } else if (operation == L"retire") {
          require(static_cast<bool>(scope), "cleanup_unknown");
          value = scope->retire();
          removeGrants(*scope);
          flag(value, L"ownAcesRemoved", true);
        } else
          throw NativeError{"execution_invalid_response"};
        flag(reply, L"ok", true);
        reply.SetNamedValue(L"value", value);
      } catch (const NativeError &error) {
        flag(reply, L"ok", false);
        str(reply, L"error", wide(error.code));
        if (error.stage) {
          str(reply, L"stage", wide(error.stage));
          num(reply, L"nativeCode", error.win32);
          if (error.nativeStatus)
            num(reply, L"nativeStatus", error.nativeStatus);
        }
      } catch (...) {
        flag(reply, L"ok", false);
        str(reply, L"error", L"execution_native_unknown");
      }
      reply.SetNamedValue(L"id", JsonValue::CreateNumberValue(id));
      output(reply);
    }
    if (scope) {
      auto receipt = scope->retire();
      removeGrants(*scope);
      scope.reset();
    }
    return 0;
  } catch (...) {
    return 1;
  }
}
