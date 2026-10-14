#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <aclapi.h>
#include <algorithm>
#include <atomic>
#include <bcrypt.h>
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
#include <wincrypt.h>
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
static void require(bool value, const char *code, const char *stage = nullptr) {
  if (!value)
    throw NativeError{code, 0, stage};
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
static bool validTeamId(const std::wstring &value) {
  const auto alphaNumeric = [](wchar_t c) {
    return (c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z') ||
           (c >= L'0' && c <= L'9');
  };
  if (value.empty() || value.size() > 200 || !alphaNumeric(value[0]))
    return false;
  for (const wchar_t c : value)
    if (!alphaNumeric(c) && c != L'.' && c != L'_' && c != L'-')
      return false;
  return true;
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
struct AclCustody {
  std::wstring siblings;
  bool memberAllowed = false;
};
static AclCustody aclCustody(HANDLE file, const std::wstring &owner, PSID selectedPackage,
                             const std::vector<std::wstring> *cohortSids, const char *code) {
  PACL acl = nullptr;
  PSID ownerSid = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  require(GetSecurityInfo(file, SE_FILE_OBJECT,
                          OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &ownerSid,
                          nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS,
          code);
  LocalMemory memory{descriptor};
  require(acl && ownerSid, code);
  LPWSTR ownerString = nullptr;
  require(ConvertSidToStringSidW(ownerSid, &ownerString) != 0, code);
  LocalMemory ownerMemory{ownerString};
  require(owner == ownerString, code, "private_acl_owner");
  AclCustody result;
  std::vector<std::wstring> siblings;
  for (DWORD i = 0; i < acl->AceCount; i++) {
    void *raw = nullptr;
    require(GetAce(acl, i, &raw) != 0, code);
    auto header = reinterpret_cast<ACE_HEADER *>(raw);
    if (header->AceType == ACCESS_DENIED_ACE_TYPE)
      continue; // Denies add no external access, including the private package deny.
    require(header->AceType == ACCESS_ALLOWED_ACE_TYPE, code);
    auto ace = reinterpret_cast<ACCESS_ALLOWED_ACE *>(raw);
    LPWSTR trustee = nullptr;
    require(ConvertSidToStringSidW(&ace->SidStart, &trustee) != 0, code);
    LocalMemory trusteeMemory{trustee};
    const std::wstring trusteeSid(trustee);
    const bool currentMember = selectedPackage && EqualSid(&ace->SidStart, selectedPackage);
    const bool sealedCohortSid =
        cohortSids && std::find(cohortSids->begin(), cohortSids->end(), trusteeSid) !=
                          cohortSids->end();
    require(owner == trusteeSid || trusteeSid == L"S-1-5-18" ||
                currentMember || sealedCohortSid,
            code, "private_acl_foreign_allow");
    result.memberAllowed = result.memberAllowed || currentMember;
    if (sealedCohortSid && !currentMember) {
      siblings.push_back(decimal(header->AceFlags) + L":" + decimal(ace->Mask) + L":" +
                         trusteeSid);
    }
  }
  std::sort(siblings.begin(), siblings.end());
  for (const auto &sibling : siblings) {
    if (!result.siblings.empty()) result.siblings += L";";
    result.siblings += sibling;
  }
  return result;
}
static bool privateAcl(HANDLE file, const std::wstring &owner, PSID selectedPackage = nullptr,
                       const std::vector<std::wstring> *cohortSids = nullptr) {
  (void)aclCustody(file, owner, selectedPackage, cohortSids, "execution_owner_not_private");
  return true;
}
static JsonObject fileObjectIdentity(HANDLE file, const std::wstring &owner, bool directory) {
  FILE_ID_INFO id{};
  FILE_ATTRIBUTE_TAG_INFO tag{};
  FILE_STANDARD_INFO standard{};
  require(GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id)) &&
              GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) &&
              GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)),
          "execution_owner_unknown");
  require(!(tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT),
          "execution_owner_alias", "owner_identity_reparse");
  require(!!standard.Directory == directory,
          "execution_owner_alias", "owner_identity_type");
  require(standard.NumberOfLinks == 1,
          "execution_owner_alias", "owner_identity_links");
  PSID ownerSid = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  require(GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &ownerSid, nullptr,
                          nullptr, nullptr, &descriptor) == ERROR_SUCCESS &&
              ownerSid,
          "execution_owner_unknown");
  LocalMemory memory{descriptor};
  LPWSTR ownerString = nullptr;
  require(ConvertSidToStringSidW(ownerSid, &ownerString) != 0, "execution_owner_unknown");
  LocalMemory ownerMemory{ownerString};
  require(owner == ownerString, "execution_owner_not_private");
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
static JsonObject fileIdentity(HANDLE file, const std::wstring &owner, bool directory,
                               PSID selectedPackage = nullptr,
                               const std::vector<std::wstring> *cohortSids = nullptr) {
  privateAcl(file, owner, selectedPackage, cohortSids);
  return fileObjectIdentity(file, owner, directory);
}
static Handle canonicalDirectory(const std::wstring &value,
                                 DWORD access = FILE_READ_ATTRIBUTES | READ_CONTROL,
                                 const std::vector<std::wstring> *cohortSids = nullptr,
                                 PSID selectedPackage = nullptr,
                                 bool qualifyAcl = false) {
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
  if (qualifyAcl)
    fileIdentity(handle.value, currentSid(), true, selectedPackage, cohortSids);
  return handle;
}
// A named verification open must coexist with the retained DELETE-capable
// owner. It grants no mutation right and still proves the same physical path.
static Handle verificationDirectory(const std::wstring &value) {
  const auto full = extended(value);
  Handle handle(CreateFileW(full.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                            OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                            nullptr));
  if (!handle)
    throw NativeError{"execution_owner_unknown", GetLastError(), "owner_verification_open"};
  FILE_ATTRIBUTE_TAG_INFO tag{};
  require(GetFileInformationByHandleEx(handle.value, FileAttributeTagInfo, &tag, sizeof(tag)) &&
              (tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
              !(tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
              equalPath(finalPath(handle.value), full), "execution_path_alias");
  return handle;
}
static std::vector<Handle> verificationAncestors(const std::wstring &path) {
  require(path.size() >= 3 && GetDriveTypeW(path.substr(0, 3).c_str()) == DRIVE_FIXED,
          "execution_owner_local_volume_required");
  std::vector<Handle> values;
  values.push_back(verificationDirectory(path.substr(0, 3)));
  for (size_t i = 3; i < path.size(); i++)
    if (path[i] == L'\\') values.push_back(verificationDirectory(path.substr(0, i)));
  return values;
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
  bool sharedRoot = false;
  bool cohortPolicy = false;
  explicit RetainedAnchorComponent(Handle owned, bool shared = false,
                                   bool cohort = false)
      : handle(std::move(owned)), identity(anchorIdentity(handle.value)), sharedRoot(shared),
        cohortPolicy(cohort) {
    auto dos = text(identity, L"dosPath");
    require(dos.rfind(L"\\\\?\\", 0) == 0, "execution_path_alias");
    path = dos.substr(4);
  }
  void assertLive() const {
    require(anchorIdentity(handle.value).Stringify() == identity.Stringify(),
            "execution_path_alias");
    auto reopened = verificationDirectory(path);
    require(anchorIdentity(reopened.value).Stringify() == identity.Stringify(),
            "execution_path_alias");
  }
};
struct RetainedRealpathAnchor {
  std::wstring kind, path;
  std::vector<RetainedAnchorComponent> components;
  RetainedRealpathAnchor(const std::wstring &root, const std::wstring &accessKind,
                         std::vector<Handle> parents, Handle heldRoot)
      : kind(accessKind), path(root) {
    for (auto &parent : parents)
      components.emplace_back(std::move(parent));
    components.emplace_back(std::move(heldRoot));
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
// Producer-selected DLL is held separately from writable/readonly root grants.
// A retained non-sharing handle blocks replacement and content writes until the
// native scope retires; only its exact file receives the package execute ACE.
static std::wstring heldFileSha256(HANDLE file) {
  HCRYPTPROV provider = 0;
  HCRYPTHASH digest = 0;
  struct Cleanup {
    HCRYPTPROV &provider;
    HCRYPTHASH &digest;
    ~Cleanup() {
      if (digest) CryptDestroyHash(digest);
      if (provider) CryptReleaseContext(provider, 0);
    }
  } cleanup{provider, digest};
  require(CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES,
                              CRYPT_VERIFYCONTEXT) &&
              CryptCreateHash(provider, CALG_SHA_256, 0, 0, &digest),
          "execution_containment_dll_identity");
  LARGE_INTEGER zero{};
  require(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN),
          "execution_containment_dll_identity");
  BYTE buffer[65536];
  DWORD count = 0;
  for (;;) {
    require(ReadFile(file, buffer, sizeof(buffer), &count, nullptr),
            "execution_containment_dll_identity");
    if (!count) break;
    require(CryptHashData(digest, buffer, count, 0),
            "execution_containment_dll_identity");
  }
  BYTE bytes[32];
  DWORD size = sizeof(bytes);
  require(CryptGetHashParam(digest, HP_HASHVAL, bytes, &size, 0) && size == sizeof(bytes),
          "execution_containment_dll_identity");
  static const wchar_t hex[] = L"0123456789abcdef";
  std::wstring value;
  for (BYTE byte : bytes) {
    value += hex[byte >> 4];
    value += hex[byte & 15];
  }
  return value;
}
static std::vector<BYTE> heldFileBytes(HANDLE file, DWORD limit) {
  LARGE_INTEGER zero{};
  require(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN), "run_controller_config_unknown");
  std::vector<BYTE> bytes;
  BYTE buffer[65536];
  DWORD count = 0;
  do {
    require(ReadFile(file, buffer, sizeof(buffer), &count, nullptr) &&
                bytes.size() + count <= limit,
            "run_controller_config_unknown");
    bytes.insert(bytes.end(), buffer, buffer + count);
  } while (count != 0);
  return bytes;
}
class SharedAclMutex {
  Handle mutex;

public:
  explicit SharedAclMutex(const JsonObject &identity) {
    const std::wstring name = L"Global\\AgentTeams.OpenCodeV2.ACL." +
                              text(identity, L"volumeSerial") + L"." +
                              text(identity, L"fileId");
    const auto owner = currentSid();
    const std::wstring sddl =
        L"O:" + owner + L"G:" + owner + L"D:P(A;;GA;;;" + owner + L")(A;;GA;;;SY)";
    LocalMemory descriptor;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.c_str(), SDDL_REVISION_1, &descriptor.value, nullptr) != 0,
            "execution_containment_filesystem_denied");
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.value, FALSE};
    mutex = Handle(CreateMutexW(&attributes, FALSE, name.c_str()));
    require(static_cast<bool>(mutex), "execution_containment_filesystem_denied");
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
      PSID rawOwner = nullptr;
      PACL dacl = nullptr;
      PSECURITY_DESCRIPTOR rawDescriptor = nullptr;
      require(GetSecurityInfo(mutex.value, SE_KERNEL_OBJECT,
                              OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                              &rawOwner, nullptr, &dacl, nullptr, &rawDescriptor) == ERROR_SUCCESS,
              "execution_containment_filesystem_denied");
      LocalMemory ownedDescriptor{rawDescriptor};
      LPWSTR ownerText = nullptr, daclText = nullptr;
      require(ConvertSidToStringSidW(rawOwner, &ownerText) != 0 &&
                  ConvertSecurityDescriptorToStringSecurityDescriptorW(
                      rawDescriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &daclText,
                      nullptr) != 0,
              "execution_containment_filesystem_denied");
      LocalMemory ownerMemory{ownerText}, daclMemory{daclText};
      require(owner == ownerText &&
                  std::wstring(daclText) ==
                      L"D:P(A;;GA;;;" + owner + L")(A;;GA;;;SY)",
              "execution_containment_filesystem_denied");
    }
    const DWORD waited = WaitForSingleObject(mutex.value, 10000);
    if (waited == WAIT_ABANDONED) {
      ReleaseMutex(mutex.value);
      throw NativeError{"execution_containment_filesystem_denied", ERROR_ABANDONED_WAIT_0,
                        "shared_acl_mutex"};
    }
    require(waited == WAIT_OBJECT_0, "execution_containment_filesystem_denied");
  }
  ~SharedAclMutex() {
    if (mutex) ReleaseMutex(mutex.value);
  }
  SharedAclMutex(const SharedAclMutex &) = delete;
  SharedAclMutex &operator=(const SharedAclMutex &) = delete;
};
struct RetainedRealpathDll {
  Handle file;
  std::vector<RetainedAnchorComponent> parents;
  std::wstring path, owner, sha256;
  JsonObject identity;
  PSID package = nullptr; // Scope's SID outlives this capability.
  std::vector<std::wstring> cohortSids;
  bool granted = false;
  RetainedRealpathDll(const JsonObject &selection, PSID selectedPackage,
                      const std::vector<std::wstring> *selectedCohortSids = nullptr)
      : path(text(selection, L"path")), owner(currentSid()),
        sha256(text(selection, L"sha256")), package(selectedPackage),
        cohortSids(selectedCohortSids ? *selectedCohortSids
                                      : std::vector<std::wstring>()) {
    require(sha256.size() == 64 &&
                sha256.find_first_not_of(L"0123456789abcdef") == std::wstring::npos,
            "execution_containment_dll_identity");
    for (auto &parent : ancestors(path))
      parents.emplace_back(std::move(parent));
    file = Handle(CreateFileW(extended(path).c_str(), GENERIC_READ | READ_CONTROL | WRITE_DAC,
                              FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(static_cast<bool>(file), "execution_containment_dll_identity");
    identity = fileObjectIdentity(file.value, owner, false);
    SharedAclMutex aclMutex(identity);
    const auto before =
        aclCustody(file.value, owner, package, &cohortSids, "execution_containment_dll_identity");
    require(fileIdentity(file.value, owner, false, package, &cohortSids).Stringify() ==
                identity.Stringify(),
            "execution_containment_dll_identity");
    (void)before;
    auto canonical = finalPath(file.value);
    require(equalPath(canonical, extended(path)), "execution_containment_dll_identity");
    path = canonical.substr(4);
    require(heldFileSha256(file.value) == sha256, "execution_containment_dll_identity");
  }
  void changeAce(ACCESS_MODE mode) {
    SharedAclMutex aclMutex(identity);
    require(fileObjectIdentity(file.value, owner, false).Stringify() == identity.Stringify(),
            "execution_containment_dll_identity");
    const auto before =
        aclCustody(file.value, owner, package, &cohortSids, "execution_containment_dll_identity");
    PACL previous = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(GetSecurityInfo(file.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                            nullptr, nullptr, &previous, nullptr, &descriptor) == ERROR_SUCCESS,
            "execution_containment_dll_identity");
    LocalMemory original{descriptor};
    EXPLICIT_ACCESSW entry{};
    entry.grfAccessMode = mode;
    entry.grfAccessPermissions = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
    entry.grfInheritance = NO_INHERITANCE;
    BuildTrusteeWithSidW(&entry.Trustee, package);
    PACL next = nullptr;
    require(SetEntriesInAclW(1, &entry, previous, &next) == ERROR_SUCCESS,
            "execution_containment_dll_identity");
    LocalMemory nextMemory{next};
    // Mark acquisition before publication, so later setup failure still revokes
    // exactly this unique package SID through the retained file HANDLE.
    if (mode == GRANT_ACCESS) granted = true;
    require(SetSecurityInfo(file.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                            nullptr, nullptr, next, nullptr) == ERROR_SUCCESS,
            "execution_containment_dll_identity");
    if (mode == REVOKE_ACCESS) granted = false;
    require(fileObjectIdentity(file.value, owner, false).Stringify() == identity.Stringify(),
            "execution_containment_dll_identity");
    const auto after =
        aclCustody(file.value, owner, package, &cohortSids, "execution_containment_dll_identity");
    require(after.siblings == before.siblings, "execution_containment_dll_identity");
    require(mode != GRANT_ACCESS || after.memberAllowed, "execution_containment_dll_identity");
    require(mode != REVOKE_ACCESS || !after.memberAllowed, "execution_containment_dll_identity");
  }
  void assertLive() const {
    for (const auto &parent : parents) parent.assertLive();
    require(equalPath(finalPath(file.value), extended(path)) &&
                fileIdentity(file.value, owner, false, package, &cohortSids).Stringify() ==
                    identity.Stringify() &&
                heldFileSha256(file.value) == sha256,
            "execution_containment_dll_identity");
    Handle reopened(CreateFileW(extended(path).c_str(), GENERIC_READ | READ_CONTROL,
                                FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                                FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(static_cast<bool>(reopened) &&
                fileIdentity(reopened.value, owner, false, package, &cohortSids).Stringify() ==
                    identity.Stringify(),
            "execution_containment_dll_identity");
  }
  JsonObject receipt(const std::wstring &nonce, DWORD pid, const std::wstring &creation) const {
    auto result = JsonObject::Parse(identity.Stringify());
    str(result, L"path", path);
    str(result, L"sha256", sha256);
    str(result, L"nonce", nonce);
    str(result, L"receiptId", L"windows-dll:" + decimal(GetCurrentProcessId()) + L":" +
                                     decimal(pid) + L":" + creation);
    flag(result, L"held", true);
    return result;
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
static std::vector<BYTE> unbase64(const std::wstring &value, size_t maxBytes = 16384) {
  require(maxBytes <= 128 * 1024 && value.size() % 4 == 0 &&
              value.size() <= ((maxBytes + 2) / 3) * 4, "execution_owner_unknown");
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
  require(out.size() <= maxBytes, "execution_owner_unknown");
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
static Handle ownerDirectory(const std::wstring &path, bool create, const std::wstring &owner,
                             const std::vector<std::wstring> *cohortSids = nullptr,
                             PSID selectedPackage = nullptr, bool archiveCapable = true) {
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
      FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE |
          (create && archiveCapable ? DELETE : 0),
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
  fileIdentity(handle.value, owner, true, selectedPackage, create ? nullptr : cohortSids);
  return handle;
}
struct OwnerDirectory {
  Handle file;
  std::vector<Handle> parents;
  std::vector<JsonObject> parentIdentities;
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
static bool controllerInboxEmpty(const std::wstring &path) {
  WIN32_FIND_DATAW entry{};
  struct Search {
    HANDLE value;
    ~Search() { if (value != INVALID_HANDLE_VALUE) FindClose(value); }
  } search{FindFirstFileW(extended(path + L"\\*").c_str(), &entry)};
  if (search.value == INVALID_HANDLE_VALUE) {
    require(GetLastError() == ERROR_FILE_NOT_FOUND, "run_controller_inbox_unknown");
    return true;
  }
  do {
    const std::wstring name(entry.cFileName);
    if (name != L"." && name != L"..") return false;
  } while (FindNextFileW(search.value, &entry));
  require(GetLastError() == ERROR_NO_MORE_FILES, "run_controller_inbox_unknown");
  return true;
}
struct SelectedControllerInbox {
  std::vector<RetainedAnchorComponent> directories;
  std::vector<JsonObject> directoryIdentities;
  std::vector<std::wstring> directoryPaths;
  std::wstring inboxPath, userPath;

  const std::vector<std::wstring> *rootSids(
      const std::wstring &path,
      const std::vector<std::wstring> *cohortSids) const {
    require(directoryPaths.size() == 3, "run_controller_inbox_unknown");
    return equalPath(path, directoryPaths[1]) || equalPath(path, directoryPaths[2]) ||
                   equalPath(path, userPath)
               ? cohortSids
               : nullptr;
  }

  std::wstring assertLive(PSID package,
                          const std::vector<std::wstring> *cohortSids = nullptr) const {
    require(directories.size() == directoryIdentities.size() && directoryPaths.size() == 3,
            "run_controller_inbox_unknown");
    for (size_t i = 0; i < directories.size(); ++i) {
      directories[i].assertLive();
      require(fileIdentity(directories[i].handle.value, currentSid(), true, package,
                           rootSids(directoryPaths[i], cohortSids))
                  .Stringify() == directoryIdentities[i].Stringify(),
              "run_controller_inbox_unknown");
    }
    std::vector<Handle> laterDirectories;
    std::vector<JsonObject> laterIdentities;
    size_t firstMissing = directories.size();
    for (size_t i = firstMissing; i < directoryPaths.size(); ++i) {
      Handle directory(CreateFileW(extended(directoryPaths[i]).c_str(),
                                   FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL,
                                   FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                                   FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                                   nullptr));
      if (!directory) {
        const DWORD error = GetLastError();
        require(error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND,
                "run_controller_inbox_unknown");
        firstMissing = i;
        break;
      }
      require(equalPath(finalPath(directory.value), extended(directoryPaths[i])),
              "run_controller_inbox_unknown");
      laterIdentities.push_back(fileIdentity(
          directory.value, currentSid(), true, package,
          rootSids(directoryPaths[directories.size() + laterDirectories.size()], cohortSids)));
      laterDirectories.emplace_back(std::move(directory));
      firstMissing = i + 1;
    }
    std::wstring state = L"absent";
    if (firstMissing == 3) {
      Handle user(CreateFileW(extended(userPath).c_str(), GENERIC_READ | READ_CONTROL,
                              FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                              FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      if (user) {
        FILE_STANDARD_INFO before{};
        require(equalPath(finalPath(user.value), extended(userPath)) &&
                    GetFileInformationByHandleEx(user.value, FileStandardInfo, &before,
                                                 sizeof(before)) &&
                    before.EndOfFile.QuadPart > 0 &&
                    before.EndOfFile.QuadPart <= 4 * 1024 * 1024,
                "run_controller_inbox_unknown");
        const auto identity =
            fileIdentity(user.value, currentSid(), false, package, rootSids(userPath, cohortSids));
        const auto bytes = heldFileBytes(user.value, 4 * 1024 * 1024);
        FILE_STANDARD_INFO after{};
        require(GetFileInformationByHandleEx(user.value, FileStandardInfo, &after, sizeof(after)) &&
                    before.EndOfFile.QuadPart == after.EndOfFile.QuadPart &&
                    after.EndOfFile.QuadPart == static_cast<LONGLONG>(bytes.size()) &&
                    fileIdentity(user.value, currentSid(), false, package,
                                 rootSids(userPath, cohortSids))
                            .Stringify() == identity.Stringify(),
                "run_controller_inbox_unknown");
        Handle named(CreateFileW(extended(userPath).c_str(),
                                 GENERIC_READ | FILE_READ_ATTRIBUTES | READ_CONTROL,
                                 FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                                 FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        require(static_cast<bool>(named) &&
                    equalPath(finalPath(named.value), extended(userPath)) &&
                    fileIdentity(named.value, currentSid(), false, package,
                                 rootSids(userPath, cohortSids))
                            .Stringify() ==
                        identity.Stringify() &&
                    fileIdentity(user.value, currentSid(), false, package,
                                 rootSids(userPath, cohortSids))
                            .Stringify() ==
                        identity.Stringify(),
                "run_controller_inbox_unknown");
        state = L"regular";
      } else {
        const DWORD error = GetLastError();
        require(error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND,
                "run_controller_inbox_unknown");
        state = controllerInboxEmpty(inboxPath) ? L"empty" : L"absent";
        Handle named(CreateFileW(extended(userPath).c_str(),
                                 FILE_READ_ATTRIBUTES | READ_CONTROL,
                                 FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                                 FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        require(!named, "run_controller_inbox_unknown");
        const DWORD recheckError = GetLastError();
        require(recheckError == ERROR_FILE_NOT_FOUND || recheckError == ERROR_PATH_NOT_FOUND,
                "run_controller_inbox_unknown");
      }
    }
    for (size_t i = 0; i < directories.size(); ++i) {
      directories[i].assertLive();
      require(fileIdentity(directories[i].handle.value, currentSid(), true, package,
                           rootSids(directoryPaths[i], cohortSids))
                  .Stringify() == directoryIdentities[i].Stringify(),
              "run_controller_inbox_unknown");
    }
    for (size_t i = 0; i < laterDirectories.size(); ++i) {
      require(fileIdentity(laterDirectories[i].value, currentSid(), true, package,
                           rootSids(directoryPaths[directories.size() + i], cohortSids))
                  .Stringify() == laterIdentities[i].Stringify(),
              "run_controller_inbox_unknown");
      auto reopened = verificationDirectory(directoryPaths[directories.size() + i]);
      require(fileIdentity(reopened.value, currentSid(), true, package,
                           rootSids(directoryPaths[directories.size() + i], cohortSids))
                  .Stringify() ==
                  laterIdentities[i].Stringify(),
              "run_controller_inbox_unknown");
    }
    for (size_t i = firstMissing; i < directoryPaths.size(); ++i) {
      Handle named(CreateFileW(extended(directoryPaths[i]).c_str(),
                               FILE_READ_ATTRIBUTES | READ_CONTROL,
                               FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                               FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                               nullptr));
      require(!named, "run_controller_inbox_unknown");
      const DWORD error = GetLastError();
      require(error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND,
              "run_controller_inbox_unknown");
    }
    if (firstMissing == 3 && state != L"regular") {
      Handle named(CreateFileW(extended(userPath).c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
                               FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                               FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      require(!named, "run_controller_inbox_unknown");
      const DWORD error = GetLastError();
      require(error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND,
              "run_controller_inbox_unknown");
    }
    return state;
  }
};
struct WindowsNativeRunControlIssuer;
struct WindowsNativeRunState;
struct WindowsNativeRunControl;
struct WindowsNativeRunStateIssuer;
struct Scope;
class SelectedControllerConfig {
  friend struct OwnerStore;
  friend struct WindowsNativeRunControlIssuer;
  friend struct WindowsNativeRunStateIssuer;
  friend bool sealedControllerRoot(const Scope &, const RetainedAnchorComponent &);
  Handle root, database, config;
  std::vector<Handle> configAncestors;
  std::vector<JsonObject> configAncestorIdentities;
  std::wstring rootPath, databasePath, path, owner, sha256, selectionTeamId, mcpRootPath;
  bool remoteController = false;
  PSID package = nullptr;
  JsonObject identity;
  IJsonValue databaseIdentity = JsonValue::CreateNullValue();
  std::unique_ptr<RetainedAnchorComponent> mcpRoot;
  JsonObject mcpRootIdentity;
  std::vector<Handle> mcpAncestors;
  std::vector<JsonObject> mcpAncestorIdentities;
  std::map<std::wstring, SelectedControllerInbox> inboxes;
  std::wstring boundTeamId;
  SelectedControllerConfig(Handle heldRoot, Handle heldDatabase, Handle heldConfig,
                           std::wstring selectedRootPath, std::wstring selectedDatabasePath,
                           std::wstring selectedPath,
                           std::wstring selectedOwner, std::wstring selectedHash,
                           std::wstring selectedTeamId, PSID selectedPackage,
                           std::vector<Handle> heldConfigAncestors)
      : root(std::move(heldRoot)), database(std::move(heldDatabase)),
        config(std::move(heldConfig)), configAncestors(std::move(heldConfigAncestors)),
        rootPath(std::move(selectedRootPath)),
        databasePath(std::move(selectedDatabasePath)), path(std::move(selectedPath)),
        owner(std::move(selectedOwner)), sha256(std::move(selectedHash)),
        selectionTeamId(std::move(selectedTeamId)), package(selectedPackage) {
    require(root && config && !databasePath.empty(), "run_control_selection_changed");
    identity = fileIdentity(config.value, owner, false, package);
    if (database) databaseIdentity = fileIdentity(database.value, owner, false, package);
    for (const auto &ancestor : configAncestors)
      configAncestorIdentities.push_back(anchorIdentity(ancestor.value));
    loadConfig();
  }
  void loadConfig() {
    const auto bytes = heldFileBytes(config.value, 4 * 1024 * 1024);
    require(!bytes.empty() && heldFileSha256(config.value) == sha256,
            "run_controller_config_unknown");
    const auto document = JsonObject::Parse(wide(std::string(bytes.begin(), bytes.end())));
    const auto servers = document.HasKey(L"mcpServers")
                             ? object(document, L"mcpServers")
                             : object(object(document, L"mcp"), L"servers");
    const auto server = object(servers, L"agent-teams");
    const auto type = text(server, L"type");
    require(type == L"local" || type == L"remote", "run_controller_config_unknown");
    if (type == L"remote") {
      remoteController = true;
      require(server.HasKey(L"url") && text(server, L"url").size() > 0 &&
                  (!server.HasKey(L"oauth") ||
                   (server.GetNamedValue(L"oauth").ValueType() == JsonValueType::Boolean &&
                    !server.GetNamedBoolean(L"oauth"))),
              "run_controller_config_unknown");
      return;
    }
    const auto environment = server.HasKey(L"env") ? object(server, L"env")
                                                   : object(server, L"environment");
    mcpRootPath = text(environment, L"AGENT_TEAMS_MCP_CLAUDE_DIR");
    require(mcpRootPath.size() >= 3 && mcpRootPath[1] == L':' && mcpRootPath[2] == L'\\',
            "run_controller_config_unknown");
    (void)extended(mcpRootPath);
  }
  void bindControllerBase() {
    if (remoteController || mcpRoot) return;
    require(!mcpRootPath.empty(), "run_controller_config_unknown");
    mcpRoot = std::make_unique<RetainedAnchorComponent>(verificationDirectory(mcpRootPath));
    require(equalPath(mcpRoot->path, mcpRootPath), "run_controller_inbox_unknown");
    mcpRoot->assertLive();
    mcpRootIdentity = fileObjectIdentity(mcpRoot->handle.value, owner, true);
    mcpAncestors = verificationAncestors(mcpRootPath);
    for (auto &parent : mcpAncestors)
      mcpAncestorIdentities.push_back(anchorIdentity(parent.value));
  }
  void bindInbox(const std::wstring &teamId,
                 const std::vector<std::wstring> *cohortSids) {
    require(validTeamId(teamId), "run_controller_inbox_unknown");
    bindControllerBase();
    if (!boundTeamId.empty()) {
      require(boundTeamId == teamId, "run_state_start_changed");
      return;
    }
    SelectedControllerInbox inbox;
    inbox.directoryPaths = {
        mcpRootPath + L"\\teams",
        mcpRootPath + L"\\teams\\" + teamId,
        mcpRootPath + L"\\teams\\" + teamId + L"\\inboxes"};
    inbox.inboxPath = inbox.directoryPaths.back();
    inbox.userPath = inbox.inboxPath + L"\\user.json";
    for (const auto &current : inbox.directoryPaths) {
      Handle directory(CreateFileW(extended(current).c_str(),
                                   FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL,
                                   FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                   OPEN_EXISTING,
                                   FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                                   nullptr));
      if (!directory) {
        const DWORD error = GetLastError();
        require(error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND,
                "run_controller_inbox_unknown");
        break;
      }
      require(equalPath(finalPath(directory.value), extended(current)),
              "run_controller_inbox_unknown");
      inbox.directoryIdentities.push_back(fileIdentity(
          directory.value, owner, true, package, inbox.rootSids(current, cohortSids)));
      inbox.directories.emplace_back(std::move(directory));
      require(equalPath(inbox.directories.back().path, current), "run_controller_inbox_unknown");
    }
    inbox.assertLive(package, cohortSids);
    mcpRoot->assertLive();
    require(equalPath(mcpRoot->path, mcpRootPath) &&
                fileObjectIdentity(mcpRoot->handle.value, owner, true).Stringify() ==
                    mcpRootIdentity.Stringify(),
            "run_controller_inbox_unknown");
    inboxes.emplace(teamId, std::move(inbox));
    boundTeamId = teamId;
  }
public:
  void assertConfigLive(PSID package) const {
    require(equalPath(finalPath(root.value), extended(rootPath)) &&
                equalPath(finalPath(config.value), extended(path)) &&
                fileIdentity(config.value, owner, false, package).Stringify() == identity.Stringify() &&
                heldFileSha256(config.value) == sha256,
            "run_control_config_identity");
    require(configAncestors.size() == configAncestorIdentities.size(),
            "run_control_selection_changed");
    for (size_t i = 0; i < configAncestors.size(); ++i) {
      require(anchorIdentity(configAncestors[i].value).Stringify() ==
                  configAncestorIdentities[i].Stringify(),
              "run_control_selection_changed");
      const auto heldPath = text(configAncestorIdentities[i], L"dosPath");
      require(heldPath.rfind(L"\\\\?\\", 0) == 0, "execution_path_alias");
      auto reopened = verificationDirectory(heldPath.substr(4));
      require(anchorIdentity(reopened.value).Stringify() ==
                  configAncestorIdentities[i].Stringify(),
              "run_control_selection_changed");
    }
    if (database) {
      require(equalPath(finalPath(database.value), extended(databasePath)) &&
                  fileIdentity(database.value, owner, false, package).Stringify() ==
                      databaseIdentity.Stringify(),
              "execution_database_alias");
    } else
      require(databaseIdentity.ValueType() == JsonValueType::Null,
              "execution_database_alias");
  }
  void assertLive(PSID package,
                  const std::vector<std::wstring> *cohortSids = nullptr) const {
    assertConfigLive(package);
    if (remoteController) {
      require(!mcpRoot && mcpRootPath.empty() && mcpAncestors.empty() && inboxes.empty(),
              "run_controller_config_unknown");
      return;
    }
    require(mcpAncestors.size() == mcpAncestorIdentities.size(),
            "run_controller_inbox_unknown");
    mcpRoot->assertLive();
    require(fileObjectIdentity(mcpRoot->handle.value, owner, true).Stringify() ==
                mcpRootIdentity.Stringify(),
            "run_controller_inbox_unknown");
    for (size_t i = 0; i < mcpAncestors.size(); ++i)
      require(anchorIdentity(mcpAncestors[i].value).Stringify() ==
                  mcpAncestorIdentities[i].Stringify(),
              "run_controller_inbox_unknown");
    for (const auto &entry : inboxes) entry.second.assertLive(package, cohortSids);
  }
  std::wstring inboxState(const std::wstring &teamId, PSID package,
                          const std::vector<std::wstring> *cohortSids = nullptr) const {
    if (remoteController) return L"not_applicable";
    auto found = inboxes.find(teamId);
    require(found != inboxes.end(), "run_controller_inbox_unknown");
    return found->second.assertLive(package, cohortSids);
  }
};
struct ClosedControllerCohortMember {
  SelectedProfile *profile = nullptr;
  SelectedControllerConfig *config = nullptr;
  Handle heldControllerRoot;
  std::wstring memberId, launchNonce, databasePath;
  JsonObject row;
};
struct ClosedControllerCohort {
  std::wstring selectionId;
  std::vector<ClosedControllerCohortMember> members;
  JsonObject identity;
};
static bool samePhysicalIdentity(const JsonObject &left, const JsonObject &right);
struct ControllerRunRootAuthority {
  RetainedAnchorComponent root;
  std::vector<Handle> ancestors;
  std::vector<JsonObject> ancestorIdentities;
  JsonObject identity;

  ControllerRunRootAuthority(std::vector<Handle> heldAncestors, Handle heldRoot)
      : root(std::move(heldRoot)), ancestors(std::move(heldAncestors)) {
    for (const auto &ancestor : ancestors)
      ancestorIdentities.push_back(anchorIdentity(ancestor.value));
    identity = fileObjectIdentity(root.handle.value, currentSid(), true);
  }

  void assertLive(PSID package,
                  const std::vector<std::wstring> *cohortSids) const {
    require(ancestors.size() == ancestorIdentities.size(), "execution_path_alias");
    root.assertLive();
    require(fileIdentity(root.handle.value, currentSid(), true, package, cohortSids)
                .Stringify() == identity.Stringify(),
            "execution_containment_filesystem_denied");
    for (size_t i = 0; i < ancestors.size(); ++i) {
      require(anchorIdentity(ancestors[i].value).Stringify() ==
                  ancestorIdentities[i].Stringify(),
              "execution_path_alias");
      const auto heldPath = text(ancestorIdentities[i], L"dosPath");
      require(heldPath.rfind(L"\\\\?\\", 0) == 0, "execution_path_alias");
      auto reopened = verificationDirectory(heldPath.substr(4));
      require(anchorIdentity(reopened.value).Stringify() ==
                  ancestorIdentities[i].Stringify(),
              "execution_path_alias");
    }
    auto reopened = verificationDirectory(root.path);
    require(fileIdentity(reopened.value, currentSid(), true, package, cohortSids)
                .Stringify() == identity.Stringify(),
            "execution_containment_filesystem_denied");
  }
};
struct ControllerRunAuthority {
  std::wstring teamId;
  JsonObject controllerBaseIdentity;
  std::vector<ControllerRunRootAuthority> roots;

  bool exactRoot(HANDLE file, const std::wstring &path) const {
    for (const auto &root : roots) {
      if (!equalPath(root.root.path, path)) continue;
      require(samePhysicalIdentity(root.identity,
                                   fileObjectIdentity(file, currentSid(), true)),
              "execution_path_alias");
      return true;
    }
    return false;
  }
};
static std::string runControlCanonicalJson(const IJsonValue &value);
static std::vector<std::wstring> closedControllerCohortSids(
    const ClosedControllerCohort &cohort) {
  std::vector<std::wstring> values;
  for (const auto &member : cohort.members) {
    PSID sid = nullptr;
    const auto name = L"AgentTeams.OpenCodeV2." + member.launchNonce;
    require(SUCCEEDED(DeriveAppContainerSidFromAppContainerName(name.c_str(), &sid)) && sid,
            "run_state_start_changed");
    LocalMemory memory{sid};
    LPWSTR value = nullptr;
    require(ConvertSidToStringSidW(sid, &value) != 0, "run_state_start_changed");
    LocalMemory textMemory{value};
    values.emplace_back(value);
  }
  return values;
}
struct OwnerStore;
static bool privateProfileOverlap(const OwnerStore &owners, HANDLE heldRoot);
struct OwnerStore {
private:
  friend struct WindowsNativeRunControlIssuer;
  friend struct WindowsNativeRunStateIssuer;
  std::map<std::wstring, std::unique_ptr<SelectedControllerConfig>> selectedConfigs;
  std::shared_ptr<const ClosedControllerCohort> sealedCohort;
  std::map<std::wstring, std::wstring> memberPreflights;
  std::vector<ControllerRunAuthority> controllerAuthorities;
public:
  std::map<std::wstring, std::unique_ptr<WindowsNativeRunState>> runStates;
  std::map<std::wstring, std::vector<std::wstring>> runStateSelections;
  std::map<std::wstring, std::wstring> runStateRoots;
  std::map<std::wstring, std::unique_ptr<WindowsNativeRunControl>> runControls;
  std::map<std::wstring, OwnerDirectory> directories;
  std::map<std::wstring, SelectedProfile> selectedProfiles;
  // This SID is assigned only from the helper's own private kernel Scope,
  // never from a request. Temporary grants to that contained package preserve
  // the selected profile identity; no other package principal is admitted.
  PSID selectedPackage = nullptr;
  std::uint64_t next = 0;
  bool exactControllerRoot(HANDLE file, const std::wstring &path) const {
    for (const auto &authority : controllerAuthorities)
      if (authority.exactRoot(file, path))
        return true;
    return false;
  }
  bool exactControllerRoot(const RetainedAnchorComponent &anchor,
                           const ClosedControllerCohort &cohort) const {
    for (const auto &authority : controllerAuthorities) {
      if (!authority.exactRoot(anchor.handle.value, anchor.path)) continue;
      for (const auto &member : cohort.members) {
        const auto value = member.row.GetNamedValue(L"controllerRoot");
        if (value.ValueType() != JsonValueType::Object) continue;
        const auto expected = value.GetObject();
        if (samePhysicalIdentity(expected, authority.controllerBaseIdentity) &&
            text(expected, L"ownerSid") ==
                text(authority.controllerBaseIdentity, L"ownerSid"))
          return true;
      }
    }
    return false;
  }
  std::vector<std::wstring> exactControllerCohortSids(
      HANDLE file, const std::wstring &path) const {
    if (!exactControllerRoot(file, path)) return {};
    require(!privateProfileOverlap(*this, file),
            "execution_containment_filesystem_denied");
    require(static_cast<bool>(sealedCohort), "run_state_start_changed");
    return closedControllerCohortSids(*sealedCohort);
  }
  Handle holdSelectedDirectory(const std::wstring &path) {
    auto assertParents = [](const OwnerDirectory &directory) {
      require(directory.parents.size() == directory.parentIdentities.size(),
              "execution_owner_unknown");
      for (size_t i = 0; i < directory.parents.size(); ++i) {
        require(anchorIdentity(directory.parents[i].value).Stringify() ==
                    directory.parentIdentities[i].Stringify(),
                "execution_owner_unknown");
        const auto heldPath = text(directory.parentIdentities[i], L"dosPath");
        require(heldPath.rfind(L"\\\\?\\", 0) == 0, "execution_path_alias");
        auto reopened = verificationDirectory(heldPath.substr(4));
        require(anchorIdentity(reopened.value).Stringify() ==
                    directory.parentIdentities[i].Stringify(),
                "execution_owner_unknown");
      }
    };
    for (auto &entry : directories) {
      if (!equalPath(entry.second.path, path))
        continue;
      assertParents(entry.second);
      require(equalPath(finalPath(entry.second.file.value), extended(path)),
              "execution_owner_unknown");
      const auto cohortSids =
          exactControllerCohortSids(entry.second.file.value, path);
      const auto *cohortSidsPtr = cohortSids.empty() ? nullptr : &cohortSids;
      const bool controllerRoot =
          exactControllerRoot(entry.second.file.value, path);
      require(controllerRoot == !cohortSids.empty(),
              "execution_containment_filesystem_denied");
      const auto identity =
          controllerRoot
              ? fileIdentity(entry.second.file.value, entry.second.owner, true,
                             selectedPackage, cohortSidsPtr)
              : fileObjectIdentity(entry.second.file.value, entry.second.owner, true);
      require(identity.Stringify() == entry.second.identity.Stringify(),
              "execution_owner_unknown");
      HANDLE duplicate = nullptr;
      require(DuplicateHandle(GetCurrentProcess(), entry.second.file.value, GetCurrentProcess(),
                              &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS) != 0,
              "execution_owner_unknown");
      return Handle(duplicate);
    }
    const DWORD access = FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL;
    Handle probe = canonicalDirectory(path, access, nullptr, selectedPackage, false);
    const auto probeIdentity = anchorIdentity(probe.value);
    const auto cohortSids = exactControllerCohortSids(probe.value, path);
    const auto *cohortSidsPtr = cohortSids.empty() ? nullptr : &cohortSids;
    const bool controllerRoot = exactControllerRoot(probe.value, path);
    require(controllerRoot == !cohortSids.empty(),
            "execution_containment_filesystem_denied");
    Handle held =
        controllerRoot
            ? canonicalDirectory(path, access, cohortSidsPtr, selectedPackage, true)
            : canonicalDirectory(path, access, nullptr, selectedPackage, false);
    require(anchorIdentity(held.value).Stringify() ==
                probeIdentity.Stringify(),
            "execution_owner_unknown");
    return held;
  }
  std::vector<Handle> holdSelectedAncestors(const std::wstring &path) {
    require(path.size() >= 3 && GetDriveTypeW(path.substr(0, 3).c_str()) == DRIVE_FIXED,
            "execution_owner_local_volume_required");
    std::vector<Handle> values;
    values.push_back(holdSelectedDirectory(path.substr(0, 3)));
    for (size_t i = 3; i < path.size(); i++)
      if (path[i] == L'\\') values.push_back(holdSelectedDirectory(path.substr(0, i)));
    return values;
  }
private:
  std::wstring nativeLaunchNonce() {
    BYTE random[16]{};
    require(BCryptGenRandom(nullptr, random, sizeof(random),
                            BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0,
            "run_state_start_changed");
    random[6] = static_cast<BYTE>((random[6] & 0x0f) | 0x40);
    random[8] = static_cast<BYTE>((random[8] & 0x3f) | 0x80);
    static const wchar_t hex[] = L"0123456789abcdef";
    std::wstring value;
    for (size_t i = 0; i < sizeof(random); ++i) {
      if (i == 4 || i == 6 || i == 8 || i == 10) value += L'-';
      value += hex[random[i] >> 4];
      value += hex[random[i] & 15];
    }
    return value;
  }
  JsonObject sealedCohortDocument(const std::wstring &auditSelectionId,
                                  const std::vector<std::wstring> &selectionIds) {
    require(!selectionIds.empty() && selectionIds.size() <= 32 &&
                auditSelectionId.size() > 0 && auditSelectionId.size() <= 32 &&
                auditSelectionId.find_first_not_of(L"0123456789") == std::wstring::npos,
            "run_control_selection_missing");
    auto cohort = std::make_shared<ClosedControllerCohort>();
    cohort->selectionId = auditSelectionId;
    JsonArray members;
    std::map<std::wstring, bool> profiles, nonces;
    for (const auto &selectionId : selectionIds) {
      auto selectedConfig = selectedConfigs.find(selectionId);
      require(selectedConfig != selectedConfigs.end(), "run_control_selection_missing");
      auto &config = *selectedConfig->second;
      config.assertConfigLive(selectedPackage);
      config.bindControllerBase();
      auto selectedProfile = selectedProfiles.find(config.rootPath + L"|" + config.databasePath);
      require(selectedProfile != selectedProfiles.end() && selectedProfile->second.database,
              "run_control_selection_missing");
      auto &profile = selectedProfile->second;
      const auto rootIdentity =
          fileIdentity(profile.root.value, profile.owner, true, selectedPackage);
      const auto parentIdentity =
          fileIdentity(profile.parent.value, profile.owner, true, selectedPackage);
      const auto databaseIdentity =
          fileIdentity(profile.database.value, profile.owner, false, selectedPackage);
      const auto configIdentity =
          fileIdentity(config.config.value, config.owner, false, selectedPackage);
      require(rootIdentity.Stringify() == profile.rootIdentity.Stringify() &&
                  parentIdentity.Stringify() == profile.parentIdentity.Stringify() &&
                  databaseIdentity.Stringify() == profile.databaseIdentity.Stringify() &&
                  configIdentity.Stringify() == config.identity.Stringify() &&
                  heldFileSha256(config.config.value) == config.sha256,
              "run_control_selection_changed");
      const std::wstring profileKey = text(rootIdentity, L"volumeSerial") + L":" +
                                      text(rootIdentity, L"fileId") + L":" +
                                      text(databaseIdentity, L"volumeSerial") + L":" +
                                      text(databaseIdentity, L"fileId");
      require(profiles.emplace(profileKey, true).second, "run_state_start_changed");

      IJsonValue controllerRootValue = JsonValue::CreateNullValue();
      Handle controllerRoot;
      if (!config.remoteController) {
        require(static_cast<bool>(config.mcpRoot), "run_controller_inbox_unknown");
        const auto controllerIdentity =
          fileObjectIdentity(config.mcpRoot->handle.value, config.owner, true);
        controllerRootValue = controllerIdentity;
        HANDLE duplicate = nullptr;
        require(DuplicateHandle(GetCurrentProcess(), config.mcpRoot->handle.value,
                                GetCurrentProcess(), &duplicate, 0, FALSE,
                                DUPLICATE_SAME_ACCESS),
                "run_control_selection_changed");
        controllerRoot = Handle(duplicate);
      }

      ClosedControllerCohortMember held;
      held.profile = &profile;
      held.config = &config;
      held.heldControllerRoot = std::move(controllerRoot);
      held.databasePath = config.databasePath;
      held.launchNonce = nativeLaunchNonce();
      require(nonces.emplace(held.launchNonce, true).second, "run_state_start_changed");
      held.memberId = L"member-" + held.launchNonce;
      JsonObject profileRow, configRow, row;
      profileRow.SetNamedValue(L"root", rootIdentity);
      profileRow.SetNamedValue(L"parent", parentIdentity);
      profileRow.SetNamedValue(L"database", databaseIdentity);
      configRow.SetNamedValue(L"identity", configIdentity);
      str(configRow, L"sha256", config.sha256);
      str(row, L"memberId", held.memberId);
      str(row, L"launchNonce", held.launchNonce);
      row.SetNamedValue(L"profile", profileRow);
      row.SetNamedValue(L"config", configRow);
      row.SetNamedValue(L"controllerRoot", controllerRootValue);
      held.row = row;
      members.Append(row);
      cohort->members.push_back(std::move(held));
    }
    JsonObject document;
    num(document, L"version", 1);
    str(document, L"selectionId", auditSelectionId);
    document.SetNamedValue(L"members", members);
    cohort->identity = document;
    if (sealedCohort) {
      require(runControlCanonicalJson(sealedCohort->identity) ==
                  runControlCanonicalJson(cohort->identity),
              "run_state_start_changed");
    } else
      sealedCohort = cohort;
    return document;
  }
  void attachSealedCohort(const JsonObject &document) {
    const auto values = document.GetNamedValue(L"members");
    require(document.HasKey(L"version") && document.GetNamedNumber(L"version") == 1 &&
                document.HasKey(L"selectionId") &&
                values.ValueType() == JsonValueType::Array &&
                values.GetArray().Size() > 0 && values.GetArray().Size() <= 32,
            "run_state_start_changed");
    auto cohort = std::make_shared<ClosedControllerCohort>();
    cohort->selectionId = text(document, L"selectionId");
    for (const auto value : values.GetArray()) {
      require(value.ValueType() == JsonValueType::Object, "run_state_start_changed");
      ClosedControllerCohortMember held;
      held.row = value.GetObject();
      held.memberId = text(held.row, L"memberId");
      held.launchNonce = text(held.row, L"launchNonce");
      cohort->members.push_back(std::move(held));
    }
    cohort->identity = document;
    if (sealedCohort) {
      require(runControlCanonicalJson(sealedCohort->identity) ==
                  runControlCanonicalJson(cohort->identity),
              "run_state_start_changed");
      return;
    }
    sealedCohort = cohort;
  }
  std::wstring assertConfigIsSealed(const SelectedProfile &profile,
                                    const JsonObject &configIdentity,
                                    const IJsonValue &controllerRoot,
                                    const std::wstring &sha256,
                                    const std::wstring &launchNonce) {
    if (!sealedCohort) return L"";
    JsonObject expectedProfile;
    expectedProfile.SetNamedValue(L"root", profile.rootIdentity);
    expectedProfile.SetNamedValue(L"parent", profile.parentIdentity);
    expectedProfile.SetNamedValue(L"database", profile.databaseIdentity);
    std::wstring matched;
    for (const auto &member : sealedCohort->members) {
      const auto configRow = object(member.row, L"config");
      if (object(member.row, L"profile").Stringify() != expectedProfile.Stringify() ||
          object(configRow, L"identity").Stringify() != configIdentity.Stringify() ||
          text(configRow, L"sha256") != sha256 ||
          member.row.GetNamedValue(L"controllerRoot").Stringify() !=
              controllerRoot.Stringify())
        continue;
      require(matched.empty(), "run_state_start_changed");
      matched = member.launchNonce;
    }
    require(!matched.empty() && (launchNonce.empty() || launchNonce == matched),
            "run_state_start_changed");
    return matched;
  }
  std::vector<std::wstring> sealedCohortSids() const {
    require(static_cast<bool>(sealedCohort), "run_state_start_changed");
    return closedControllerCohortSids(*sealedCohort);
  }
  void ensureControllerAuthority(SelectedControllerConfig &config,
                                 const std::wstring &teamId) {
    if (config.remoteController) return;
    require(validTeamId(teamId), "run_state_start_changed");
    const auto cohortSids = sealedCohortSids();
    const auto *cohortSidsPtr = &cohortSids;
    config.bindControllerBase();
    const auto basePhysical =
        fileObjectIdentity(config.mcpRoot->handle.value, config.owner, true);
    require(basePhysical.Stringify() == config.mcpRootIdentity.Stringify(),
            "run_controller_inbox_unknown");
    require(!privateProfileOverlap(*this, config.mcpRoot->handle.value),
            "execution_containment_filesystem_denied");
    bool rowMatch = false;
    for (const auto &member : sealedCohort->members) {
      const auto value = member.row.GetNamedValue(L"controllerRoot");
      if (value.ValueType() != JsonValueType::Object) continue;
      const auto expected = value.GetObject();
      if (samePhysicalIdentity(expected, basePhysical) &&
          text(expected, L"ownerSid") == text(basePhysical, L"ownerSid"))
        rowMatch = true;
    }
    require(rowMatch, "run_state_start_changed");
    for (const auto &authority : controllerAuthorities) {
      if (authority.teamId != teamId ||
          !samePhysicalIdentity(authority.controllerBaseIdentity, basePhysical) ||
          text(authority.controllerBaseIdentity, L"ownerSid") !=
              text(basePhysical, L"ownerSid"))
        continue;
      for (const auto &root : authority.roots) {
        require(!privateProfileOverlap(*this, root.root.handle.value),
                "execution_containment_filesystem_denied");
        root.assertLive(selectedPackage, cohortSidsPtr);
      }
      return;
    }
    ControllerRunAuthority authority;
    authority.teamId = teamId;
    authority.controllerBaseIdentity = basePhysical;
    for (const auto &name : {std::wstring(L"teams"), std::wstring(L"tasks")}) {
      const auto path = config.mcpRootPath + L"\\" + name + L"\\" + teamId;
      auto heldAncestors = verificationAncestors(path);
      Handle heldRoot = verificationDirectory(path);
      require(equalPath(finalPath(heldRoot.value), extended(path)),
              "execution_path_alias");
      require(!privateProfileOverlap(*this, heldRoot.value),
              "execution_containment_filesystem_denied");
      const auto heldIdentity = anchorIdentity(heldRoot.value);
      require(heldIdentity.Stringify() ==
                  anchorIdentity(verificationDirectory(path).value).Stringify() &&
                  samePhysicalIdentity(
                      heldIdentity, fileObjectIdentity(heldRoot.value, currentSid(), true)),
              "execution_path_alias");
      authority.roots.emplace_back(std::move(heldAncestors), std::move(heldRoot));
    }
    controllerAuthorities.push_back(std::move(authority));
    for (const auto &root : controllerAuthorities.back().roots) {
      require(!privateProfileOverlap(*this, root.root.handle.value),
              "execution_containment_filesystem_denied");
      root.assertLive(selectedPackage, cohortSidsPtr);
    }
  }
  bool sealedControllerIdentity(const JsonObject &identity) const {
    if (!sealedCohort) return false;
    for (const auto &member : sealedCohort->members) {
      const auto value = member.row.GetNamedValue(L"controllerRoot");
      if (value.ValueType() != JsonValueType::Object) continue;
      const auto expected = value.GetObject();
      if (text(expected, L"volumeSerial") == text(identity, L"volumeSerial") &&
          text(expected, L"fileId") == text(identity, L"fileId") &&
          text(expected, L"ownerSid") == text(identity, L"ownerSid"))
        return true;
    }
    return false;
  }
public:
  std::pair<Handle, std::wstring> createSpool(const JsonObject &input, const std::wstring &nonce) {
    for (auto root : input.GetNamedArray(L"protectedRoots")) {
      require(root.ValueType() == JsonValueType::String, "execution_owner_unknown");
      std::wstring selected(root.GetString());
      for (auto &entry : directories) {
        auto &directory = entry.second;
        if (!directory.writable || !equalPath(directory.path, selected))
          continue;
        require(equalPath(finalPath(directory.file.value), extended(directory.path)) &&
                    fileIdentity(directory.file.value, directory.owner, true, selectedPackage).Stringify() ==
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
    require(admitted.size() <= 64, "run_control_selection_budget");
    auto key = root + L"|" + database;
    auto found = selectedProfiles.find(key);
    if (found == selectedProfiles.end()) {
      SelectedProfile value;
      value.owner = currentSid();
      value.rootPath = root;
      value.parentPath = parent;
      value.databasePath = database;
      value.ancestors = holdSelectedAncestors(database);
      value.root = holdSelectedDirectory(root);
      value.parent = holdSelectedDirectory(parent);
      value.rootIdentity = fileIdentity(value.root.value, value.owner, true, selectedPackage);
      value.parentIdentity = fileIdentity(value.parent.value, value.owner, true, selectedPackage);
      value.admittedDirectories = admitted;
      for (const auto &path : admitted) {
        SelectedProfileDirectory directory;
        directory.path = path;
        directory.ancestors = holdSelectedAncestors(path);
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
  JsonObject inspectProfileConfig(const JsonObject &input) {
    const auto root = text(input, L"root"), database = text(input, L"databasePath");
    require(database.size() > root.size() + 1 && equalPath(database.substr(0, root.size()), root) &&
                database[root.size()] == L'\\',
            "execution_database_alias");
    const auto owner = currentSid();
    Handle heldRoot(holdSelectedDirectory(root));
    const auto rootIdentity = fileIdentity(heldRoot.value, owner, true, selectedPackage);
    const auto configDirectory = root + L"\\config\\opencode";
    const auto configPath = configDirectory + L"\\opencode.json";
    auto checkedParents = holdSelectedAncestors(root);
    struct Retained {
      std::vector<Handle> parents;
      std::vector<JsonObject> identities;
      void assertLive() const {
        require(parents.size() == identities.size(), "execution_owner_unknown");
        for (size_t i = 0; i < parents.size(); ++i) {
          require(anchorIdentity(parents[i].value).Stringify() == identities[i].Stringify(),
                  "execution_owner_unknown");
          const auto heldPath = finalPath(parents[i].value);
          auto reopened = verificationDirectory(heldPath.substr(4));
          require(anchorIdentity(reopened.value).Stringify() == identities[i].Stringify(),
                  "execution_owner_unknown");
        }
      }
    } retained;
    retained.parents = std::move(checkedParents);
    for (auto &parent : retained.parents)
      retained.identities.push_back(anchorIdentity(parent.value));

    auto open = [&](const std::wstring &path, bool directory) {
      Handle value(CreateFileW(extended(path).c_str(), GENERIC_READ | READ_CONTROL,
                               FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                               OPEN_EXISTING,
                               (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0) |
                                   FILE_FLAG_OPEN_REPARSE_POINT,
                               nullptr));
      if (!value) {
        const DWORD error = GetLastError();
        require(error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND,
                "run_control_selection_missing");
        return Handle();
      }
      require(equalPath(finalPath(value.value), extended(path)), "execution_path_alias");
      fileIdentity(value.value, owner, directory, selectedPackage);
      return value;
    };

    JsonObject result;
    num(result, L"schema", 1);
    flag(result, L"ok", true);
    str(result, L"root", root);
    str(result, L"databasePath", database);
    str(result, L"configPath", configPath);
    flag(result, L"privateAcl", true);
    flag(result, L"reparse", false);
    result.SetNamedValue(L"rootIdentity", rootIdentity);
    retained.identities.push_back(anchorIdentity(heldRoot.value));
    retained.parents.push_back(std::move(heldRoot));
    Handle configParent(open(root + L"\\config", true));
    if (configParent) {
      retained.identities.push_back(anchorIdentity(configParent.value));
      retained.parents.push_back(std::move(configParent));
    }
    Handle directory;
    if (retained.parents.back().value && equalPath(finalPath(retained.parents.back().value), extended(root + L"\\config")))
      directory = open(configDirectory, true);
    if (!directory) {
      str(result, L"state", L"absent");
      result.SetNamedValue(L"configIdentity", JsonValue::CreateNullValue());
      retained.assertLive();
      const DWORD attributes = GetFileAttributesW(extended(configDirectory).c_str());
      const DWORD error = GetLastError();
      require(attributes == INVALID_FILE_ATTRIBUTES &&
                  (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND),
              "run_control_selection_missing");
      return result;
    }
    retained.identities.push_back(anchorIdentity(directory.value));
    retained.parents.push_back(std::move(directory));
    Handle config(open(configPath, false));
    if (!config) {
      str(result, L"state", L"absent");
      result.SetNamedValue(L"configIdentity", JsonValue::CreateNullValue());
      retained.assertLive();
      const DWORD attributes = GetFileAttributesW(extended(configPath).c_str());
      const DWORD error = GetLastError();
      require(attributes == INVALID_FILE_ATTRIBUTES &&
                  (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND),
              "run_control_selection_missing");
      return result;
    }
    FILE_STANDARD_INFO before{};
    require(GetFileInformationByHandleEx(config.value, FileStandardInfo, &before, sizeof(before)) &&
                before.EndOfFile.QuadPart >= 0 && before.EndOfFile.QuadPart <= 4 * 1024 * 1024,
            "run_control_config_budget");
    const auto configIdentity = fileIdentity(config.value, owner, false, selectedPackage);
    FILE_STANDARD_INFO after{};
    require(GetFileInformationByHandleEx(config.value, FileStandardInfo, &after, sizeof(after)) &&
                before.EndOfFile.QuadPart == after.EndOfFile.QuadPart,
            "run_control_config_identity");
    str(result, L"state", before.EndOfFile.QuadPart == 0 ? L"incomplete" : L"complete");
    result.SetNamedValue(L"configIdentity", configIdentity);
    retained.assertLive();
    return result;
  }
  JsonObject selectConfig(const JsonObject &input) {
    require(selectedConfigs.size() < 64, "run_control_selection_budget");
    auto root = text(input, L"root"), database = text(input, L"databasePath");
    auto teamId = text(input, L"teamId");
    require(validTeamId(teamId), "run_control_selection_missing");
    auto found = selectedProfiles.find(root + L"|" + database);
    require(found != selectedProfiles.end(), "run_control_selection_missing");
    auto &selected = found->second;
    auto directory = root + L"\\config\\opencode";
    auto configPath = directory + L"\\opencode.json";
    auto expectedHash = text(input, L"sha256");
    require(expectedHash.size() == 64 &&
                expectedHash.find_first_not_of(L"0123456789abcdef") == std::wstring::npos,
            "run_control_config_identity");
    require(std::find(selected.admittedDirectories.begin(), selected.admittedDirectories.end(),
                      directory) != selected.admittedDirectories.end(),
            "run_control_selection_missing");
    require(fileIdentity(selected.root.value, selected.owner, true, selectedPackage).Stringify() ==
                selected.rootIdentity.Stringify(), "run_control_selection_changed");
    // The config pathname is fixed by the existing private selected profile,
    // never an arbitrary basename, serialized HANDLE or ExpectedBinding DTO.
    auto checkedParents = holdSelectedAncestors(configPath);
    Handle config(CreateFileW(extended(configPath).c_str(), GENERIC_READ | READ_CONTROL,
                               FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                               FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(static_cast<bool>(config) && equalPath(finalPath(config.value), extended(configPath)),
            "run_control_config_identity");
    fileIdentity(config.value, selected.owner, false, selectedPackage);
    FILE_STANDARD_INFO configSize{};
    require(GetFileInformationByHandleEx(config.value, FileStandardInfo, &configSize,
                                         sizeof(configSize)) &&
                configSize.EndOfFile.QuadPart >= 0 && configSize.EndOfFile.QuadPart <= 4 * 1024 * 1024,
            "run_control_config_budget");
    require(heldFileSha256(config.value) == expectedHash, "run_control_config_identity");
    HANDLE rootDuplicate = nullptr;
    require(DuplicateHandle(GetCurrentProcess(), selected.root.value, GetCurrentProcess(),
                             &rootDuplicate, 0, FALSE, DUPLICATE_SAME_ACCESS),
            "run_control_selection_changed");
    HANDLE databaseDuplicate = nullptr;
    if (selected.database)
      require(DuplicateHandle(GetCurrentProcess(), selected.database.value, GetCurrentProcess(),
                              &databaseDuplicate, 0, FALSE, DUPLICATE_SAME_ACCESS),
              "run_control_selection_changed");
    const auto id = decimal(++next);
    selectedConfigs.emplace(id, std::unique_ptr<SelectedControllerConfig>(
        new SelectedControllerConfig(Handle(rootDuplicate), Handle(databaseDuplicate),
                                     std::move(config), root, database, configPath,
                                     selected.owner, expectedHash, teamId, selectedPackage,
                                     std::move(checkedParents))));
    JsonObject result;
    num(result, L"schema", 1);
    flag(result, L"ok", true);
    str(result, L"selectionId", id);
    str(result, L"root", root);
    str(result, L"path", configPath);
    str(result, L"sha256", expectedHash);
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
    auto parents = holdSelectedAncestors(path);
    require(!parents.empty(), "execution_owner_path_invalid");
    auto parentPath = path.substr(0, path.find_last_of(L'\\'));
    Handle targetParent;
    // Existing creator capabilities already hold DELETE and deny sharing it.
    // A duplicate references that same kernel file object without another open
    // or a share-mode relaxation; its original traversal right is preserved.
    for (auto &entry : directories) {
      if (!equalPath(entry.second.path, parentPath))
        continue;
      const auto parentCohortSids =
          exactControllerCohortSids(entry.second.file.value, parentPath);
      const auto *parentCohortSidsPtr =
          parentCohortSids.empty() ? nullptr : &parentCohortSids;
      require(equalPath(finalPath(entry.second.file.value), extended(parentPath)) &&
                  fileIdentity(entry.second.file.value, owner, true, selectedPackage,
                               parentCohortSidsPtr)
                          .Stringify() ==
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
      targetParent = holdSelectedDirectory(parentPath);
    parents.back() = std::move(targetParent);
    std::vector<std::wstring> cohortSids;
    const std::vector<std::wstring> *cohortSidsPtr = nullptr;
    if (!create) {
      Handle probe = verificationDirectory(path);
      cohortSids = exactControllerCohortSids(probe.value, path);
      cohortSidsPtr = cohortSids.empty() ? nullptr : &cohortSids;
    }
    auto file = ownerDirectory(path, create, owner, cohortSidsPtr, selectedPackage);
    require(exactControllerRoot(file.value, path) == !cohortSids.empty(),
            "execution_containment_filesystem_denied");
    auto id = fileIdentity(file.value, owner, true, selectedPackage, cohortSidsPtr);
    auto key = decimal(++next);
    std::vector<JsonObject> parentIdentities;
    for (const auto &parent : parents) parentIdentities.push_back(anchorIdentity(parent.value));
    OwnerDirectory held{std::move(file), std::move(parents), std::move(parentIdentities), path,
                        owner, id, create};
    auto inserted = directories.emplace(key, std::move(held));
    auto result = describe(inserted.first->second);
    str(result, L"handleId", key);
    return result;
  }
  OwnerDirectory &held(const JsonObject &input) {
    auto it = directories.find(text(input, L"handleId"));
    require(it != directories.end(), "execution_owner_unknown");
    auto &directory = it->second;
    require(directory.parents.size() == directory.parentIdentities.size(),
            "execution_owner_unknown");
    for (size_t i = 0; i < directory.parents.size(); ++i) {
      const auto parentIdentity = anchorIdentity(directory.parents[i].value);
      require(parentIdentity.Stringify() == directory.parentIdentities[i].Stringify(),
              "execution_owner_unknown");
      const auto heldPath = text(parentIdentity, L"dosPath");
      require(heldPath.rfind(L"\\\\?\\", 0) == 0, "execution_path_alias");
      auto reopened = verificationDirectory(heldPath.substr(4));
      require(anchorIdentity(reopened.value).Stringify() ==
                  directory.parentIdentities[i].Stringify(),
              "execution_owner_unknown");
    }
    const auto cohortSids =
        exactControllerCohortSids(directory.file.value, directory.path);
    const auto *cohortSidsPtr = cohortSids.empty() ? nullptr : &cohortSids;
    require(exactControllerRoot(directory.file.value, directory.path) == !cohortSids.empty(),
            "execution_containment_filesystem_denied");
    require(equalPath(finalPath(directory.file.value), extended(directory.path)) &&
                fileIdentity(directory.file.value, directory.owner, true, selectedPackage,
                             cohortSidsPtr)
                        .Stringify() == directory.identity.Stringify(),
            "execution_owner_unknown");
    auto reopened = verificationDirectory(directory.path);
    require(fileIdentity(reopened.value, directory.owner, true, selectedPackage, cohortSidsPtr)
                .Stringify() ==
                directory.identity.Stringify(),
            "execution_owner_unknown");
    directoryMode(directory.file.value);
    return directory;
  }
  JsonObject writeMetadata(const JsonObject &input) {
    require(input.Size() == 4 && text(input, L"op") == L"ownerWriteMetadata" &&
                input.HasKey(L"handleId") && input.HasKey(L"purpose") &&
                input.HasKey(L"bytesBase64"), "execution_invalid_response");
    const auto purpose = text(input, L"purpose");
    require(purpose == L"ProbeGuard" || purpose == L"ProbeRecord",
            "execution_owner_metadata_purpose_invalid");
    auto data = unbase64(text(input, L"bytesBase64"), 128 * 1024 - 1);
    require(wide(base64(data)) == text(input, L"bytesBase64"),
            "execution_owner_metadata_invalid");
    if (purpose == L"ProbeGuard") {
      require(data.empty(), "execution_owner_metadata_budget");
    } else {
      require(!data.empty(), "execution_owner_metadata_budget");
      try {
        (void)JsonObject::Parse(wide(std::string(data.begin(), data.end())));
      } catch (...) { throw NativeError{"execution_owner_metadata_invalid"}; }
    }
    auto &directory = held(input);
    require(directory.owner == currentSid(), "execution_owner_unknown");
    const std::wstring probeNamespace = L"\\opencode\\v2\\execution-probes\\";
    require(directory.path.size() > probeNamespace.size() + 64,
            "execution_owner_metadata_purpose_invalid");
    const auto sourceKey = directory.path.substr(directory.path.size() - 64);
    require(sourceKey.find_first_not_of(L"0123456789abcdef") == std::wstring::npos &&
                equalPath(directory.path.substr(directory.path.size() - 64 - probeNamespace.size(),
                                                probeNamespace.size()), probeNamespace),
            "execution_owner_metadata_purpose_invalid");
    SharedAclMutex mutation(directory.identity);
    held(input);
    const std::wstring name = purpose == L"ProbeGuard" ? L"owner.lock" : L"probe.json";
    LocalMemory descriptor;
    const auto sddl = L"O:" + directory.owner + L"D:P(A;;FA;;;SY)(A;;FA;;;" + directory.owner + L")";
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.c_str(), SDDL_REVISION_1, &descriptor.value, nullptr) != 0,
            "execution_owner_unknown");
    auto create = reinterpret_cast<NtCreateFileFunction>(
        GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
    auto set = reinterpret_cast<NtSetFileFunction>(
        GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtSetInformationFile"));
    auto convert = reinterpret_cast<NtStatusErrorFunction>(
        GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
    require(create && set && convert, "execution_owner_unknown");
    const auto open = [&](const std::wstring &basename, bool fresh) {
      UNICODE_STRING relative{};
      relative.Buffer = const_cast<wchar_t *>(basename.data());
      relative.Length = static_cast<USHORT>(basename.size() * sizeof(wchar_t));
      relative.MaximumLength = relative.Length;
      OBJECT_ATTRIBUTES attributes{};
      attributes.Length = sizeof(attributes);
      attributes.RootDirectory = directory.file.value;
      attributes.ObjectName = &relative;
      attributes.Attributes = 0x40;
      attributes.SecurityDescriptor = fresh ? descriptor.value : nullptr;
      IO_STATUS_BLOCK completion{};
      HANDLE raw = nullptr;
      const auto status = create(&raw, GENERIC_READ | READ_CONTROL | SYNCHRONIZE |
          (fresh ? GENERIC_WRITE | DELETE : 0), &attributes, &completion, nullptr,
          FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_DELETE,
          fresh ? FILE_CREATE : FILE_OPEN,
          0x40 | 0x20 | 0x200000 | (fresh ? 0x2 : 0), nullptr, 0);
      Handle file(raw);
      if (status != 0 || completion.Status != 0) {
        const auto native = status != 0 ? status : completion.Status;
        if (!fresh && static_cast<DWORD>(native) == 0xc0000034UL) return Handle();
        throw NativeError{"execution_owner_unknown", convert(native),
                          "owner_metadata_open", static_cast<DWORD>(native)};
      }
      require(equalPath(finalPath(file.value), extended(directory.path + L"\\" + basename)),
              "execution_owner_metadata_changed");
      fileIdentity(file.value, directory.owner, false, selectedPackage);
      return file;
    };
    auto existing = open(name, false);
    JsonObject previousIdentity;
    if (existing) {
      previousIdentity = fileIdentity(existing.value, directory.owner, false, selectedPackage);
      FILE_STANDARD_INFO size{};
      require(GetFileInformationByHandleEx(existing.value, FileStandardInfo, &size, sizeof(size)) &&
                  size.EndOfFile.QuadPart >= 0 && size.EndOfFile.QuadPart < 128 * 1024 &&
                  (purpose != L"ProbeGuard" || size.EndOfFile.QuadPart == 0),
              "execution_owner_metadata_budget");
      if (purpose == L"ProbeRecord") {
        const auto old = heldFileBytes(existing.value, 128 * 1024 - 1);
        try { (void)JsonObject::Parse(wide(std::string(old.begin(), old.end()))); }
        catch (...) { throw NativeError{"execution_owner_metadata_invalid"}; }
      }
    }
    if (purpose == L"ProbeGuard") {
      if (!existing) {
        auto file = open(name, true);
        require(FlushFileBuffers(file.value), "execution_owner_unknown");
      }
    } else {
      const auto temporary = L".probe." + nativeLaunchNonce() + L".tmp";
      auto file = open(temporary, true);
      const auto identity = fileIdentity(file.value, directory.owner, false, selectedPackage);
      bool published = false;
      try {
        DWORD written = 0;
        require(WriteFile(file.value, data.data(), static_cast<DWORD>(data.size()), &written, nullptr) &&
                    written == data.size() && FlushFileBuffers(file.value), "execution_owner_unknown");
        held(input);
        auto named = open(name, false);
        require(static_cast<bool>(named) == static_cast<bool>(existing) &&
                    (!named || fileIdentity(named.value, directory.owner, false, selectedPackage)
                        .Stringify() == previousIdentity.Stringify()), "execution_owner_metadata_changed");
        const size_t size = offsetof(FILE_RENAME_INFO, FileName) + name.size() * sizeof(wchar_t);
        std::vector<BYTE> bytes(size);
        auto rename = reinterpret_cast<FILE_RENAME_INFO *>(bytes.data());
        rename->ReplaceIfExists = existing ? TRUE : FALSE;
        rename->RootDirectory = directory.file.value;
        rename->FileNameLength = static_cast<DWORD>(name.size() * sizeof(wchar_t));
        memcpy(rename->FileName, name.data(), rename->FileNameLength);
        IO_STATUS_BLOCK completion{};
        const auto status = set(file.value, &completion, rename, static_cast<ULONG>(size),
                                static_cast<FILE_INFORMATION_CLASS>(10));
        if (status != 0 || completion.Status != 0) {
          const auto native = status != 0 ? status : completion.Status;
          throw NativeError{"execution_owner_unknown", convert(native),
                            "owner_metadata_publish", static_cast<DWORD>(native)};
        }
        published = true;
        require(FlushFileBuffers(file.value) &&
                    equalPath(finalPath(file.value), extended(directory.path + L"\\" + name)) &&
                    fileIdentity(file.value, directory.owner, false, selectedPackage).Stringify() ==
                        identity.Stringify(), "execution_owner_metadata_changed");
      } catch (...) {
        // Delete only the exact unexposed temporary file we created. A failed
        // rename with an uncertain new name must never unlink probe.json.
        if (!published && equalPath(finalPath(file.value),
                                    extended(directory.path + L"\\" + temporary))) {
          require(fileIdentity(file.value, directory.owner, false, selectedPackage).Stringify() ==
                      identity.Stringify(), "execution_owner_metadata_changed");
          FILE_DISPOSITION_INFO disposition{TRUE};
          require(SetFileInformationByHandle(file.value, FileDispositionInfo, &disposition,
                                              sizeof(disposition)) != 0,
                  "execution_owner_unknown", "owner_metadata_cleanup");
        }
        throw;
      }
    }
    held(input);
    JsonObject read;
    str(read, L"op", L"ownerReadMetadata");
    str(read, L"handleId", text(input, L"handleId"));
    str(read, L"purpose", purpose);
    return readMetadata(read);
  }
  JsonObject readMetadata(const JsonObject &input) {
    require(input.Size() == 3 && input.HasKey(L"op"), "execution_invalid_response");
    require(text(input, L"op") == L"ownerReadMetadata", "execution_invalid_response");
    const auto purpose = text(input, L"purpose");
    if (purpose == L"SelectedAuth") {
      require(input.HasKey(L"selectionId") && !input.HasKey(L"handleId") &&
                  input.GetNamedValue(L"selectionId").ValueType() == JsonValueType::String,
              "execution_invalid_response");
      const auto selectionId = text(input, L"selectionId");
      auto selected = selectedConfigs.find(selectionId);
      require(selected != selectedConfigs.end(), "run_control_selection_missing");
      auto &config = *selected->second;
      config.assertConfigLive(selectedPackage);
      SelectedProfile *profile = nullptr;
      for (auto &entry : selectedProfiles) {
        auto &candidate = entry.second;
        if (candidate.rootPath != config.rootPath || candidate.owner != config.owner)
          continue;
        require(fileIdentity(candidate.root.value, candidate.owner, true, selectedPackage)
                        .Stringify() == candidate.rootIdentity.Stringify() &&
                    fileIdentity(config.root.value, config.owner, true, selectedPackage)
                            .Stringify() == fileIdentity(candidate.root.value, candidate.owner,
                                                         true, selectedPackage).Stringify(),
                "run_control_selection_changed");
        profile = &candidate;
        break;
      }
      require(profile != nullptr, "run_control_selection_missing");
      const auto root = profile->rootPath;
      const auto dataPath = root + L"\\data";
      const auto opencodePath = dataPath + L"\\opencode";
      const auto authPath = opencodePath + L"\\auth.json";
      require(std::find(profile->admittedDirectories.begin(),
                        profile->admittedDirectories.end(), dataPath) !=
                      profile->admittedDirectories.end() ||
                  std::find(profile->admittedDirectories.begin(),
                            profile->admittedDirectories.end(), opencodePath) !=
                      profile->admittedDirectories.end(),
              "run_control_selection_missing");
      std::vector<JsonObject> parentProof;
      auto verificationParents = verificationAncestors(authPath);
      for (const auto &parent : verificationParents)
        parentProof.push_back(anchorIdentity(parent.value));
      auto dataDirectory = verificationDirectory(dataPath);
      auto opencodeDirectory = verificationDirectory(opencodePath);
      const auto dataIdentity = fileIdentity(dataDirectory.value, profile->owner, true,
                                             selectedPackage);
      const auto opencodeIdentity = fileIdentity(opencodeDirectory.value, profile->owner, true,
                                                 selectedPackage);
      auto assertSelectionLive = [&]() {
        config.assertConfigLive(selectedPackage);
        require(profile->directories.size() == profile->admittedDirectories.size(),
                "run_control_selection_changed");
        for (size_t i = 0; i < profile->directories.size(); ++i) {
          const auto &directory = profile->directories[i];
          require(directory.path == profile->admittedDirectories[i] &&
                      fileIdentity(directory.file.value, profile->owner, true, selectedPackage)
                              .Stringify() == directory.identity.Stringify(),
                  "run_control_selection_changed");
        }
        require(fileIdentity(profile->root.value, profile->owner, true, selectedPackage)
                        .Stringify() == profile->rootIdentity.Stringify() &&
                    fileIdentity(config.root.value, config.owner, true, selectedPackage)
                            .Stringify() == profile->rootIdentity.Stringify(),
                "run_control_selection_changed");
        require(fileIdentity(dataDirectory.value, profile->owner, true, selectedPackage)
                        .Stringify() == dataIdentity.Stringify() &&
                    fileIdentity(opencodeDirectory.value, profile->owner, true, selectedPackage)
                            .Stringify() == opencodeIdentity.Stringify(),
                "run_control_selection_changed");
        auto reopened = verificationAncestors(authPath);
        require(reopened.size() == parentProof.size(), "run_control_selection_changed");
        for (size_t i = 0; i < reopened.size(); ++i)
          require(anchorIdentity(reopened[i].value).Stringify() == parentProof[i].Stringify(),
                  "run_control_selection_changed");
      };
      assertSelectionLive();
      for (int attempt = 0; attempt < 3; ++attempt) {
        Handle file(CreateFileW(extended(authPath).c_str(), GENERIC_READ | READ_CONTROL,
                                FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                                FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (!file) {
          const DWORD error = GetLastError();
          require(error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND,
                  "execution_owner_metadata_missing");
          require(attempt < 2, "execution_owner_metadata_changed");
          continue;
        }
        require(equalPath(finalPath(file.value), extended(authPath)),
                "execution_owner_metadata_changed");
        FILE_STANDARD_INFO before{};
        require(GetFileInformationByHandleEx(file.value, FileStandardInfo, &before, sizeof(before)) &&
                    before.EndOfFile.QuadPart > 0 &&
                    before.EndOfFile.QuadPart <= 128 * 1024,
                "execution_owner_metadata_budget");
        const auto identity = fileIdentity(file.value, profile->owner, false, selectedPackage);
        const auto bytes = heldFileBytes(file.value, 128 * 1024);
        FILE_STANDARD_INFO after{};
        require(GetFileInformationByHandleEx(file.value, FileStandardInfo, &after, sizeof(after)) &&
                    before.EndOfFile.QuadPart == after.EndOfFile.QuadPart &&
                    after.EndOfFile.QuadPart == static_cast<LONGLONG>(bytes.size()),
                "execution_owner_metadata_changed");
        Handle named(CreateFileW(extended(authPath).c_str(),
                                 GENERIC_READ | FILE_READ_ATTRIBUTES | READ_CONTROL,
                                 FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                                 FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        const auto authSha256 = heldFileSha256(file.value);
        require(static_cast<bool>(named) && equalPath(finalPath(named.value), extended(authPath)) &&
                    fileIdentity(named.value, profile->owner, false, selectedPackage).Stringify() ==
                        identity.Stringify() &&
                    fileIdentity(file.value, profile->owner, false, selectedPackage).Stringify() ==
                        identity.Stringify(),
                "execution_owner_metadata_changed");
        assertSelectionLive();
        JsonObject result;
        num(result, L"schema", 1);
        flag(result, L"ok", true);
        str(result, L"purpose", purpose);
        str(result, L"path", authPath);
        result.SetNamedValue(L"fileIdentity", identity);
        num(result, L"bytes", bytes.size());
        str(result, L"sha256", authSha256);
        flag(result, L"privateAcl", true);
        flag(result, L"reparse", false);
        num(result, L"links", 1);
        result.SetNamedValue(L"rootIdentity", profile->rootIdentity);
        result.SetNamedValue(L"directoryIdentity",
                             fileIdentity(opencodeDirectory.value, profile->owner, true,
                                          selectedPackage));
        return result;
      }
      throw NativeError{"execution_owner_metadata_changed"};
    }
    require(input.HasKey(L"handleId") && !input.HasKey(L"selectionId") &&
                input.GetNamedValue(L"handleId").ValueType() == JsonValueType::String,
            "execution_invalid_response");
    require(purpose == L"ProbeGuard" || purpose == L"ProbeRecord",
            "execution_owner_metadata_purpose_invalid");
    auto &directory = held(input);
    require(directory.owner == currentSid(), "execution_owner_unknown");
    const std::wstring name = purpose == L"ProbeGuard" ? L"owner.lock" : L"probe.json";
    const DWORD limit = purpose == L"ProbeGuard" ? 0 : 128 * 1024 - 1;
    const auto target = directory.path + L"\\" + name;
    for (int attempt = 0; attempt < 3; ++attempt) {
      Handle file(CreateFileW(extended(target).c_str(), GENERIC_READ | READ_CONTROL,
                              FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                              FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      JsonObject result;
      num(result, L"schema", 1);
      flag(result, L"ok", true);
      str(result, L"purpose", purpose);
      str(result, L"path", target);
      result.SetNamedValue(L"directoryIdentity", directory.identity);
      if (!file) {
        const DWORD error = GetLastError();
        require(purpose == L"ProbeRecord" &&
                    (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND),
                "execution_owner_metadata_missing");
       held(input);
       if (attempt < 2) continue;
        Handle named(CreateFileW(extended(target).c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
                               FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                               FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        require(!named, "execution_owner_metadata_changed");
        const DWORD absentError = GetLastError();
        require(absentError == ERROR_FILE_NOT_FOUND || absentError == ERROR_PATH_NOT_FOUND,
                "execution_owner_metadata_changed");
       result.SetNamedValue(L"fileIdentity", JsonValue::CreateNullValue());
        num(result, L"bytes", 0);
        flag(result, L"absent", true);
        flag(result, L"privateAcl", true);
        flag(result, L"reparse", false);
        num(result, L"links", 1);
        return result;
      }
      require(equalPath(finalPath(file.value), extended(target)),
              "execution_owner_metadata_changed");
      FILE_STANDARD_INFO before{};
      require(GetFileInformationByHandleEx(file.value, FileStandardInfo, &before, sizeof(before)) &&
                  before.EndOfFile.QuadPart >= 0 &&
                  before.EndOfFile.QuadPart <= static_cast<LONGLONG>(limit) &&
                  (purpose != L"ProbeGuard" || before.EndOfFile.QuadPart == 0),
              "execution_owner_metadata_budget");
      const auto identity = fileIdentity(file.value, directory.owner, false, selectedPackage);
      const auto bytes = heldFileBytes(file.value, limit);
      FILE_STANDARD_INFO after{};
      require(GetFileInformationByHandleEx(file.value, FileStandardInfo, &after, sizeof(after)) &&
                  before.EndOfFile.QuadPart == after.EndOfFile.QuadPart &&
                  after.EndOfFile.QuadPart == static_cast<LONGLONG>(bytes.size()),
              "execution_owner_metadata_changed");
      Handle named(CreateFileW(extended(target).c_str(),
                               GENERIC_READ | FILE_READ_ATTRIBUTES | READ_CONTROL,
                               FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                               FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      require(static_cast<bool>(named) && equalPath(finalPath(named.value), extended(target)) &&
                  fileIdentity(named.value, directory.owner, false, selectedPackage).Stringify() ==
                      identity.Stringify() &&
                  fileIdentity(file.value, directory.owner, false, selectedPackage).Stringify() ==
                      identity.Stringify(),
              "execution_owner_metadata_changed");
      held(input);
      if (purpose == L"ProbeRecord") {
        require(!bytes.empty() && bytes.size() < 128 * 1024,
                "execution_owner_metadata_budget");
        try {
          (void)JsonObject::Parse(wide(std::string(bytes.begin(), bytes.end())));
        } catch (...) {
          throw NativeError{"execution_owner_metadata_invalid"};
        }
        str(result, L"bytesBase64", wide(base64(bytes)));
      }
      result.SetNamedValue(L"fileIdentity", identity);
      num(result, L"bytes", bytes.size());
      flag(result, L"privateAcl", true);
      flag(result, L"reparse", false);
      num(result, L"links", 1);
      return result;
    }
    throw NativeError{"execution_owner_metadata_changed"};
  }
  JsonObject request(const std::wstring &operation, const JsonObject &input);
  JsonObject requestAfterRunStateIssuer(const std::wstring &operation, const JsonObject &input) {
    if (operation == L"ownerInspectProfileConfig")
      return inspectProfileConfig(input);
    if (operation == L"ownerSelectConfig")
      return selectConfig(input);
    if (operation == L"ownerValidateSelectedProfile")
      return validateSelectedProfile(input);
    if (operation == L"ownerOpenDirectory")
      return open(input);
    if (operation == L"ownerReadMetadata")
      return readMetadata(input);
    if (operation == L"ownerWriteMetadata")
      return writeMetadata(input);
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
      require(fileIdentity(directory.file.value, directory.owner, true, selectedPackage).Stringify() ==
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
#include "WindowsNativeRunState.hpp"
#include "WindowsNativeRunControl.hpp"
// Self-image custody is deliberately not a general copy/path operation. Its
// only source is this process, its only destination is a fixed producer-SHA
// slot, and all writes use the existing native private creation primitives.
struct NativeSelfImageCustody {
  std::vector<RetainedAnchorComponent> parents;
  Handle source, selected;
  std::wstring owner, sourcePath, path, sha256;

  static void protectedPrivate(HANDLE file, const std::wstring &owner, bool directory) {
    (void)fileIdentity(file, owner, directory); // No package/cohort grants here.
    PSECURITY_DESCRIPTOR raw = nullptr;
    require(GetSecurityInfo(file, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                            nullptr, nullptr, nullptr, nullptr, &raw) == ERROR_SUCCESS,
            "execution_owner_not_private");
    LocalMemory descriptor{raw};
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    require(GetSecurityDescriptorControl(raw, &control, &revision) &&
                (control & SE_DACL_PROTECTED), "execution_owner_not_private",
            "private_image_protected_dacl");
  }

  explicit NativeSelfImageCustody(const std::wstring &producerSha, bool bootstrap)
      : owner(currentSid()), sourcePath(image(GetCurrentProcess())), sha256(producerSha) {
    using Control = WindowsNativeRunControl;
    require(sha256.size() == 64 &&
                sha256.find_first_not_of(L"0123456789abcdef") == std::wstring::npos,
            "execution_containment_helper_identity");
    for (auto &parent : ancestors(sourcePath)) parents.emplace_back(std::move(parent));
    source = Handle(CreateFileW(extended(sourcePath).c_str(), GENERIC_READ | READ_CONTROL,
                               FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                               FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(source && equalPath(finalPath(source.value), extended(sourcePath)),
            "execution_containment_helper_identity");
    auto sourcePin = Control::runControlObserveFile(source.value, false);
    sourcePin.sha256 = Control::runControlSha256(source.value);
    require(Control::runControlHashHex(sourcePin.sha256) == sha256 &&
                Control::runControlSameFile(sourcePin,
                    Control::runControlProcessImagePin(GetCurrentProcess())),
            "execution_containment_helper_identity");
    std::vector<wchar_t> environment(32768);
    const DWORD count = GetEnvironmentVariableW(L"LOCALAPPDATA", environment.data(),
                                               static_cast<DWORD>(environment.size()));
    require(count > 0 && count < environment.size(), "execution_containment_profile_denied");
    const std::wstring local(environment.data(), count);
    for (auto &parent : ancestors(local)) parents.emplace_back(std::move(parent));
    parents.emplace_back(canonicalDirectory(local));
    // Reuse the owner-checked native mutex to serialize publication. A slot is
    // never replaced or repaired, including a partial slot from a failed write.
    SharedAclMutex publication(anchorIdentity(parents.back().handle.value));
    auto directory = local;
    for (const auto &name : {std::wstring(L"AgentTeams.OpenCodeV2.Native"), sha256}) {
      directory += L"\\" + name;
      try {
        auto existing = canonicalDirectory(directory);
      } catch (const NativeError &error) {
        require(bootstrap && error.win32 == ERROR_FILE_NOT_FOUND,
                "execution_containment_helper_identity");
        auto created = ownerDirectory(directory, true, owner);
      }
      auto held = ownerDirectory(directory, false, owner);
      protectedPrivate(held.value, owner, true);
      parents.emplace_back(std::move(held));
    }
    const std::wstring name = L"opencode-v2-windows-helper.exe";
    path = directory + L"\\" + name;
    require(bootstrap || equalPath(sourcePath, path), "execution_containment_helper_identity");
    auto create = reinterpret_cast<NtCreateFileFunction>(
        GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
    require(create != nullptr, "execution_containment_helper_identity");
    LocalMemory descriptor;
    const std::wstring sddl = L"O:" + owner + L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + owner + L")";
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.c_str(), SDDL_REVISION_1, &descriptor.value, nullptr),
            "execution_owner_unknown");
    UNICODE_STRING relative{};
    relative.Buffer = const_cast<wchar_t *>(name.data());
    relative.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
    relative.MaximumLength = relative.Length;
    OBJECT_ATTRIBUTES attributes{};
    attributes.Length = sizeof(attributes);
    attributes.RootDirectory = parents.back().handle.value;
    attributes.ObjectName = &relative;
    attributes.Attributes = 0x40;
    attributes.SecurityDescriptor = descriptor.value;
    const auto open = [&](bool exclusiveCreate) {
      IO_STATUS_BLOCK completion{};
      HANDLE raw = nullptr;
      const NTSTATUS status = create(
          &raw, GENERIC_READ | READ_CONTROL | SYNCHRONIZE |
                    (exclusiveCreate ? GENERIC_WRITE : 0),
          &attributes, &completion, nullptr, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ,
          exclusiveCreate ? FILE_CREATE : FILE_OPEN,
          0x40 | 0x20 | 0x200000, nullptr, 0); // regular, synchronous, no reparse
      if (status != 0 || completion.Status != 0) {
        Handle failed(raw);
        const NTSTATUS native = status != 0 ? status : completion.Status;
        if (!exclusiveCreate && static_cast<DWORD>(native) == 0xc0000034UL) return Handle();
        auto convert = reinterpret_cast<NtStatusErrorFunction>(
            GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
        throw NativeError{"execution_containment_helper_identity", convert ? convert(native) : 0,
                          "private_image_open", static_cast<DWORD>(native)};
      }
      return Handle(raw);
    };
    selected = open(false);
    if (!selected) {
      require(bootstrap, "execution_containment_helper_identity");
      auto target = open(true);
      protectedPrivate(target.value, owner, false);
      require(SetFilePointerEx(source.value, LARGE_INTEGER{}, nullptr, FILE_BEGIN),
              "execution_containment_helper_identity");
      BYTE buffer[65536];
      for (;;) {
        DWORD read = 0, written = 0;
        require(ReadFile(source.value, buffer, sizeof(buffer), &read, nullptr),
                "execution_containment_helper_identity");
        if (!read) break;
        require(WriteFile(target.value, buffer, read, &written, nullptr) && written == read,
                "execution_containment_helper_identity");
      }
      require(FlushFileBuffers(target.value), "execution_containment_helper_identity");
      const auto writtenPin = Control::runControlObserveFile(target.value, false);
      require(Control::runControlSha256(target.value) == sourcePin.sha256,
              "execution_containment_helper_identity");
      target.reset(); // Drop the writer before retaining deny-write/delete custody.
      selected = open(false);
      require(selected && Control::runControlSameFile(writtenPin,
                  Control::runControlObserveFile(selected.value, false)),
              "execution_containment_helper_identity");
    }
    protectedPrivate(selected.value, owner, false);
    auto pin = Control::runControlObserveFile(selected.value, false);
    pin.sha256 = sourcePin.sha256;
    require(equalPath(finalPath(selected.value), extended(path)) &&
                pin.size == sourcePin.size,
            "execution_containment_helper_identity");
    (void)Control::runControlVerifyImage(selected.value, pin);
    (void)Control::runControlVerifyImage(source.value, sourcePin);
    for (const auto &parent : parents) parent.assertLive();
    if (!bootstrap)
      require(Control::runControlSameFile(sourcePin, pin),
              "execution_containment_helper_identity");
  }
  JsonObject receipt() const {
    JsonObject value;
    str(value, L"sourcePath", sourcePath);
    str(value, L"path", path);
    str(value, L"sha256", sha256);
    value.SetNamedValue(L"identity", fileIdentity(selected.value, owner, false));
    flag(value, L"privateAcl", true);
    flag(value, L"protectedDacl", true);
    return value;
  }
};
struct Scope;
static void removeGrants(Scope &scope);
struct Scope {
  Handle job, process, thread, pipe, cancel, readerFinished, spool, inputFile, outputFile, errorFile;
  std::unique_ptr<NativeCommandStore> commands;
  std::unique_ptr<WindowsNativeRunControl> ownedPairControl;
  bool ownedPairClosed = false;
  LocalMemory sid, network, pipeDescriptor;
  std::wstring profile, launchNonce, pipeName, cwd, ownedPairSelectionId;
  DWORD pid = 0;
  JsonObject mapping;
  std::atomic<bool> stopping{false}, mainExitPublished{false};
  std::thread reader, mainExit;
  std::mutex pipeMutex;
  std::vector<RetainedAnchorComponent> aclRoots;
  std::vector<RetainedRealpathAnchor> realpathAnchors;
  std::unique_ptr<RetainedRealpathDll> realpathDll;
  std::shared_ptr<const ClosedControllerCohort> cohort;
  OwnerStore *owners = nullptr;
  bool physicalCleanupProof = false;
  void assertRealpathAnchorsLive() const {
    require(!stopping, "execution_identity_mismatch");
    for (const auto &anchor : realpathAnchors)
      anchor.assertLive();
    if (realpathDll) realpathDll->assertLive();
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
    if (mainExit.joinable())
      mainExit.join();
    if (ownedPairControl) {
      try {
        auto closed = ownedPairControl->shutdown();
        if (closed.GetNamedBoolean(L"complete", false)) ownedPairControl.reset();
        else (void)ownedPairControl.release();
      } catch (...) { (void)ownedPairControl.release(); } // UNKNOWN keeps its held I/O custody.
    }
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
          require(!exited() || text(packet, L"type") == L"closed", "execution_identity_mismatch");
          event(L"message", packet);
        }
      }
    } catch (...) {
      // The same terminal event covers rejected frames and unexpected EOF.
    }
    if (!stopping && !exited()) {
      JsonObject value = JsonObject::Parse(mapping.Stringify());
      str(value, L"code", L"execution_containment_pipe_denied");
      num(value, L"clientPID", pid);
      event(L"failed", value);
      if (job)
        TerminateJobObject(job.value, 99);
    }
  }
  void publishMainExit() {
    require(WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0, "execution_identity_unknown");
    DWORD code = 0;
    require(GetExitCodeProcess(process.value, &code) != 0, "execution_identity_unknown");
    if (mainExitPublished.exchange(true)) return;
    JsonObject value;
    value.SetNamedValue(L"mapping", mapping);
    flag(value, L"heldProcessExited", true);
    num(value, L"exitCode", code);
    event(L"mainExited", value);
  }
  void observeMainExit() {
    HANDLE events[] = {process.value, cancel.value};
    const DWORD waited = WaitForMultipleObjects(2, events, FALSE, INFINITE);
    if (waited == WAIT_OBJECT_0) {
      // Drain the authenticated reader's final closed ACK before notifying the
      // host. Cancellation instead leaves publication to retire after its join.
      HANDLE drained[] = {readerFinished.value, cancel.value};
      const DWORD ready = WaitForMultipleObjects(2, drained, FALSE, INFINITE);
      if (ready == WAIT_OBJECT_0) publishMainExit();
      else require(ready == WAIT_OBJECT_0 + 1, "execution_identity_unknown");
    } else require(waited == WAIT_OBJECT_0 + 1, "execution_identity_unknown");
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
    if (mainExit.joinable())
      mainExit.join();
    publishMainExit();
    if (ownedPairControl) {
      auto closed = ownedPairControl->shutdown();
      require(closed.GetNamedBoolean(L"complete", false) &&
                  !closed.GetNamedBoolean(L"cleanupUnknown", true), "cleanup_unknown");
      ownedPairControl.reset();
      ownedPairClosed = true;
    }
    if (commands)
      commands->retireAll();
    inputFile.reset();
    outputFile.reset();
    errorFile.reset();
    spool.reset();
    JsonObject value;
    flag(value, L"empty", true);
    flag(value, L"heldProcessExited", true);
    if (ownedPairClosed) flag(value, L"ownedPairClosed", true);
    physicalCleanupProof = true;
    num(value, L"activeProcesses", 0);
    value.SetNamedValue(L"mapping", mapping);
    return value;
  }
};
static Handle scopeAclDirectory(const RetainedAnchorComponent &anchor) {
  anchor.assertLive();
  Handle handle(CreateFileW(extended(anchor.path).c_str(),
                            READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                            OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                            nullptr));
  require(handle && anchorIdentity(handle.value).Stringify() == anchor.identity.Stringify(),
          "execution_containment_filesystem_denied");
  return handle;
}
static bool samePhysicalIdentity(const JsonObject &left, const JsonObject &right) {
  return text(left, L"volumeSerial") == text(right, L"volumeSerial") &&
         text(left, L"fileId") == text(right, L"fileId");
}
static std::wstring identityPath(const JsonObject &identity) {
  auto value = text(identity, L"dosPath");
  require(value.rfind(L"\\\\?\\", 0) == 0, "execution_path_alias");
  return value.substr(4);
}
static bool pathOverlap(const std::wstring &left, const std::wstring &right) {
  if (equalPath(left, right)) return true;
  const auto contains = [](const std::wstring &parent, const std::wstring &child) {
    if (parent.size() > child.size() || !equalPath(parent, child.substr(0, parent.size())))
      return false;
    return parent.size() == child.size() || parent.back() == L'\\' ||
           child[parent.size()] == L'\\';
  };
  return contains(left, right) || contains(right, left);
}
static bool privateProfileOverlap(const OwnerStore &owners, HANDLE heldRoot) {
  const auto rootIdentity = anchorIdentity(heldRoot);
  const auto rootPhysical = fileObjectIdentity(heldRoot, currentSid(), true);
  require(samePhysicalIdentity(rootIdentity, rootPhysical), "execution_path_alias");
  for (const auto &entry : owners.selectedProfiles) {
    const auto &profile = entry.second;
    const auto privateIdentity = anchorIdentity(profile.root.value);
    auto reopened = verificationDirectory(profile.rootPath);
    require(anchorIdentity(reopened.value).Stringify() == privateIdentity.Stringify(),
            "execution_path_alias");
    const auto privatePhysical = fileObjectIdentity(profile.root.value, profile.owner, true);
    require(samePhysicalIdentity(privateIdentity, privatePhysical) &&
                samePhysicalIdentity(privatePhysical, profile.rootIdentity) &&
                text(privatePhysical, L"ownerSid") ==
                    text(profile.rootIdentity, L"ownerSid") &&
                equalPath(identityPath(privateIdentity), profile.rootPath),
            "execution_path_alias");
    if (samePhysicalIdentity(rootIdentity, privateIdentity) ||
        pathOverlap(identityPath(rootIdentity), identityPath(privateIdentity)))
      return true;
  }
  return false;
}
bool sealedControllerRoot(const Scope &scope,
                          const RetainedAnchorComponent &anchor) {
  return scope.cohort && scope.owners &&
         scope.owners->exactControllerRoot(anchor, *scope.cohort);
}
static bool privateCohortRoot(const Scope &scope,
                              const RetainedAnchorComponent &anchor) {
  if (!scope.cohort) return false;
  require(scope.owners, "execution_containment_filesystem_denied");
  anchor.assertLive();
  const auto identity = anchorIdentity(anchor.handle.value);
  require(identity.Stringify() == anchor.identity.Stringify() &&
              samePhysicalIdentity(
                  identity,
                  fileObjectIdentity(anchor.handle.value, currentSid(), true)),
          "execution_path_alias");
  const bool privateOverlap = privateProfileOverlap(*scope.owners, anchor.handle.value);
  const bool controllerRoot = sealedControllerRoot(scope, anchor);
  require(!(privateOverlap && controllerRoot), "execution_containment_filesystem_denied");
  if (privateOverlap) return false;
  return controllerRoot ||
         (anchor.sharedRoot && samePhysicalIdentity(identity, anchor.identity));
}
static void grantRoot(Scope &scope, Handle heldRoot, DWORD mask, ACCESS_MODE mode,
                      bool sharedRoot = false) {
  RetainedAnchorComponent anchor(std::move(heldRoot), sharedRoot);
  const auto owner = currentSid();
  const auto physicalIdentity = fileObjectIdentity(anchor.handle.value, owner, true);
  // Any retained root may be shared with another native-held scope. Serialize
  // its short DACL transaction even when it is not a sealed controller root.
  SharedAclMutex aclMutex(physicalIdentity);
  auto handle = scopeAclDirectory(anchor);
  require(anchorIdentity(handle.value).Stringify() == anchor.identity.Stringify(),
          "execution_containment_filesystem_denied");
  require(fileObjectIdentity(handle.value, owner, true).Stringify() ==
              physicalIdentity.Stringify(),
          "execution_containment_filesystem_denied");
  const bool privateGrant =
      mode == GRANT_ACCESS && privateCohortRoot(scope, anchor);
  const auto cohortSids =
      privateGrant ? closedControllerCohortSids(*scope.cohort) : std::vector<std::wstring>();
  const auto *cohortSidsPtr = privateGrant ? &cohortSids : nullptr;
  const auto before =
      aclCustody(handle.value, owner, scope.sid.value, cohortSidsPtr,
                 "execution_containment_filesystem_denied");
  require(fileObjectIdentity(handle.value, owner, true).Stringify() ==
              fileObjectIdentity(anchor.handle.value, owner, true).Stringify(),
          "execution_containment_filesystem_denied");
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
  const HANDLE heldAcl = handle.value;
  scope.aclRoots.emplace_back(std::move(handle), sharedRoot, privateGrant);
  require(SetSecurityInfo(heldAcl, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr,
                          next, nullptr) == ERROR_SUCCESS,
          "execution_containment_filesystem_denied");
  scope.aclRoots.back().assertLive();
  require(anchorIdentity(heldAcl).Stringify() == scope.aclRoots.back().identity.Stringify(),
          "execution_containment_filesystem_denied");
  require(fileObjectIdentity(heldAcl, owner, true).Stringify() ==
              fileObjectIdentity(anchor.handle.value, owner, true).Stringify(),
          "execution_containment_filesystem_denied");
  const auto after =
      aclCustody(heldAcl, owner, scope.sid.value, cohortSidsPtr,
                 "execution_containment_filesystem_denied");
  require(after.siblings == before.siblings, "execution_containment_filesystem_denied");
  require(mode != GRANT_ACCESS || after.memberAllowed,
          "execution_containment_filesystem_denied");
  require(mode != DENY_ACCESS || after.memberAllowed == before.memberAllowed,
          "execution_containment_filesystem_denied");
}
static void removeGrants(Scope &scope) {
  if (scope.realpathDll && scope.realpathDll->granted && scope.physicalCleanupProof)
    scope.realpathDll->changeAce(REVOKE_ACCESS);
  std::vector<RetainedAnchorComponent> retained;
  for (auto it = scope.aclRoots.rbegin(); it != scope.aclRoots.rend(); ++it) {
    const auto owner = currentSid();
    const auto identity = it->identity;
    const HANDLE handle = it->handle.value;
    const auto physicalIdentity = fileObjectIdentity(handle, owner, true);
    const bool privateGrant =
        it->cohortPolicy && privateCohortRoot(scope, *it);
    const bool shared = it->sharedRoot || privateGrant;
    if (shared && !scope.physicalCleanupProof) {
      retained.insert(retained.begin(), std::move(*it));
      continue;
    }
    SharedAclMutex aclMutex(physicalIdentity);
    it->assertLive();
    require(anchorIdentity(handle).Stringify() == identity.Stringify(), "cleanup_unknown");
    const auto heldIdentity = fileObjectIdentity(handle, owner, true);
    const auto cohortSids =
        privateGrant ? closedControllerCohortSids(*scope.cohort) : std::vector<std::wstring>();
    const auto *cohortSidsPtr = privateGrant ? &cohortSids : nullptr;
    const auto before = aclCustody(handle, owner, scope.sid.value, cohortSidsPtr, "cleanup_unknown");
    PACL previous = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr,
                            nullptr, &previous, nullptr, &descriptor) == ERROR_SUCCESS,
            "cleanup_unknown");
    LocalMemory original{descriptor};
    EXPLICIT_ACCESSW entry{};
    entry.grfAccessMode = REVOKE_ACCESS;
    BuildTrusteeWithSidW(&entry.Trustee, scope.sid.value);
    PACL next = nullptr;
    require(SetEntriesInAclW(1, &entry, previous, &next) == ERROR_SUCCESS, "cleanup_unknown");
    LocalMemory nextMemory{next};
    require(SetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr,
                            nullptr, next, nullptr) == ERROR_SUCCESS,
            "cleanup_unknown");
    it->assertLive();
    require(anchorIdentity(handle).Stringify() == it->identity.Stringify(), "cleanup_unknown");
    require(fileObjectIdentity(handle, owner, true).Stringify() == heldIdentity.Stringify(),
            "cleanup_unknown");
    const auto after = aclCustody(handle, owner, scope.sid.value, cohortSidsPtr, "cleanup_unknown");
    require(after.siblings == before.siblings && !after.memberAllowed, "cleanup_unknown");
  }
  scope.aclRoots = std::move(retained);
}
struct Scope;
static std::unique_ptr<Scope> launch(const JsonObject &input, OwnerStore &owners);
// Only this native friend may construct the header capability. All pins are
// measured from an existing selected-profile cache and the actual CreateProcess
// acquisition; no request can supply PIDs, birth values, FilePins or peer DTOs.
struct WindowsNativeRunControlIssuer {
private:
  friend std::unique_ptr<Scope> launch(const JsonObject &, OwnerStore &);
  static std::shared_ptr<const ClosedControllerCohort> prepareLaunchCohort(
      OwnerStore &owners, const std::wstring &nonce) {
    const auto preflight = owners.memberPreflights.find(nonce);
    if (!owners.sealedCohort && preflight == owners.memberPreflights.end())
      return {};
    require(static_cast<bool>(owners.sealedCohort) &&
                preflight != owners.memberPreflights.end(),
            "run_state_start_changed");
    size_t matches = 0;
    for (const auto &member : owners.sealedCohort->members)
      if (member.launchNonce == nonce) ++matches;
    require(matches == 1, "run_state_start_changed");
    return owners.sealedCohort;
  }

  static void prepareOwnedPair(OwnerStore &owners, Scope &scope,
                               const std::wstring &selectionId,
                               const std::wstring &nonce) {
    require(scope.ownedPairSelectionId.empty(), "run_control_selection_changed");
    auto found = owners.selectedConfigs.find(selectionId);
    require(found != owners.selectedConfigs.end(), "run_control_selection_missing");
    auto &selected = *found->second;
    const auto cohortSids =
        owners.sealedCohort ? owners.sealedCohortSids() : std::vector<std::wstring>();
    const auto *cohortSidsPtr = owners.sealedCohort ? &cohortSids : nullptr;
    if (owners.sealedCohort) {
      auto profile = owners.selectedProfiles.find(selected.rootPath + L"|" +
                                                  selected.databasePath);
      require(profile != owners.selectedProfiles.end(), "run_control_selection_missing");
      IJsonValue controllerRootValue = JsonValue::CreateNullValue();
      if (!selected.remoteController) {
        selected.bindControllerBase();
        require(static_cast<bool>(selected.mcpRoot), "run_controller_inbox_unknown");
        const auto physical =
            fileObjectIdentity(selected.mcpRoot->handle.value, selected.owner, true);
        require(owners.sealedControllerIdentity(physical),
                "run_control_selection_changed");
        controllerRootValue = physical;
      }
      const auto sealedNonce = owners.assertConfigIsSealed(
          profile->second,
          fileIdentity(selected.config.value, selected.owner, false, owners.selectedPackage),
          controllerRootValue, selected.sha256, nonce);
      require(sealedNonce == nonce && scope.launchNonce == nonce,
              "run_state_start_changed");
      const auto preflight = owners.memberPreflights.find(nonce);
      require(preflight != owners.memberPreflights.end() &&
                  static_cast<bool>(owners.sealedCohort),
              "run_state_start_changed");
      auto stateEntry = owners.runStates.find(preflight->second);
      require(stateEntry != owners.runStates.end() &&
                  static_cast<bool>(stateEntry->second),
              "run_state_start_changed");
      auto &state = *stateEntry->second;
      require(state.cohortSealed() &&
                  runControlCanonicalJson(state.cohort()) ==
                      runControlCanonicalJson(owners.sealedCohort->identity),
              "run_state_start_changed");
      const auto teamId = text(state.binding(), L"teamId");
      require(validTeamId(teamId) && teamId == selected.selectionTeamId,
              "run_state_start_changed");
      if (!selected.remoteController) {
        owners.ensureControllerAuthority(selected, teamId);
        selected.bindInbox(teamId, cohortSidsPtr);
      }
      selected.assertLive(owners.selectedPackage, cohortSidsPtr);
    } else {
      selected.assertConfigLive(owners.selectedPackage);
    }
    scope.ownedPairSelectionId = selectionId;
  }

public:
  static std::unique_ptr<WindowsNativeRunControl> issueOwnedPair(
      OwnerStore &owners, Scope &scope, const std::wstring &selectionId,
      const std::wstring &nonce, const std::wstring &lease) {
    require(scope.ownedPairSelectionId == selectionId,
            "run_control_selection_changed");
    auto found = owners.selectedConfigs.find(selectionId);
    require(found != owners.selectedConfigs.end(), "run_control_selection_missing");
    auto &selected = *found->second;
    const auto cohortSids =
        owners.sealedCohort ? owners.sealedCohortSids() : std::vector<std::wstring>();
    const auto *cohortSidsPtr = owners.sealedCohort ? &cohortSids : nullptr;
    if (owners.sealedCohort || selected.remoteController)
      selected.assertLive(scope.sid.value, cohortSidsPtr);
    else
      selected.assertConfigLive(scope.sid.value);
    if (owners.sealedCohort) {
      auto profile = owners.selectedProfiles.find(selected.rootPath + L"|" +
                                                  selected.databasePath);
      require(profile != owners.selectedProfiles.end(), "run_control_selection_missing");
      IJsonValue controllerRootValue = JsonValue::CreateNullValue();
      if (selected.mcpRoot) {
        const auto physical =
            fileObjectIdentity(selected.mcpRoot->handle.value, selected.owner, true);
        require(owners.sealedControllerIdentity(physical), "run_control_selection_changed");
        controllerRootValue =
            fileObjectIdentity(selected.mcpRoot->handle.value, selected.owner, true);
      }
      const auto sealedNonce = owners.assertConfigIsSealed(
          profile->second, fileIdentity(selected.config.value, selected.owner, false,
                                        scope.sid.value),
          controllerRootValue, selected.sha256, nonce);
      require(sealedNonce == nonce && scope.launchNonce == nonce,
              "run_state_start_changed");
    }
    using Control = WindowsNativeRunControl;
    const auto parentPid = Control::runControlParentPid(GetCurrentProcess());
    require(parentPid > 0 && parentPid <= MAXDWORD, "run_control_parent_join");
    Handle parent(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE,
                               static_cast<DWORD>(parentPid)));
    require(static_cast<bool>(parent), "run_control_parent_join");
    Handle executable(CreateFileW(extended(image(GetCurrentProcess())).c_str(),
                                   GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr,
                                   OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(static_cast<bool>(executable), "run_control_process_identity");
    Control::HeldInputs held;
    held.selectedDirectory = selected.root.value;
    held.config = selected.config.value;
    held.intendedBun = parent.value;
    held.processImage = executable.value;
    held.selectedPackage = scope.sid.value;
    held.packagePeerProcess = scope.process.value;
    held.packagePeerSid = scope.sid.value;
    held.localRole = Control::Role::server;
    held.expected.root = Control::runControlObserveFile(selected.root.value, true);
    held.expected.config = Control::runControlObserveFile(selected.config.value, false);
    held.expected.image = Control::runControlObserveFile(executable.value, false);
    held.expected.image.sha256 = Control::runControlSha256(executable.value);
    held.expected.parent = Control::runControlObserveProcess(parent.value);
    held.expected.server = Control::runControlObserveProcess(GetCurrentProcess());
    held.expected.client = Control::runControlObserveProcess(scope.process.value);
    // This is an owned main-Bun peer checkpoint. It must not be reported as a
    // fresh CLI client capability: the latter needs its own held acquisition.
    held.sealedPath = selected.path;
    held.sealedBinding = nonce + L":" + lease + L":" + selectionId;
    auto binding = narrow(held.sealedBinding);
    held.expected.bytes.assign(binding.begin(), binding.end());
    return std::unique_ptr<Control>(new Control(held));
  }
};

// The state issuer is the sole authority that turns an already-held selected
// controller and exact run-root capability into an opaque state/control pair.
// Request directories, endpoint DTOs and PID strings never select a state.
struct WindowsNativeRunStateIssuer {
  using State = WindowsNativeRunState;
  using Control = WindowsNativeRunControl;

  static void validateRunNamespace(const std::wstring &directory,
                                   const std::wstring &dataRoot) {
    require(directory.rfind(dataRoot + L"\\opencode\\v2\\runs\\", 0) == 0,
            "run_state_identity_changed");
    const auto basename = directory.substr(directory.find_last_of(L'\\') + 1);
    require(basename.size() == 32 &&
                basename.find_first_not_of(L"0123456789abcdef") == std::wstring::npos,
            "run_state_identity_changed");
  }

private:
  // Read-only discovery of one missing namespace component. All opens are
  // existing-only and relative to a retained parent; no state/control is issued.
  static bool namespaceAbsent(OwnerStore &owners, const std::wstring &directory,
                              const std::wstring &dataRoot) {
    validateRunNamespace(directory, dataRoot);
    const auto basename = directory.substr(directory.find_last_of(L'\\') + 1);
    require(directory == dataRoot + L"\\opencode\\v2\\runs\\" + basename,
            "run_state_identity_changed");
    const auto owner = currentSid();
    std::vector<RetainedAnchorComponent> ancestors;
    for (auto &parent : owners.holdSelectedAncestors(dataRoot))
      ancestors.emplace_back(std::move(parent));
    std::vector<RetainedAnchorComponent> prefix;
    // Closed role labels only; preserve the original failed predicate and codes.
    auto inRole = [](const char *role, auto action) {
      try { return action(); }
      catch (const NativeError &error) {
        if (error.stage && std::strcmp(error.stage, "private_acl_owner") == 0)
          throw NativeError{error.code, error.win32, role, error.nativeStatus};
        throw;
      }
    };
    const char *roles[] = {"private_acl_owner_run_data_root", "private_acl_owner_run_opencode",
                          "private_acl_owner_run_v2", "private_acl_owner_run_runs",
                          "private_acl_owner_run_leaf"};
    prefix.emplace_back(inRole(roles[0], [&] { return owners.holdSelectedDirectory(dataRoot); }));
    auto identified = [&](HANDLE file, size_t index) {
      require(index < 5, "run_state_identity_changed");
      return inRole(roles[index], [&] { return fileIdentity(file, owner, true); });
    };
    const auto rootIdentity = identified(prefix.front().handle.value, 0);
    auto recheck = [&](bool absence) {
      for (const auto &parent : ancestors) parent.assertLive();
      for (size_t index = 0; index < prefix.size(); ++index) {
        const auto &part = prefix[index];
        part.assertLive();
        if (absence) {
          (void)identified(part.handle.value, index);
          auto named = verificationDirectory(part.path);
          require(identified(named.value, index).Stringify() ==
                      identified(part.handle.value, index).Stringify(),
                  "run_state_identity_changed");
        }
      }
      require(identified(prefix.front().handle.value, 0).Stringify() ==
                  rootIdentity.Stringify(), "run_state_identity_changed");
    };
    auto openChild = [](HANDLE parent, const std::wstring &name) {
      auto create = reinterpret_cast<NtCreateFileFunction>(
          GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
      require(create != nullptr, "run_state_unknown");
      UNICODE_STRING relative{};
      relative.Buffer = const_cast<wchar_t *>(name.data());
      relative.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
      relative.MaximumLength = relative.Length;
      OBJECT_ATTRIBUTES attributes{};
      attributes.Length = sizeof(attributes);
      attributes.RootDirectory = parent;
      attributes.ObjectName = &relative;
      attributes.Attributes = 0x40;
      IO_STATUS_BLOCK completion{};
      HANDLE raw = nullptr;
      const NTSTATUS status = create(
          &raw, FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
          &attributes, &completion, nullptr, FILE_ATTRIBUTE_DIRECTORY,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          1 /* FILE_OPEN */, 0x1 | 0x20 | 0x200000, nullptr, 0);
      if (status != 0 || completion.Status != 0) {
        Handle failed(raw);
        const auto native = status != 0 ? status : completion.Status;
        // A single basename under a held parent admits NAME_NOT_FOUND only.
        // Access, path, sharing and identity failures are never absence.
        if (static_cast<DWORD>(native) == 0xc0000034UL) return Handle();
        auto convert = reinterpret_cast<NtStatusErrorFunction>(
            GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
        throw NativeError{"run_state_unknown", convert ? convert(native) : 0,
                          "run_namespace_open", static_cast<DWORD>(native)};
      }
      return Handle(raw);
    };
    for (const auto &name : std::vector<std::wstring>{L"opencode", L"v2", L"runs", basename}) {
      recheck(false);
      auto child = openChild(prefix.back().handle.value, name);
      if (!child) {
        recheck(true);
        auto repeated = openChild(prefix.back().handle.value, name);
        require(!repeated, "run_state_identity_changed");
        recheck(true);
        return true;
      }
      require(equalPath(finalPath(child.value), extended(prefix.back().path + L"\\" + name)),
              "run_state_identity_changed");
      prefix.emplace_back(std::move(child));
    }
    recheck(false);
    return false;
  }

public:
  static std::vector<std::wstring> selectionIds(const JsonObject &input,
                                               bool discovery = false) {
    require(input.HasKey(L"selectionIds") && input.GetNamedValue(L"selectionIds").ValueType() ==
                                                JsonValueType::Array,
            "run_control_selection_missing");
    const auto values = input.GetNamedArray(L"selectionIds");
    require((discovery || values.Size() > 0) && values.Size() <= 32, "run_control_selection_missing");
    std::vector<std::wstring> ids;
    for (const auto value : values) {
      require(value.ValueType() == JsonValueType::String, "run_control_selection_missing");
      std::wstring id(value.GetString());
      require(id.size() > 0 && id.size() <= 32 &&
                  id.find_first_not_of(L"0123456789") == std::wstring::npos,
              "run_control_selection_missing");
      ids.push_back(std::move(id));
    }
    for (size_t i = 1; i < ids.size(); ++i)
      require(std::find(ids.begin(), ids.begin() + static_cast<std::ptrdiff_t>(i), ids[i]) ==
                  ids.begin() + static_cast<std::ptrdiff_t>(i),
              "run_control_selection_missing");
    return ids;
  }
  static std::pair<std::wstring, SelectedControllerConfig *> selectionFor(
      OwnerStore &owners, const std::wstring &dataRoot, const std::vector<std::wstring> &ids,
      const JsonObject &binding) {
    const auto first = selectionForConfigOnly(owners, dataRoot, ids);
    const auto teamId = text(binding, L"teamId");
    require(validTeamId(teamId), "run_state_start_changed");
    const auto cohortSids =
        owners.sealedCohort ? owners.sealedCohortSids() : std::vector<std::wstring>();
    const auto *cohortSidsPtr = owners.sealedCohort ? &cohortSids : nullptr;
    for (const auto &id : ids) {
      auto &selected = *owners.selectedConfigs.at(id);
      if (!selected.remoteController) {
        if (owners.sealedCohort)
          owners.ensureControllerAuthority(selected, teamId);
        selected.bindInbox(teamId, cohortSidsPtr);
      }
      selected.assertLive(owners.selectedPackage, cohortSidsPtr);
      (void)selected.inboxState(teamId, owners.selectedPackage, cohortSidsPtr);
    }
    return first;
  }

  static std::pair<std::wstring, SelectedControllerConfig *> selectionForConfigOnly(
      OwnerStore &owners, const std::wstring &dataRoot,
      const std::vector<std::wstring> &ids) {
    const std::wstring root = extended(dataRoot);
    std::pair<std::wstring, SelectedControllerConfig *> first{L"", nullptr};
    for (const auto &id : ids) {
      auto found = owners.selectedConfigs.find(id);
      require(found != owners.selectedConfigs.end(), "run_control_selection_missing");
      auto &selected = *found->second;
      const std::wstring selectedRoot = extended(selected.rootPath);
      require(selectedRoot == root || selectedRoot.rfind(root + L"\\", 0) == 0,
              "run_control_selection_missing");
      selected.assertConfigLive(owners.selectedPackage);
      if (!first.second)
        first = {id, &selected};
    }
    require(first.second != nullptr, "run_control_selection_missing");
    return first;
  }

  static State &issueState(OwnerStore &owners, const std::wstring &dataRoot,
                           const std::wstring &directory, bool create,
                           bool &created,
                           const std::vector<std::wstring> &selectionIds) {
    require(selectionIds.size() <= 32, "run_control_selection_budget");
    if (!selectionIds.empty())
      (void)selectionForConfigOnly(owners, dataRoot, selectionIds);
    for (auto &entry : owners.runStates) {
      if (entry.second->directory() != directory)
        continue;
      require(owners.runStateRoots[entry.first] == dataRoot, "run_state_identity_changed");
      if (!selectionIds.empty())
        require(owners.runStateSelections[entry.first] == selectionIds,
                "run_control_selection_missing");
      created = false;
      return *entry.second;
    }
    const std::wstring owner = currentSid();
    auto root = owners.holdSelectedDirectory(dataRoot);
    const JsonObject rootIdentity = fileIdentity(root.value, owner, true);
    std::vector<Handle> parents = owners.holdSelectedAncestors(directory);
    require(parents.size() >= 4, "run_state_held_inputs");
    Handle run;
    try {
      // Run state mutates child records, never renames its directory. Keep the
      // original deny-delete sharing fence, without unused DELETE access that
      // can conflict with the filesystem's relative rename target-directory open.
      run = ownerDirectory(directory, create, owner, nullptr, nullptr, false);
    } catch (const NativeError &error) {
      if (!create && error.win32 == ERROR_FILE_NOT_FOUND)
        throw NativeError{"run_state_absent", error.win32, "run_state_directory"};
      throw;
    }
    HANDLE rawServer = nullptr, rawParent = nullptr;
    require(DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), GetCurrentProcess(),
                            &rawServer, 0, FALSE, DUPLICATE_SAME_ACCESS),
            "run_state_held_inputs");
    const auto parentPid = Control::runControlParentPid(GetCurrentProcess());
    require(parentPid > 0 && parentPid <= MAXDWORD, "run_state_held_inputs");
    rawParent = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE,
                            static_cast<DWORD>(parentPid));
    require(rawParent != nullptr, "run_state_held_inputs");
    auto state = std::unique_ptr<State>(new State(
        std::move(parents), std::move(root), std::move(run), rootIdentity, owner,
        directory, dataRoot, Handle(rawServer), Handle(rawParent)));
    const auto id = state->id();
    if (!selectionIds.empty()) owners.runStateSelections[id] = selectionIds;
    owners.runStateRoots[id] = dataRoot;
    owners.runStates.emplace(id, std::move(state));
    created = true;
    return *owners.runStates[id];
  }

  static State &stateFor(OwnerStore &owners, const JsonObject &input, bool create,
                         bool &created) {
    const auto directory = text(input, L"directory");
    const auto dataRoot = text(input, L"dataRoot");
    validateRunNamespace(directory, dataRoot);
    return issueState(owners, dataRoot, directory, create, created, selectionIds(input));
  }

  static State &namedState(OwnerStore &owners, const JsonObject &input) {
    const auto id = text(input, L"stateId");
    auto found = owners.runStates.find(id);
    require(found != owners.runStates.end(), "run_state_missing");
    require(found->second->directory() == text(input, L"directory"), "run_state_identity_changed");
    return *found->second;
  }

  static std::unique_ptr<Control> issueControl(OwnerStore &owners, State &state,
                                               Control::Role role) {
    const auto &selectionIds = owners.runStateSelections[state.id()];
    require(!selectionIds.empty(), "run_control_selection_missing");
    const auto cohortSids =
        owners.sealedCohort ? owners.sealedCohortSids() : std::vector<std::wstring>();
    const auto *cohortSidsPtr = owners.sealedCohort ? &cohortSids : nullptr;
    for (const auto &selectionId : selectionIds) {
      auto selected = owners.selectedConfigs.find(selectionId);
      require(selected != owners.selectedConfigs.end(), "run_control_selection_missing");
      selected->second->assertLive(owners.selectedPackage, cohortSidsPtr);
    }
    const auto selectedId = selectionIds.front();
    auto selected = owners.selectedConfigs.find(selectedId);
    require(selected != owners.selectedConfigs.end(), "run_control_selection_missing");
    auto &config = *selected->second;
    const auto parentPid = Control::runControlParentPid(GetCurrentProcess());
    require(parentPid > 0 && parentPid <= MAXDWORD, "run_control_parent_join");
    Handle parent(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE,
                              static_cast<DWORD>(parentPid)));
    require(static_cast<bool>(parent), "run_control_parent_join");
    Handle executable(CreateFileW(extended(image(GetCurrentProcess())).c_str(), GENERIC_READ | READ_CONTROL,
                                 FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                 FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(static_cast<bool>(executable), "run_control_process_identity");
    Control::HeldInputs held;
    held.selectedDirectory = config.root.value;
    held.config = config.config.value;
    held.intendedBun = parent.value;
    held.processImage = executable.value;
    held.selectedPackage = owners.selectedPackage;
    held.localRole = role;
    held.runState = &state;
    held.fixedPeer = false;
    held.sealedPath = config.path;
    const auto bindingBytes = narrow(std::wstring(state.binding().Stringify()));
    held.sealedBinding.assign(bindingBytes.begin(), bindingBytes.end());
    held.expected.bytes.assign(bindingBytes.begin(), bindingBytes.end());
    held.expected.root = Control::runControlObserveFile(config.root.value, true);
    held.expected.config = Control::runControlObserveFile(config.config.value, false);
    held.expected.image = Control::runControlObserveFile(executable.value, false);
    held.expected.image.sha256 = Control::runControlSha256(executable.value);
    held.expected.parent = Control::runControlObserveProcess(parent.value);
    held.expected.server = Control::runControlObserveProcess(GetCurrentProcess());
    held.expected.client = held.expected.server;
    return std::unique_ptr<Control>(new Control(std::move(held)));
  }

  static void exactObject(const JsonObject &value, const std::vector<std::wstring> &names,
                          const char *code) {
    size_t count = 0;
    for (auto pair : value) {
      const std::wstring key(pair.Key());
      require(std::find(names.begin(), names.end(), key) != names.end(), code);
      ++count;
    }
    require(count == names.size(), code);
  }

  static void validateRequestBinding(const JsonObject &binding) {
    exactObject(binding,
                {L"teamId", L"runId", L"controllerInstanceId", L"ownerId"},
                "run_state_start_changed");
    require(validTeamId(text(binding, L"teamId")) &&
                !text(binding, L"runId").empty() &&
                !text(binding, L"controllerInstanceId").empty() &&
                !text(binding, L"ownerId").empty(),
            "run_state_start_changed");
  }

  static void validateStopReceipt(const JsonObject &archive, const JsonObject &binding) {
    exactObject(archive, {L"binding", L"receipt"}, "run_state_record_changed");
    require(runControlCanonicalJson(archive.GetNamedObject(L"binding")) ==
                runControlCanonicalJson(binding),
            "run_state_record_changed");
    const auto receipt = archive.GetNamedObject(L"receipt");
    exactObject(receipt, {L"kind", L"state", L"members"}, "run_state_record_changed");
    require(text(receipt, L"kind") == L"stop" &&
                (text(receipt, L"state") == L"stopped" ||
                 text(receipt, L"state") == L"cleanup_unknown"),
            "run_state_record_changed");
    require(receipt.HasKey(L"members") &&
                receipt.GetNamedValue(L"members").ValueType() == JsonValueType::Array,
            "run_state_record_changed");
    const auto members = receipt.GetNamedArray(L"members");
    require(members.Size() <= 32, "run_state_record_changed");
    if (text(receipt, L"state") == L"stopped")
      require(members.Size() > 0, "run_state_record_changed");
    for (const auto memberValue : members) {
      require(memberValue.ValueType() == JsonValueType::Object, "run_state_record_changed");
      const auto member = memberValue.GetObject();
      exactObject(member, {L"memberId", L"cleanup", L"errors"}, "run_state_record_changed");
      require(text(member, L"memberId").size() > 0, "run_state_record_changed");
      require(member.GetNamedValue(L"errors").ValueType() == JsonValueType::Array,
              "run_state_record_changed");
      const auto errors = member.GetNamedArray(L"errors");
      require(errors.Size() <= 256, "run_state_record_changed");
      for (const auto error : errors)
        require(error.ValueType() == JsonValueType::String &&
                    std::wstring(error.GetString()).size() > 0 &&
                    std::wstring(error.GetString()).size() <= 256,
                "run_state_record_changed");
      if (text(receipt, L"state") == L"stopped")
        require(errors.Size() == 0 &&
                    member.GetNamedValue(L"cleanup").ValueType() == JsonValueType::Object,
                "run_state_record_changed");
      const auto cleanupValue = member.GetNamedValue(L"cleanup");
      if (cleanupValue.ValueType() == JsonValueType::Null)
        continue;
      require(cleanupValue.ValueType() == JsonValueType::Object, "run_state_record_changed");
      const auto cleanup = cleanupValue.GetObject();
      exactObject(cleanup, {L"scopeClosed", L"processRetired", L"descendantsRetired", L"pid", L"birth"},
                  "run_state_record_changed");
      require(cleanup.GetNamedBoolean(L"scopeClosed") &&
                  cleanup.GetNamedBoolean(L"processRetired") &&
                  cleanup.GetNamedBoolean(L"descendantsRetired"),
              "run_state_record_changed");
      const double pid = cleanup.GetNamedNumber(L"pid");
      require(pid > 0 && pid <= MAXDWORD && pid == static_cast<DWORD>(pid),
              "run_state_record_changed");
      const auto birth = cleanup.GetNamedObject(L"birth");
      exactObject(birth, {L"format", L"value", L"bootId"}, "run_state_record_changed");
      require(text(birth, L"format") == L"windows-filetime" &&
                  birth.GetNamedValue(L"bootId").ValueType() == JsonValueType::Null &&
                  text(birth, L"value").size() > 0 &&
                  text(birth, L"value").find_first_not_of(L"0123456789") == std::wstring::npos,
              "run_state_record_changed");
    }
  }

  static void retainOriginalEndpointOwners(State &state, const JsonObject &record) {
    const auto endpoint = object(record, L"endpoint");
    const auto helper = object(endpoint, L"helper"), bun = object(endpoint, L"bun");
    const DWORD helperPid = State::runStateProcessIdLocked(helper, "run_control_endpoint_changed");
    const DWORD bunPid = State::runStateProcessIdLocked(bun, "run_control_endpoint_changed");
    Handle heldHelper(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, helperPid));
    Handle heldBun(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, bunPid));
    require(heldHelper && heldBun &&
                runControlCanonicalJson(Control::runControlNativeIdentity(heldHelper.value, helperPid)) == runControlCanonicalJson(helper) &&
                runControlCanonicalJson(Control::runControlNativeIdentity(heldBun.value, bunPid)) == runControlCanonicalJson(bun),
            "run_control_endpoint_changed");
    std::lock_guard<std::mutex> lock(state.mutex_);
    State::runStateAssertRetirementWitnessLocked(heldHelper.value, state.helperPid_, state.helperBirth_, "run_control_endpoint_changed");
    State::runStateAssertRetirementWitnessLocked(heldBun.value, state.bunPid_, state.bunBirth_, "run_control_endpoint_changed");
    state.serverProcess_ = std::move(heldHelper);
    state.parentProcess_ = std::move(heldBun);
  }

  static JsonObject memberPreflight(OwnerStore &owners, const JsonObject &input) {
    exactObject(input,
                {L"mode", L"directory", L"dataRoot", L"binding", L"root", L"databasePath",
                 L"sha256"},
                "run_state_start_changed");
    require(text(input, L"mode") == L"memberPreflight", "run_state_start_changed");
    const auto directory = text(input, L"directory"), dataRoot = text(input, L"dataRoot");
    validateRunNamespace(directory, dataRoot);
    const auto root = text(input, L"root"), database = text(input, L"databasePath");
    const auto expectedHash = text(input, L"sha256");
    require(expectedHash.size() == 64 &&
                expectedHash.find_first_not_of(L"0123456789abcdef") == std::wstring::npos,
            "run_control_config_identity");
    auto profileEntry = owners.selectedProfiles.find(root + L"|" + database);
    require(profileEntry != owners.selectedProfiles.end() && profileEntry->second.database,
            "run_control_selection_missing");
    auto &profile = profileEntry->second;
    const std::wstring configDirectory = root + L"\\config\\opencode";
    const std::wstring configPath = configDirectory + L"\\opencode.json";
    require(std::find(profile.admittedDirectories.begin(), profile.admittedDirectories.end(),
                      configDirectory) != profile.admittedDirectories.end(),
            "run_control_selection_missing");
    require(fileIdentity(profile.root.value, profile.owner, true, owners.selectedPackage)
                    .Stringify() == profile.rootIdentity.Stringify() &&
                fileIdentity(profile.parent.value, profile.owner, true, owners.selectedPackage)
                    .Stringify() == profile.parentIdentity.Stringify() &&
                fileIdentity(profile.database.value, profile.owner, false,
                             owners.selectedPackage)
                    .Stringify() == profile.databaseIdentity.Stringify(),
            "run_control_selection_changed");
    auto configAncestors = owners.holdSelectedAncestors(configPath);
    std::vector<JsonObject> configAncestorIdentities;
    for (const auto &ancestor : configAncestors)
      configAncestorIdentities.push_back(anchorIdentity(ancestor.value));
    Handle config(CreateFileW(extended(configPath).c_str(), GENERIC_READ | READ_CONTROL,
                              FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(config && equalPath(finalPath(config.value), extended(configPath)),
            "run_control_config_identity");
    FILE_STANDARD_INFO configSize{};
    require(GetFileInformationByHandleEx(config.value, FileStandardInfo, &configSize,
                                         sizeof(configSize)) &&
                configSize.EndOfFile.QuadPart >= 0 &&
                configSize.EndOfFile.QuadPart <= 4 * 1024 * 1024 &&
                heldFileSha256(config.value) == expectedHash,
            "run_control_config_identity");
    const auto configIdentity =
        fileIdentity(config.value, profile.owner, false, owners.selectedPackage);

    // Native selected-profile and fixed-config qualification is complete. The
    // run state is selected before any selectedConfigIds or controller cache.
    bool created = false;
    auto &state = issueState(owners, dataRoot, directory, false, created, {});
    if (created) state.select();
    const auto selectedEndpoint = state.readEndpoint();
    retainOriginalEndpointOwners(state, selectedEndpoint);
    state.adoptEndpointHash(runControlSha256Hex(runControlCanonicalJson(selectedEndpoint)));
    const auto before = state.memberPreflightWitness();
    const auto endpoint = object(before, L"endpoint");
    const auto startBefore = text(before, L"startBytes");
    require(runControlCanonicalJson(state.binding()) ==
                runControlCanonicalJson(object(input, L"binding")),
            "run_state_start_changed");
    require(state.cohortSealed(), "run_state_start_changed");
    const auto cohort = state.cohort();
    owners.attachSealedCohort(cohort);
    const auto cohortSids = owners.sealedCohortSids();

    HANDLE rootDuplicate = nullptr, databaseDuplicate = nullptr;
    require(DuplicateHandle(GetCurrentProcess(), profile.root.value, GetCurrentProcess(),
                            &rootDuplicate, 0, FALSE, DUPLICATE_SAME_ACCESS),
            "run_control_selection_changed");
    require(DuplicateHandle(GetCurrentProcess(), profile.database.value, GetCurrentProcess(),
                            &databaseDuplicate, 0, FALSE, DUPLICATE_SAME_ACCESS),
            "run_control_selection_changed");
    const auto teamId = text(state.binding(), L"teamId");
    std::unique_ptr<SelectedControllerConfig> memberConfig(
        new SelectedControllerConfig(Handle(rootDuplicate), Handle(databaseDuplicate),
                                     std::move(config), root, database, configPath,
                                     profile.owner, expectedHash, teamId,
                                     owners.selectedPackage, std::move(configAncestors)));
    owners.ensureControllerAuthority(*memberConfig, teamId);
    memberConfig->bindInbox(teamId, &cohortSids);
    memberConfig->assertLive(owners.selectedPackage, &cohortSids);
    const auto rootIdentity =
        fileIdentity(profile.root.value, profile.owner, true, owners.selectedPackage);
    const auto parentIdentity =
        fileIdentity(profile.parent.value, profile.owner, true, owners.selectedPackage);
    const auto databaseIdentity =
        fileIdentity(profile.database.value, profile.owner, false, owners.selectedPackage);
    IJsonValue controllerRootValue = JsonValue::CreateNullValue();
    if (memberConfig->mcpRoot) {
      const auto physical =
          fileObjectIdentity(memberConfig->mcpRoot->handle.value, profile.owner, true);
      require(owners.sealedControllerIdentity(physical), "run_control_selection_changed");
      controllerRootValue =
          fileObjectIdentity(memberConfig->mcpRoot->handle.value, profile.owner, true);
    }
    JsonObject matchedRow;
    size_t matches = 0;
    for (const auto value : cohort.GetNamedArray(L"members")) {
      const auto row = value.GetObject();
      const auto profileRow = object(row, L"profile"), configRow = object(row, L"config");
      if (object(profileRow, L"root").Stringify() != rootIdentity.Stringify() ||
          object(profileRow, L"parent").Stringify() != parentIdentity.Stringify() ||
          object(profileRow, L"database").Stringify() != databaseIdentity.Stringify() ||
          object(configRow, L"identity").Stringify() != configIdentity.Stringify() ||
          text(configRow, L"sha256") != expectedHash ||
          row.GetNamedValue(L"controllerRoot").Stringify() !=
              std::wstring(controllerRootValue.Stringify()))
        continue;
      ++matches;
      matchedRow = row;
    }
    require(matches == 1, "run_state_start_changed");

    const auto endpointRecord = object(endpoint, L"endpoint");
    const auto endpointBun = object(endpointRecord, L"bun");
    const DWORD parentPid = Control::runControlParentPid(GetCurrentProcess());
    require(parentPid > 0 && parentPid <= MAXDWORD, "run_control_parent_join");
    Handle parent(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE,
                              static_cast<DWORD>(parentPid)));
    require(parent && Control::runControlRequireFullToken(GetCurrentProcess()) &&
                Control::runControlRequireFullToken(parent.value),
            "run_control_parent_join");
    const auto parentPin = Control::runControlObserveProcess(parent.value);
    const auto endpointBunPin = Control::runControlObserveProcess(state.parentProcess_.value);
    require(Control::runControlSameProcess(parentPin, endpointBunPin) &&
                State::runStateProcessIdLocked(endpointBun, "run_control_parent_join") ==
                    parentPid &&
                State::runStateProcessBirthLocked(endpointBun, "run_control_parent_join") ==
                    filetime(parentPin.birth),
            "run_control_parent_join");
    require(runControlCanonicalJson(Control::runControlNativeIdentity(
                parent.value, parentPid)) ==
                runControlCanonicalJson(endpointBun),
            "run_control_parent_join");
    const auto after = state.memberPreflightWitness();
    require(startBefore == text(after, L"startBytes") &&
                runControlCanonicalJson(endpoint) ==
                    runControlCanonicalJson(object(after, L"endpoint")),
            "run_state_start_changed");
    memberConfig->assertLive(owners.selectedPackage, &cohortSids);
    for (size_t i = 0; i < memberConfig->configAncestors.size(); ++i) {
      require(anchorIdentity(memberConfig->configAncestors[i].value).Stringify() ==
                  memberConfig->configAncestorIdentities[i].Stringify(),
              "run_control_selection_changed");
      const auto heldPath = text(memberConfig->configAncestorIdentities[i], L"dosPath");
      require(heldPath.rfind(L"\\\\?\\", 0) == 0, "execution_path_alias");
      auto reopened = verificationDirectory(heldPath.substr(4));
      require(anchorIdentity(reopened.value).Stringify() ==
                  memberConfig->configAncestorIdentities[i].Stringify(),
              "run_control_selection_changed");
    }
    const auto launchNonce = text(matchedRow, L"launchNonce");
    state.consumeMemberPreflight(launchNonce);
    owners.memberPreflights[launchNonce] = state.id();
    JsonObject result;
    str(result, L"stateId", state.id());
    str(result, L"launchNonce", launchNonce);
    return result;
  }

  static bool physicalOwnerRetired(OwnerStore &owners, State &state) {
    (void)owners;
    // The State owns the original helper and Bun MAIN process handles. A PID
    // reopen, helper/control closure or replacement observer cannot qualify it.
    return state.ownerRetired();
  }

  static JsonObject request(OwnerStore &owners, const std::wstring &operation,
                            const JsonObject &input) {
    if (operation == L"runStateSelect" && input.HasKey(L"mode") &&
        text(input, L"mode") == L"memberPreflight")
      return memberPreflight(owners, input);
    if (operation == L"runStateProcessIdentity") {
      const double raw = input.GetNamedNumber(L"pid");
      require(raw > 0 && raw <= MAXDWORD && raw == static_cast<DWORD>(raw), "run_process_unknown");
      Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE,
                                 static_cast<DWORD>(raw)));
      if (!process) {
        require(GetLastError() == ERROR_INVALID_PARAMETER, "run_process_unknown");
        throw NativeError{"run_process_unknown", ERROR_INVALID_PARAMETER, "identity"};
      }
      require(Control::runControlRequireFullToken(process.value), "run_process_appcontainer");
      return Control::runControlNativeIdentity(process.value, static_cast<DWORD>(raw));
    }
    if (operation == L"runStateAcquire") {
      bool created = false;
      auto &state = stateFor(owners, input, true, created);
      JsonObject result;
      str(result, L"stateId", state.id());
      return result;
    }
    if (operation == L"runStateReserve") {
      auto &state = namedState(owners, input);
      const auto ids = owners.runStateSelections[state.id()];
      require(!ids.empty() && ids.size() <= 32, "run_control_selection_missing");
      const auto binding = object(input, L"binding");
      validateRequestBinding(binding);
      if (input.GetNamedBoolean(L"sharedControllerRootCohort", false)) {
        const auto audit = input.HasKey(L"selectionId") ? text(input, L"selectionId")
                                                       : std::wstring(L"1");
        const auto cohort = owners.sealedCohortDocument(audit, ids);
        state.reserve(binding, text(input, L"sourceSha256"), &cohort);
        owners.attachSealedCohort(cohort);
      } else
        state.reserve(binding, text(input, L"sourceSha256"));
      owners.runStateSelections[state.id()] = ids;
      (void)selectionFor(owners, owners.runStateRoots[state.id()], ids, state.binding());
      JsonObject result;
      str(result, L"stateId", state.id());
      return result;
    }
    if (operation == L"runStateSelect") {
      const auto mode = text(input, L"mode");
      bool created = false;
      auto &state = stateFor(owners, input, false, created);
      if (created) {
        state.select();
        try {
          const auto endpoint = state.readEndpoint();
          retainOriginalEndpointOwners(state, endpoint);
          state.adoptEndpointHash(runControlSha256Hex(runControlCanonicalJson(endpoint)));
        } catch (const NativeError &error) {
          if (error.code != "run_state_endpoint_missing" || mode != L"serve")
            throw;
        }
      }
      const auto ids = selectionIds(input);
      if (state.cohortSealed()) owners.attachSealedCohort(state.cohort());
      owners.runStateSelections[state.id()] = ids;
      if (mode == L"discover") {
        const auto binding = state.binding();
        require(text(binding, L"teamId") == text(input, L"teamId") &&
                    text(binding, L"runId") == text(input, L"runId"),
                "run_state_start_changed");
      } else {
        require(runControlCanonicalJson(state.binding()) ==
                    runControlCanonicalJson(object(input, L"binding")),
                "run_state_start_changed");
      }
      (void)selectionFor(owners, owners.runStateRoots[state.id()], ids, state.binding());
      JsonObject result;
      str(result, L"stateId", state.id());
      return result;
    }
    if (operation == L"runStateDiscover") {
      const auto ids = selectionIds(input, true);
      const auto dataRoot = text(input, L"dataRoot"), directory = text(input, L"directory");
      require(validTeamId(text(input, L"teamId")) && !text(input, L"runId").empty(),
              "run_state_start_changed");
      if (!ids.empty()) (void)selectionForConfigOnly(owners, dataRoot, ids);
      // Cached state is never replaced with absence evidence.
      const bool retained = std::any_of(owners.runStates.begin(), owners.runStates.end(),
          [&](const auto &entry) { return entry.second->directory() == directory; });
      if (!retained && namespaceAbsent(owners, directory, dataRoot)) {
        JsonObject result;
        flag(result, L"absent", true);
        return result;
      }
      require(!ids.empty(), "run_control_selection_missing");
      bool created = false;
      auto &state = stateFor(owners, input, false, created);
      if (created)
        state.select();
      if (state.cohortSealed()) owners.attachSealedCohort(state.cohort());
      owners.runStateSelections[state.id()] = ids;
      const auto endpoint = state.readEndpoint();
      if (created) retainOriginalEndpointOwners(state, endpoint);
      state.adoptEndpointHash(runControlSha256Hex(runControlCanonicalJson(endpoint)));
      const auto binding = state.binding();
      require(validTeamId(text(input, L"teamId")) &&
                  text(binding, L"teamId") == text(input, L"teamId") &&
                  text(binding, L"runId") == text(input, L"runId"),
              "run_state_start_changed");
      (void)selectionFor(owners, owners.runStateRoots[state.id()], ids, binding);
      JsonObject result;
      str(result, L"stateId", state.id());
      result.SetNamedValue(L"record", endpoint);
      return result;
    }
    if (operation == L"runStateReadRecord") {
      auto &state = namedState(owners, input);
      const auto name = text(input, L"name");
      const auto bytes = state.read(name, 512 * 1024);
      require(!bytes.empty() && bytes.back() == '\n', "run_state_record_changed");
      const std::string json(bytes.begin(), bytes.end() - 1);
      JsonObject result;
      result.SetNamedValue(L"value", JsonObject::Parse(wide(json)));
      return result;
    }
    if (operation == L"runStateWriteRecord") {
      auto &state = namedState(owners, input);
      const auto bytes = narrow(text(input, L"bytes"));
      require(!bytes.empty() && bytes.back() == '\n' && bytes.size() <= 512 * 1024,
              "run_state_record_changed");
      state.write(text(input, L"name"), std::vector<BYTE>(bytes.begin(), bytes.end()));
      JsonObject result;
      flag(result, L"written", true);
      return result;
    }
    if (operation == L"runStateValidateEndpoint") {
      auto &state = namedState(owners, input);
      return state.validateEndpointHash(text(input, L"endpointHash"));
    }
    if (operation == L"runStateOwnerRetired") {
      auto &state = namedState(owners, input);
      JsonObject result;
      flag(result, L"retired", physicalOwnerRetired(owners, state));
      return result;
    }
    if (operation == L"runStateReadStop") {
      auto &state = namedState(owners, input);
      state.validateEndpointHash(text(input, L"endpointHash"));
      try {
        const auto bytes = state.read(L"stop.json", 512 * 1024);
        require(!bytes.empty() && bytes.back() == '\n', "run_state_record_changed");
        const auto archive = JsonObject::Parse(wide(std::string(bytes.begin(), bytes.end() - 1)));
        validateStopReceipt(archive, state.binding());
        JsonObject result;
        result.SetNamedValue(L"receipt", archive.GetNamedValue(L"receipt"));
        return result;
      } catch (const NativeError &error) {
        if (error.code == "run_state_record_absent") {
          JsonObject result;
          flag(result, L"absent", true);
          return result;
        }
        throw;
      }
    }
    if (operation == L"runStateListen") {
      auto &state = namedState(owners, input);
      const auto binding = object(input, L"binding");
      state.bindOwner(binding, text(input, L"sourceSha256"));
      auto &control = owners.runControls[state.id()];
      if (!control)
        control = issueControl(owners, state, Control::Role::server);
      control->listen(input);
      const auto record = control->endpointRecord(binding, text(input, L"directory"),
                                                   static_cast<std::uint64_t>(input.GetNamedNumber(L"deadline")),
                                                   text(input, L"sourceSha256"));
      state.sealEndpoint(record, runControlSha256Hex(runControlCanonicalJson(record)));
      control->startRequestPump();
      JsonObject result;
      result.SetNamedValue(L"record", record);
      return result;
    }
    if (operation == L"runStateRequest") {
      auto &state = namedState(owners, input);
      auto &control = owners.runControls[state.id()];
      if (!control)
        control = issueControl(owners, state, Control::Role::client);
      return control->clientRequest(
          runControlCanonicalJson(object(input, L"payload")),
          static_cast<DWORD>(input.GetNamedNumber(L"timeoutMs")));
    }
    if (operation == L"runStateRespond") {
      auto &state = namedState(owners, input);
      auto found = owners.runControls.find(state.id());
      require(found != owners.runControls.end(), "run_control_foreign");
      JsonObject request;
      num(request, L"id", std::stoull(text(input, L"connection")));
      request.SetNamedValue(L"response", object(input, L"response"));
      num(request, L"timeoutMs", static_cast<std::uint64_t>(input.GetNamedNumber(L"timeoutMs")));
      found->second->respond(request);
      JsonObject result;
      flag(result, L"responded", true);
      return result;
    }
    if (operation == L"runStatePoisonConnection") {
      auto &state = namedState(owners, input);
      auto found = owners.runControls.find(state.id());
      require(found != owners.runControls.end(), "run_control_foreign");
      JsonObject request;
      num(request, L"id", std::stoull(text(input, L"connection")));
      found->second->poisonConnection(request);
      JsonObject result;
      flag(result, L"poisoned", true);
      return result;
    }
    if (operation == L"runStateClose") {
      auto &state = namedState(owners, input);
      auto found = owners.runControls.find(state.id());
      require(found != owners.runControls.end(), "run_control_foreign");
      return found->second->shutdown();
    }
    throw NativeError{"execution_invalid_response"};
  }
};
JsonObject OwnerStore::request(const std::wstring &operation, const JsonObject &input) {
  if (operation.rfind(L"runState", 0) == 0)
    return WindowsNativeRunStateIssuer::request(*this, operation, input);
  return requestAfterRunStateIssuer(operation, input);
}
static std::unique_ptr<Scope> launch(const JsonObject &input, OwnerStore &owners) {
  auto scope = std::make_unique<Scope>();
  scope->owners = &owners;
  auto nonce = text(input, L"nonce"), lease = text(input, L"leaseOwnerId"),
       executable = text(input, L"executable"), entry = text(input, L"entry");
  require(nonce.size() == 36 && lease.size() == 36, "execution_identity_mismatch");
  scope->cohort = WindowsNativeRunControlIssuer::prepareLaunchCohort(owners, nonce);
  scope->launchNonce = nonce;
  if (input.HasKey(L"selectedConfigId"))
    WindowsNativeRunControlIssuer::prepareOwnedPair(
        owners, *scope, text(input, L"selectedConfigId"), nonce);
  scope->profile = L"AgentTeams.OpenCodeV2." + nonce;
  scope->cwd = text(input, L"cwd");
  auto parents = owners.holdSelectedAncestors(scope->cwd);
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
      auto checked = owners.holdSelectedAncestors(root);
      if (kind != std::wstring(L"protectedRoots"))
        scope->realpathAnchors.emplace_back(
            root, kind == std::wstring(L"writableRoots") ? L"writable" : L"readOnly",
            std::move(checked), owners.holdSelectedDirectory(root));
      auto heldRoot = owners.holdSelectedDirectory(root);
      const bool privateOverlap =
          privateProfileOverlap(*scope->owners, heldRoot.value);
      const bool sharedRoot =
          kind == std::wstring(L"readOnlyRoots") && !privateOverlap;
      grantRoot(*scope, std::move(heldRoot),
                kind == std::wstring(L"protectedRoots") ? FILE_ALL_ACCESS
                : kind == std::wstring(L"writableRoots")
                    ? (FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE)
                    : (FILE_GENERIC_READ | FILE_GENERIC_EXECUTE),
                kind == std::wstring(L"protectedRoots") ? DENY_ACCESS : GRANT_ACCESS,
                sharedRoot);
    }
  }
  // Helper-only native owner/command probes do not select a DLL. Production
  // composition requires this selection and its authenticated prepare receipt.
  if (input.HasKey(L"realpathDll")) {
    const auto dllCohortSids =
        scope->cohort ? closedControllerCohortSids(*scope->cohort) : std::vector<std::wstring>();
    scope->realpathDll = std::make_unique<RetainedRealpathDll>(
        object(input, L"realpathDll"), scope->sid.value,
        scope->cohort ? &dllCohortSids : nullptr);
    scope->realpathDll->changeAce(GRANT_ACCESS);
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
  if (input.HasKey(L"selectedConfigId"))
    scope->ownedPairControl = WindowsNativeRunControlIssuer::issueOwnedPair(
        owners, *scope, text(input, L"selectedConfigId"), nonce, lease);
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
  if (scope->realpathDll)
    mapping.SetNamedValue(L"realpathDll", scope->realpathDll->receipt(
        nonce, scope->pid, text(birth(scope->process.value), L"value")));
  str(mapping, L"nonce", nonce);
  // Bound the expanded launch/connected receipt before the child can run.
  // Remaining response envelope is small and fixed; reserve a full KiB.
  require(winrt::to_string(mapping.Stringify()).size() <= CONTROL_PACKET_LIMIT - 1024,
          "execution_invalid_response");
  scope->mapping = mapping;
  scope->readerFinished = Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  require(static_cast<bool>(scope->readerFinished), "execution_native_unknown");
  scope->reader = std::thread([value = scope.get()] {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    try { value->read(); }
    catch (...) { event(L"failed", value->mapping); }
    SetEvent(value->readerFinished.value);
  });
  scope->mainExit = std::thread([value = scope.get()] {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    try { value->observeMainExit(); }
    catch (...) { event(L"failed", value->mapping); }
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
  if (argc != 3 || (std::wstring(argv[1]) != L"--broker" &&
                    std::wstring(argv[1]) != L"--self-image-custody"))
    return 64;
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const bool custodyOnly = std::wstring(argv[1]) == L"--self-image-custody";
    // Acquire custody inside the reply error boundary, before any operation
    // effect, then retain the image and physical ancestors until broker exit.
    std::unique_ptr<NativeSelfImageCustody> custody;
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
        if (custodyOnly)
          require(operation == L"selfImageCustody" && input.Size() == 0,
                  "execution_invalid_response");
        if (!custody)
          custody = std::make_unique<NativeSelfImageCustody>(argv[2], custodyOnly);
        if (custodyOnly) {
          value = custody->receipt();
        } else if (operation.rfind(L"owner", 0) == 0 || operation.rfind(L"runState", 0) == 0)
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
