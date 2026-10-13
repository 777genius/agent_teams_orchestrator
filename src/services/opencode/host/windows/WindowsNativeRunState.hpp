#pragma once

#include <bcrypt.h>
#include <array>
#include <mutex>
#include <vector>

// Selected native run state is an owner capability, never a filesystem facade.
// Its constructor is reachable only from the Kernel's private issuer.
struct WindowsNativeRunStateIssuer;
struct WindowsNativeRunState {
  friend struct WindowsNativeRunStateIssuer;

  WindowsNativeRunState(const WindowsNativeRunState &) = delete;
  WindowsNativeRunState &operator=(const WindowsNativeRunState &) = delete;

  const std::wstring &directory() const { return directory_; }
  const std::wstring &id() const { return id_; }
  bool poisoned() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return poisoned_;
  }

  void reserve(const JsonObject &binding, const std::wstring &sourceSha256) {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && !reserved_ && !endpointSealed_, "run_state_unknown");
    try {
      const std::string canonical = runStateStartBytes(binding, sourceSha256) + "\n";
      const std::vector<BYTE> start(canonical.begin(), canonical.end());
      runStateWriteExclusive(L"start.json", start);
      std::vector<BYTE> challenge(32);
      require(BCryptGenRandom(nullptr, challenge.data(), static_cast<ULONG>(challenge.size()),
                              BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0,
              "run_state_challenge_unknown");
      runStateWriteExclusive(L"challenge", challenge);
      challenge_ = std::move(challenge);
      binding_ = binding;
      sourceSha256_ = sourceSha256;
      reserved_ = true;
    } catch (...) {
      poisoned_ = true;
      throw;
    }
  }

  void discover(const JsonObject &binding, const std::wstring &sourceSha256) {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && !reserved_ && !endpointSealed_, "run_state_unknown");
    const auto start = runStateReadLocked(L"start.json", 512 * 1024);
    const std::string expected = runStateStartBytes(binding, sourceSha256);
    require(std::string(start.begin(), start.end()) == expected + "\n", "run_state_start_changed");
    try {
      challenge_ = runStateReadLocked(L"challenge", 32);
      require(challenge_.size() == 32, "run_state_challenge_changed");
      binding_ = binding;
      sourceSha256_ = sourceSha256;
      reserved_ = true;
    } catch (...) {
      poisoned_ = true;
      throw;
    }
  }

  void select() {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && !reserved_ && !endpointSealed_, "run_state_unknown");
    try {
      const auto start = runStateReadLocked(L"start.json", 512 * 1024);
      require(!start.empty() && start.back() == '\n', "run_state_start_changed");
      const std::string json(start.begin(), start.end() - 1);
      const auto value = JsonObject::Parse(wide(json));
      const auto binding = object(value, L"binding");
      const auto sourceSha256 = text(value, L"sourceSha256");
      require(sourceSha256.size() == 64 &&
                  sourceSha256.find_first_not_of(L"0123456789abcdef") == std::wstring::npos,
              "run_state_start_changed");
      challenge_ = runStateReadLocked(L"challenge", 32);
      require(challenge_.size() == 32, "run_state_challenge_changed");
      binding_ = binding;
      sourceSha256_ = sourceSha256;
      reserved_ = true;
    } catch (...) {
      poisoned_ = true;
      throw;
    }
  }

  void bindOwner(const JsonObject &binding, const std::wstring &sourceSha256) {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && reserved_ && !endpointSealed_ &&
                text(binding_, L"controllerInstanceId") == text(binding, L"controllerInstanceId") &&
                text(binding_, L"ownerId") == text(binding, L"ownerId") &&
                text(binding_, L"runId") == text(binding, L"runId") &&
                text(binding_, L"teamId") == text(binding, L"teamId") &&
                sourceSha256_ == sourceSha256,
            "run_state_start_changed");
  }

  JsonObject binding() const {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && reserved_, "run_state_unknown");
    return binding_;
  }

  std::wstring sourceSha256() const {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && reserved_, "run_state_unknown");
    return sourceSha256_;
  }

  void write(const std::wstring &name, const std::vector<BYTE> &bytes) {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && reserved_, "run_state_unknown");
    try {
      runStateVerifyHeldLocked();
      runStateReplaceLocked(name, bytes);
      runStateVerifyHeldLocked();
    } catch (...) {
      poisoned_ = true;
      throw;
    }
  }

  std::vector<BYTE> read(const std::wstring &name, DWORD limit) {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && reserved_, "run_state_unknown");
    try {
      runStateVerifyHeldLocked();
      auto value = runStateReadLocked(name, limit);
      runStateVerifyHeldLocked();
      return value;
    } catch (const NativeError &error) {
      if (error.code == "run_state_record_absent" || error.code == "run_state_endpoint_missing")
        throw;
      poisoned_ = true;
      throw;
    } catch (...) {
      poisoned_ = true;
      throw;
    }
  }

  std::vector<BYTE> challenge() {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && reserved_ && challenge_.size() == 32, "run_state_challenge_changed");
    return challenge_;
  }

  void sealEndpoint(const JsonObject &endpoint, const std::wstring &endpointHash) {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && reserved_ && !endpointSealed_ && endpointHash.size() == 64 &&
                endpointHash.find_first_not_of(L"0123456789abcdef") == std::wstring::npos,
            "run_state_unknown");
    try {
      runStateVerifyHeldLocked();
      runStateValidateEndpointLocked(endpoint);
      const std::string bytes = narrow(std::wstring(endpoint.Stringify())) + "\n";
      runStateReplaceLocked(L"control.json",
                            std::vector<BYTE>(bytes.begin(), bytes.end()));
      runStateVerifyHeldLocked();
      endpointHash_ = endpointHash;
      endpointRecord_ = endpoint;
      endpointSealed_ = true;
    } catch (...) {
      poisoned_ = true;
      throw;
    }
  }

  JsonObject readEndpoint() {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && reserved_, "run_state_endpoint_missing");
    try {
      runStateVerifyHeldLocked();
      auto bytes = runStateReadLocked(L"control.json", 512 * 1024);
      runStateVerifyHeldLocked();
      require(!bytes.empty() && bytes.back() == '\n', "run_state_record_changed");
      bytes.pop_back();
      const std::string json(bytes.begin(), bytes.end());
      auto endpoint = JsonObject::Parse(wide(json));
      runStateValidateEndpointLocked(endpoint);
      endpointSealed_ = true;
      endpointRecord_ = endpoint;
      return endpoint;
    } catch (const NativeError &error) {
      if (error.code == "run_state_endpoint_missing")
        throw;
      poisoned_ = true;
      throw;
    } catch (...) {
      poisoned_ = true;
      throw;
    }
  }

  JsonObject endpointRecord() {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && reserved_ && endpointSealed_, "run_state_endpoint_missing");
    return endpointRecord_;
  }

  void adoptEndpointHash(const std::wstring &endpointHash) {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && reserved_ && endpointSealed_ && endpointHash.size() == 64 &&
                endpointHash.find_first_not_of(L"0123456789abcdef") == std::wstring::npos,
            "run_state_endpoint_changed");
    endpointHash_ = endpointHash;
  }

  void validateEndpointHash(const std::wstring &endpointHash) const {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && reserved_ && endpointSealed_ && endpointHash_ == endpointHash,
            "run_control_endpoint_changed");
  }

  bool ownerRetired() {
    std::lock_guard<std::mutex> lock(mutex_);
    require(!poisoned_ && reserved_, "run_state_unknown");
    runStateVerifyHeldLocked();
    if (endpointSealed_) {
      const auto process = object(endpointRecord_, L"process");
      const double raw = process.GetNamedNumber(L"pid");
      require(raw > 0 && raw <= MAXDWORD && raw == static_cast<DWORD>(raw), "run_state_unknown");
      Handle server(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE,
                               static_cast<DWORD>(raw)));
      if (!server && GetLastError() == ERROR_INVALID_PARAMETER)
        return runStateAbsentLocked(L"control.json");
      require(static_cast<bool>(server), "run_state_unknown");
      if (WaitForSingleObject(server.value, 0) == WAIT_OBJECT_0)
        return runStateAbsentLocked(L"control.json");
      return false;
    }
    if (WaitForSingleObject(serverProcess_.value, 0) == WAIT_OBJECT_0)
      return true;
    return false;
  }

  void retainServerProcess(HANDLE process) {
    std::lock_guard<std::mutex> lock(mutex_);
    require(process && !serverProcess_, "run_state_unknown");
    HANDLE duplicate = nullptr;
    require(DuplicateHandle(GetCurrentProcess(), process, GetCurrentProcess(), &duplicate, 0,
                            FALSE, DUPLICATE_SAME_ACCESS),
            "run_state_unknown");
    serverProcess_ = Handle(duplicate);
  }

  bool validatePayload(const JsonObject &payload) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto binding = object(payload, L"binding");
    return !poisoned_ && reserved_ &&
           text(binding, L"controllerInstanceId") == text(binding_, L"controllerInstanceId") &&
           text(binding, L"ownerId") == text(binding_, L"ownerId") &&
           text(binding, L"runId") == text(binding_, L"runId") &&
           text(binding, L"teamId") == text(binding_, L"teamId") &&
           payload.GetNamedNumber(L"protocol") == 1 &&
           endpointSealed_ && text(payload, L"endpoint") == endpointHash_;
  }

private:
  explicit WindowsNativeRunState(std::vector<Handle> parents, Handle root, Handle run,
                                 JsonObject rootIdentity, std::wstring owner,
                                 std::wstring directory, std::wstring rootPath,
                                 Handle serverProcess, Handle parentProcess)
      : parents_(std::move(parents)), root_(std::move(root)), run_(std::move(run)),
        rootIdentity_(std::move(rootIdentity)), owner_(std::move(owner)),
        directory_(std::move(directory)), rootPath_(std::move(rootPath)),
        serverProcess_(std::move(serverProcess)), parentProcess_(std::move(parentProcess)) {
    require(parents_.size() >= 4 && root_ && run_ && root_.value != run_.value &&
                serverProcess_ && parentProcess_,
            "run_state_held_inputs");
    runIdentity_ = fileIdentity(run_.value, owner_, true);
    for (auto &parent : parents_)
      parentIdentity_.push_back(anchorIdentity(parent.value));
    BYTE random[16]{};
    require(BCryptGenRandom(nullptr, random, sizeof(random),
                            BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0,
            "run_state_unknown");
    static const wchar_t hex[] = L"0123456789abcdef";
    id_ = L"run-state-";
    for (BYTE byte : random) {
      id_ += hex[byte >> 4];
      id_ += hex[byte & 15];
    }
  }

  void runStateVerifyHeldLocked() {
    require(!poisoned_, "run_state_unknown");
    require(equalPath(finalPath(root_.value), extended(rootPath_)) &&
                equalPath(finalPath(run_.value), extended(directory_)),
            "run_state_identity_changed");
    require(fileIdentity(root_.value, owner_, true).Stringify() == rootIdentity_.Stringify() &&
                fileIdentity(run_.value, owner_, true).Stringify() == runIdentity_.Stringify(),
            "run_state_identity_changed");
    for (size_t i = 0; i < parents_.size(); ++i)
      require(anchorIdentity(parents_[i].value).Stringify() ==
                  parentIdentity_[i].Stringify(),
              "run_state_identity_changed");
  }

  void runStateValidateEndpointLocked(const JsonObject &endpoint) const {
    runStateExactObject(endpoint,
                        {L"schema", L"protocol", L"binding", L"directory", L"deadline",
                         L"sourceSha256", L"platform", L"process", L"endpoint"},
                        "run_state_endpoint_changed");
    const auto binding = object(endpoint, L"binding");
    runStateExactObject(binding,
                        {L"teamId", L"runId", L"controllerInstanceId", L"ownerId"},
                        "run_state_endpoint_changed");
    runStateExactObject(binding_,
                        {L"teamId", L"runId", L"controllerInstanceId", L"ownerId"},
                        "run_state_endpoint_changed");
    require(text(endpoint, L"directory") == directory_ &&
                text(endpoint, L"sourceSha256") == sourceSha256_ &&
                text(binding, L"teamId") == text(binding_, L"teamId") &&
                text(binding, L"runId") == text(binding_, L"runId") &&
                text(binding, L"controllerInstanceId") ==
                    text(binding_, L"controllerInstanceId") &&
                text(binding, L"ownerId") == text(binding_, L"ownerId"),
            "run_state_endpoint_changed");
  }

  static void runStateExactObject(const JsonObject &value,
                                  const std::vector<std::wstring> &names,
                                  const char *code) {
    size_t count = 0;
    for (auto pair : value) {
      const std::wstring key(pair.Key());
      bool found = false;
      for (const auto &name : names)
        found = found || key == name;
      require(found, code);
      ++count;
    }
    require(count == names.size(), code);
  }

  static bool runStateAllowed(const std::wstring &name, bool json) {
    if (name == L"challenge")
      return !json;
    return json && (name == L"start.json" || name == L"control.json" ||
                    name == L"state.json" || name == L"intents.json" ||
                    name == L"orphan.json" || name == L"tombstone.json" ||
                    name == L"stop.json" || name == L"operation-failure.json");
  }

  static std::string runStateStartBytes(const JsonObject &binding,
                                        const std::wstring &sourceSha256) {
    const auto controller = narrow(text(binding, L"controllerInstanceId"));
    const auto owner = narrow(text(binding, L"ownerId"));
    const auto run = narrow(text(binding, L"runId"));
    const auto team = narrow(text(binding, L"teamId"));
    return "{\"binding\":{\"controllerInstanceId\":\"" + controller +
           "\",\"ownerId\":\"" + owner + "\",\"runId\":\"" + run +
           "\",\"teamId\":\"" + team + "\"},\"sourceSha256\":\"" +
           narrow(sourceSha256) + "\"}";
  }

  static bool runStateStrictUtf8(const std::string &value) {
    size_t i = 0;
    while (i < value.size()) {
      const unsigned char first = static_cast<unsigned char>(value[i++]);
      if (first == 0 || first < 0x80)
        continue;
      size_t count = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 0;
      if (count == 0 || i + count - 1 > value.size())
        return false;
      unsigned code = first & (count == 4 ? 7 : count == 3 ? 15 : 31);
      for (size_t j = 1; j < count; ++j) {
        const unsigned char next = static_cast<unsigned char>(value[i++]);
        if ((next & 0xc0) != 0x80)
          return false;
        code = (code << 6) | (next & 0x3f);
      }
      if ((count == 2 && code < 0x80) || (count == 3 && code < 0x800) ||
          (count == 4 && (code < 0x10000 || code > 0x10ffff)) ||
          (code >= 0xd800 && code <= 0xdfff))
        return false;
    }
    return true;
  }

  std::vector<BYTE> runStateReadLocked(const std::wstring &name, DWORD limit) {
    require(runStateAllowed(name, name != L"challenge") &&
                ((name == L"challenge") == (limit == 32)), "run_state_record_name");
    const std::wstring target = directory_ + L"\\" + name;
    Handle file(CreateFileW(extended(target).c_str(), GENERIC_READ | READ_CONTROL,
                            FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                            FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!file) {
      const DWORD error = GetLastError();
      require(error == ERROR_FILE_NOT_FOUND, "run_state_record_unknown");
      throw NativeError{name == L"control.json" ? "run_state_endpoint_missing"
                                               : "run_state_record_absent",
                        error, "record_open"};
    }
    fileIdentity(file.value, owner_, false);
    FILE_STANDARD_INFO info{};
    require(GetFileInformationByHandleEx(file.value, FileStandardInfo, &info, sizeof(info)) &&
                info.EndOfFile.QuadPart >= 0 && info.EndOfFile.QuadPart <= limit,
            "run_state_record_size");
    std::vector<BYTE> bytes(static_cast<size_t>(info.EndOfFile.QuadPart));
    DWORD got = 0;
    require(bytes.empty() ||
                (ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &got,
                          nullptr) &&
                 got == bytes.size()),
            "run_state_record_read");
    require(name != L"challenge" || bytes.size() == 32, "run_state_challenge_changed");
    require(name == L"challenge" || runStateStrictUtf8(
              std::string(reinterpret_cast<const char *>(bytes.data()), bytes.size())),
            "run_state_record_encoding");
    return bytes;
  }

  Handle runStateCreateRelative(const std::wstring &name,
                                PSECURITY_DESCRIPTOR descriptor) {
    UNICODE_STRING relative{};
    relative.Buffer = const_cast<wchar_t *>(name.data());
    relative.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
    relative.MaximumLength = relative.Length;
    OBJECT_ATTRIBUTES attributes{};
    attributes.Length = sizeof(attributes);
    attributes.RootDirectory = run_.value;
    attributes.ObjectName = &relative;
    attributes.Attributes = 0x40;
    attributes.SecurityDescriptor = descriptor;
    auto create = reinterpret_cast<NtCreateFileFunction>(
        GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
    require(create != nullptr, "run_state_record_unknown");
    IO_STATUS_BLOCK status{};
    HANDLE raw = nullptr;
    const NTSTATUS result = create(
        &raw, GENERIC_READ | GENERIC_WRITE | READ_CONTROL | SYNCHRONIZE, &attributes, &status,
        nullptr, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_CREATE, 0x1 | 0x200000, nullptr, 0);
    if (result != 0 || status.Status != 0) {
      auto convert = reinterpret_cast<NtStatusErrorFunction>(
          GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
      const NTSTATUS native = result != 0 ? result : status.Status;
      throw NativeError{"run_state_record_unknown", convert ? convert(native) : 0,
                        "record_create", static_cast<DWORD>(native)};
    }
    return Handle(raw);
  }

  void runStateWriteExclusive(const std::wstring &name, const std::vector<BYTE> &bytes) {
    require((runStateAllowed(name, name != L"challenge") ||
             name.rfind(L".run-state-", 0) == 0) &&
                bytes.size() <= 512 * 1024 &&
                (name != L"challenge" || bytes.size() == 32),
            "run_state_record_name");
    LocalMemory descriptor;
    const std::wstring sddl =
        L"O:" + owner_ + L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + owner_ + L")";
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.c_str(), SDDL_REVISION_1, &descriptor.value, nullptr) != 0,
            "run_state_acl_unknown");
    Handle file(runStateCreateRelative(name, descriptor.value));
    require(static_cast<bool>(file), "run_state_record_collision");
    fileIdentity(file.value, owner_, false);
    DWORD written = 0;
    require((bytes.empty() || WriteFile(file.value, bytes.data(),
                                        static_cast<DWORD>(bytes.size()), &written, nullptr)) &&
                written == bytes.size() && FlushFileBuffers(file.value),
            "run_state_record_write");
  }

  void runStateReplaceLocked(const std::wstring &name, const std::vector<BYTE> &bytes) {
    require(runStateAllowed(name, true) && !bytes.empty() && bytes.size() <= 512 * 1024,
            "run_state_record_name");
    BYTE nonce[16]{};
    require(BCryptGenRandom(nullptr, nonce, sizeof(nonce),
                            BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0,
            "run_state_record_temporary");
    static const wchar_t hex[] = L"0123456789abcdef";
    std::wstring temporary = L".run-state-";
    for (BYTE byte : nonce) {
      temporary += hex[byte >> 4];
      temporary += hex[byte & 15];
    }
    runStateWriteExclusive(temporary, bytes);
    Handle source(CreateFileW(extended(directory_ + L"\\" + temporary).c_str(),
                              GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL |
                                  WRITE_DAC,
                              FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(static_cast<bool>(source), "run_state_record_unknown");
    fileIdentity(source.value, owner_, false);
    auto set = reinterpret_cast<NtSetFileFunction>(
        GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtSetInformationFile"));
    auto statusError = reinterpret_cast<NtStatusErrorFunction>(
        GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError"));
    require(set && statusError, "run_state_record_unknown");
    const std::wstring basename = name;
    const size_t size = offsetof(FILE_RENAME_INFO, FileName) + (basename.size() + 1) * sizeof(wchar_t);
    std::vector<BYTE> storage(size);
    auto rename = reinterpret_cast<FILE_RENAME_INFO *>(storage.data());
    rename->ReplaceIfExists = TRUE;
    rename->RootDirectory = run_.value;
    rename->FileNameLength = static_cast<DWORD>(basename.size() * sizeof(wchar_t));
    memcpy(rename->FileName, basename.data(), rename->FileNameLength);
    rename->FileName[basename.size()] = L'\0';
    IO_STATUS_BLOCK completion{};
    NTSTATUS status = set(source.value, &completion, rename,
                          static_cast<ULONG>(storage.size()),
                          static_cast<FILE_INFORMATION_CLASS>(10));
    if (status != 0 || completion.Status != 0) {
      const DWORD code = statusError(status != 0 ? status : completion.Status);
      throw NativeError{"cleanup_unknown", code, "run_state_record_rename",
                        static_cast<DWORD>(status != 0 ? status : completion.Status)};
    }
  }

  bool runStateAbsentLocked(const std::wstring &name) {
    try {
      (void)runStateReadLocked(name, 512 * 1024);
      return false;
    } catch (const NativeError &error) {
      if (error.code == "run_state_record_absent")
        return true;
      throw;
    }
  }

  std::vector<Handle> parents_;
  Handle root_, run_, serverProcess_, parentProcess_;
  JsonObject rootIdentity_, runIdentity_;
  std::vector<JsonObject> parentIdentity_;
  std::wstring owner_, rootPath_, directory_, id_;
  JsonObject binding_;
  std::wstring sourceSha256_;
  std::wstring endpointHash_;
  JsonObject endpointRecord_;
  std::vector<BYTE> challenge_;
  std::map<std::wstring, std::uint64_t> generations_;
  bool reserved_ = false;
  bool endpointSealed_ = false;
  bool poisoned_ = false;
  mutable std::mutex mutex_;
};
