#pragma once

#include <bcrypt.h>
#include <aclapi.h>
#include <sddl.h>
#include <winternl.h>

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

// Included after WindowsKernelScope.cpp's HANDLE, NativeError and JSON helpers.
// The owner boundary is deliberately narrow: only the retained-selection root
// issuer can construct this object. All observable identifiers are registry
// generations; HANDLE and PID values never cross the JSON boundary.
struct WindowsNativeRunControlIssuer;
struct WindowsNativeRunControl {
  struct FilePin {
    std::array<BYTE, 16> fileId{};
    ULONGLONG volumeSerial = 0;
    std::uint64_t size = 0;
    std::array<BYTE, 32> sha256{};
    bool directory = false;
    bool hasSha256 = false;
  };
  struct ProcessPin {
    DWORD pid = 0;
    FILETIME birth{};
    std::vector<BYTE> sid;
    FilePin image;
  };
  struct ExpectedBinding {
    std::vector<BYTE> bytes;
    FilePin root, config, image;
    ProcessPin client, server;
    std::wstring endpoint;
  };
  struct HeldInputs {
    HANDLE selectedDirectory = nullptr;
    HANDLE config = nullptr;
    HANDLE intendedBun = nullptr;
    HANDLE processImage = nullptr;
    std::wstring sealedPath;
    std::wstring sealedBinding;
    ExpectedBinding expected;
  };

  friend struct WindowsNativeRunControlIssuer;
  friend JsonObject windowsNativeRunControlIssue(const HeldInputs &, const JsonObject &);

  WindowsNativeRunControl(const WindowsNativeRunControl &) = delete;
  WindowsNativeRunControl &operator=(const WindowsNativeRunControl &) = delete;
  ~WindowsNativeRunControl() {
    try {
      shutdown();
    } catch (...) {
    }
  }

  static constexpr DWORD MAX_FRAME_BYTES = 512 * 1024;
  static constexpr size_t MAX_CONNECTIONS = 8;
  static constexpr size_t MAX_CAPABILITIES = 64;
  static constexpr DWORD CANCEL_DRAIN_MS = 5000;

  JsonObject listen(const JsonObject &input) {
    (void)input;
    require(!listener_ && !shutdown_, "run_control_foreign");
    auto name = runControlUnpredictablePipeName();
    listener_.reset(new Listener);
    listener_->name = name;
    listener_->owner = ownerSid_;
    listener_->pending = runControlCreateServer(name, true);
    listener_->endpoint = name;
    JsonObject result;
    num(result, L"id", listener_->generation = runControlNewId());
    str(result, L"name", name);
    return result;
  }

  JsonObject connect(const JsonObject &input) {
    require(!shutdown_, "run_control_foreign");
    const auto endpoint = text(input, L"endpoint");
    require(runControlValidPipeEndpoint(endpoint) &&
                (expected_.endpoint.empty() || endpoint == expected_.endpoint),
            "run_control_foreign");
    require(runControlActiveCount() < MAX_CONNECTIONS &&
                registry_.size() < MAX_CAPABILITIES,
            "run_control_connection_limit");
    const DWORD timeout = runControlTimeoutMs(input, L"timeoutMs");
    Handle pipe(CreateFileW(endpoint.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                            OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr));
    require(static_cast<bool>(pipe), "run_control_connect_unknown");
    auto connection = runControlMakeConnection(std::move(pipe), Side::client, timeout);
    connection->endpoint = endpoint;
    runControlAuthenticate(*connection);
    const auto id = connection->id;
    registry_.emplace(id, std::move(connection));
    JsonObject result;
    num(result, L"id", id);
    return result;
  }

  JsonObject accept(const JsonObject &input) {
    require(listener_ && !shutdown_, "run_control_foreign");
    require(runControlActiveCount() < MAX_CONNECTIONS &&
                registry_.size() < MAX_CAPABILITIES,
            "run_control_connection_limit");
    const DWORD timeout = runControlTimeoutMs(input, L"timeoutMs");
    require(listener_->pending, "run_control_accept_unknown");
    OVERLAPPED overlap{};
    Handle ready(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    require(static_cast<bool>(ready), "run_control_accept_unknown");
    overlap.hEvent = ready.value;
    BOOL connected = ConnectNamedPipe(listener_->pending->value, &overlap);
    DWORD error = connected ? ERROR_SUCCESS : GetLastError();
    if (!connected && error == ERROR_IO_PENDING) {
      DWORD acceptedBytes = 0;
      if (!runControlWaitOperation(listener_->pending->value, overlap, acceptedBytes, timeout,
                                   ready.value)) {
        runControlCancelOperation(listener_->pending->value, overlap, ready.value);
        throw NativeError{"run_control_accept_timeout", ERROR_OPERATION_ABORTED, "accept"};
      }
    } else
      require(error == ERROR_PIPE_CONNECTED, "run_control_accept_unknown");

    HANDLE raw = nullptr;
    require(DuplicateHandle(GetCurrentProcess(), listener_->pending->value, GetCurrentProcess(),
                            &raw, 0, FALSE, DUPLICATE_SAME_ACCESS),
            "run_control_accept_unknown");
    Handle duplicated(raw);
    auto connection = runControlMakeConnection(std::move(duplicated), Side::server, timeout);
    connection->endpoint = listener_->name;
    runControlAuthenticate(*connection);
    const auto id = connection->id;
    registry_.emplace(id, std::move(connection));

    // The accepted instance remains connected and owned by the registry. The
    // listener is independently retained and immediately offers a fresh server
    // instance; no DisconnectNamedPipe call destroys the accepted endpoint.
    listener_->pending.reset();
    listener_->pending = runControlCreateServer(listener_->name, false);
    JsonObject result;
    num(result, L"id", id);
    return result;
  }

  JsonObject read(const JsonObject &input) {
    auto &connection = runControlConnectionFor(input);
    runControlAuthenticate(connection);
    const DWORD timeout = runControlTimeoutMs(input, L"timeoutMs");
    auto frame = runControlReadFrame(connection, timeout);
    JsonObject result;
    str(result, L"frame", runControlWide(frame));
    num(result, L"read", frame.size());
    return result;
  }

  JsonObject write(const JsonObject &input) {
    auto &connection = runControlConnectionFor(input);
    runControlAuthenticate(connection);
    const DWORD timeout = runControlTimeoutMs(input, L"timeoutMs");
    const auto value = text(input, L"frame");
    auto bytes = runControlNarrow(value);
    require(runControlStrictUtf8(bytes) && bytes.size() + 1 <= MAX_FRAME_BYTES &&
                bytes.find('\r') == std::string::npos &&
                bytes.find('\n') == std::string::npos,
            "run_control_frame_invalid");
    bytes.push_back('\n');
    runControlWriteFrame(connection, bytes, timeout);
    JsonObject result;
    num(result, L"written", bytes.size());
    return result;
  }

  JsonObject close(const JsonObject &input) {
    require(input.HasKey(L"id") && input.GetNamedValue(L"id").ValueType() == JsonValueType::Number,
            "run_control_foreign");
    const double number = input.GetNamedNumber(L"id");
    require(number > 0 && number == static_cast<std::uint64_t>(number), "run_control_foreign");
    const auto id = static_cast<std::uint64_t>(number);
    auto found = registry_.find(id);
    const bool foreign = found == registry_.end();
    if (!foreign && !found->second->retired) {
      runControlRetire(*found->second, false);
      found->second->retired = true;
    }
    JsonObject result;
    flag(result, L"closed", true);
    flag(result, L"foreign", foreign);
    return result;
  }

  JsonObject shutdown() {
    if (shutdown_)
      return runControlShutdownReceipt();
    shutdown_ = true;
    if (listener_) {
      listener_->pending.reset();
      listener_.reset();
    }
    for (auto &entry : registry_)
      if (!entry.second->retired)
        runControlRetire(*entry.second, true);
    return runControlShutdownReceipt();
  }

  JsonObject request(const std::wstring &operation, const JsonObject &input) {
    if (operation == L"listen")
      return listen(input);
    if (operation == L"connect")
      return connect(input);
    if (operation == L"accept")
      return accept(input);
    if (operation == L"read")
      return read(input);
    if (operation == L"write")
      return write(input);
    if (operation == L"close")
      return close(input);
    if (operation == L"shutdown")
      return shutdown();
    throw NativeError{"run_control_foreign"};
  }

private:
  enum class Side { client, server };
  struct IoOperation {
    OVERLAPPED overlap{};
    Handle event;
    std::vector<BYTE> bytes;
    DWORD transferred = 0;
    bool poisoned = false;
    bool unresolved = false;
  };
  struct Connection {
    std::uint64_t id = 0;
    Side side = Side::client;
    Handle pipe;
    DWORD timeout = 0;
    std::wstring endpoint;
    bool authenticated = false;
    bool poisoned = false;
    bool retired = false;
    std::vector<std::unique_ptr<IoOperation>> pending;
    std::string readAccum;
    ProcessPin peer;
    ProcessPin local;
  };
  struct Listener {
    std::uint64_t generation = 0;
    std::wstring name;
    std::wstring endpoint;
    std::wstring owner;
    Handle pending;
  };

  explicit WindowsNativeRunControl(HeldInputs held) : held_(std::move(held)) {
    require(held_.selectedDirectory && held_.config && held_.intendedBun &&
                held_.processImage && held_.selectedDirectory != held_.config &&
                held_.selectedDirectory != held_.intendedBun &&
                held_.selectedDirectory != held_.processImage &&
                held_.config != held_.intendedBun && held_.config != held_.processImage &&
                held_.intendedBun != held_.processImage && !held_.sealedBinding.empty() &&
                !held_.expected.bytes.empty(),
            "run_control_held_inputs");
    runControlDuplicateHeld();
    ownerSid_ = runControlCurrentSid();
    runControlCopyCurrentSid(ownerSidBytes_);
    expected_ = held_.expected;
    sealedBinding_ = held_.expected.bytes;
    runControlValidateHeldInputs();
  }

  static std::uint64_t runControlNewId() {
    static std::uint64_t next = 1;
    require(next < std::numeric_limits<std::uint64_t>::max(), "run_control_foreign");
    return next++;
  }
  static DWORD runControlTimeoutMs(const JsonObject &value, const wchar_t *key) {
    require(value.HasKey(key) && value.GetNamedValue(key).ValueType() == JsonValueType::Number,
            "run_control_timeout");
    const double raw = value.GetNamedNumber(key);
    require(raw >= 1.0 && raw <= 30000.0 && raw == std::floor(raw) &&
                raw <= static_cast<double>(std::numeric_limits<DWORD>::max()),
            "run_control_timeout");
    return static_cast<DWORD>(raw);
  }
  static bool runControlValidPipeEndpoint(const std::wstring &value) {
    return value.size() > 10 && value.rfind(L"\\\\.\\pipe\\", 0) == 0 &&
           value.find(L'\\', 9) == std::wstring::npos && value.find(L'\0') == std::wstring::npos;
  }
  static std::wstring runControlUnpredictablePipeName() {
    BYTE random[16]{};
    require(BCryptGenRandom(nullptr, random, sizeof(random),
                            BCRYPT_USE_SYSTEM_PREFERRED_RNG) == STATUS_SUCCESS,
            "run_control_pipe_name");
    static const wchar_t hex[] = L"0123456789abcdef";
    std::wstring name = L"\\\\.\\pipe\\agt-v2-run-control-";
    for (BYTE byte : random) {
      name += hex[byte >> 4];
      name += hex[byte & 15];
    }
    return name;
  }
  static PSECURITY_DESCRIPTOR runControlProtectedPipeDescriptor(const std::wstring &owner) {
    const std::wstring sddl =
        L"O:" + owner + L"D:P(A;;GRGW;;;SY)(A;;GRGW;;;" + owner + L")S:(ML;;NW;;;LW)";
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != 0,
            "run_control_pipe_security");
    return descriptor;
  }
  Handle runControlCreateServer(const std::wstring &name, bool first) {
    LocalMemory descriptor{runControlProtectedPipeDescriptor(ownerSid_)};
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.value, FALSE};
    DWORD mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
    if (first)
      mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    HANDLE raw = CreateNamedPipeW(name.c_str(), mode,
                                  PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
                                      PIPE_REJECT_REMOTE_CLIENTS,
                                  static_cast<DWORD>(MAX_CONNECTIONS), MAX_FRAME_BYTES,
                                  MAX_FRAME_BYTES, 0, &attributes);
    require(raw != INVALID_HANDLE_VALUE, "run_control_listen_unknown");
    return Handle(raw);
  }
  std::unique_ptr<Connection> runControlMakeConnection(Handle pipe, Side side, DWORD timeout) {
    require(static_cast<bool>(pipe), "run_control_foreign");
    std::unique_ptr<Connection> connection(new Connection);
    connection->id = runControlNewId();
    connection->side = side;
    connection->pipe = std::move(pipe);
    connection->timeout = timeout;
    return connection;
  }
  Connection &runControlConnectionFor(const JsonObject &input) {
    require(input.HasKey(L"id") && input.GetNamedValue(L"id").ValueType() == JsonValueType::Number,
            "run_control_foreign");
    const double number = input.GetNamedNumber(L"id");
    require(number > 0 && number == static_cast<std::uint64_t>(number), "run_control_foreign");
    const auto id = static_cast<std::uint64_t>(number);
    auto found = registry_.find(id);
    require(found != registry_.end() && !found->second->retired && !found->second->poisoned,
            "run_control_foreign");
    return *found->second;
  }
  size_t runControlActiveCount() const {
    size_t count = 0;
    for (const auto &entry : registry_)
      if (!entry.second->retired)
        ++count;
    return count;
  }
  static bool runControlStrictUtf8(const std::string &value) {
    size_t i = 0;
    while (i < value.size()) {
      const unsigned char first = static_cast<unsigned char>(value[i]);
      if (first == 0 || first < 0x80) {
        ++i;
        continue;
      }
      size_t count = 0;
      unsigned code = 0;
      if ((first & 0xe0) == 0xc0) {
        count = 2;
        code = first & 0x1f;
      } else if ((first & 0xf0) == 0xe0) {
        count = 3;
        code = first & 0x0f;
      } else if ((first & 0xf8) == 0xf0) {
        count = 4;
        code = first & 0x07;
      } else
        return false;
      if (i + count > value.size())
        return false;
      for (size_t j = 1; j < count; ++j) {
        const unsigned char next = static_cast<unsigned char>(value[i + j]);
        if ((next & 0xc0) != 0x80)
          return false;
        code = (code << 6) | (next & 0x3f);
      }
      if ((count == 2 && code < 0x80) || (count == 3 && code < 0x800) ||
          (count == 4 && code < 0x10000) || code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff))
        return false;
      i += count;
    }
    return true;
  }
  static std::string runControlNarrow(const std::wstring &value) {
    if (value.empty())
      return {};
    const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                          static_cast<int>(value.size()), nullptr, 0, nullptr,
                                          nullptr);
    require(count > 0, "run_control_frame_utf8");
    std::string result(static_cast<size_t>(count), 0);
    require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                static_cast<int>(value.size()), result.data(), count, nullptr,
                                nullptr) == count,
            "run_control_frame_utf8");
    require(runControlStrictUtf8(result), "run_control_frame_utf8");
    return result;
  }
  static std::wstring runControlWide(const std::string &value) {
    require(runControlStrictUtf8(value), "run_control_frame_utf8");
    if (value.empty())
      return {};
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                          static_cast<int>(value.size()), nullptr, 0);
    require(count > 0, "run_control_frame_utf8");
    std::wstring result(static_cast<size_t>(count), 0);
    require(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                static_cast<int>(value.size()), result.data(), count) == count,
            "run_control_frame_utf8");
    return result;
  }
  static bool runControlSameFile(const FilePin &a, const FilePin &b) {
    return a.volumeSerial == b.volumeSerial && a.fileId == b.fileId && a.size == b.size &&
           a.directory == b.directory && a.hasSha256 == b.hasSha256 &&
           (!a.hasSha256 || a.sha256 == b.sha256);
  }
  static bool runControlSameSid(const std::vector<BYTE> &a, const std::vector<BYTE> &b) {
    return a.size() == b.size() && !a.empty() && std::memcmp(a.data(), b.data(), a.size()) == 0;
  }
  static bool runControlSameBirth(const FILETIME &a, const FILETIME &b) {
    return filetime(a) == filetime(b);
  }
  static FilePin runControlObserveFile(HANDLE file, bool directory) {
    FILE_ID_INFO id{};
    FILE_ATTRIBUTE_TAG_INFO tag{};
    FILE_STANDARD_INFO standard{};
    require(GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id)) &&
                GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) &&
                GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)),
            "run_control_held_identity");
    require(!(tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
                !!standard.Directory == directory && standard.NumberOfLinks == 1,
            "run_control_held_identity");
    FilePin pin;
    std::memcpy(pin.fileId.data(), id.FileId.Identifier, pin.fileId.size());
    pin.volumeSerial = id.VolumeSerialNumber;
    pin.size = static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
    pin.directory = directory;
    return pin;
  }
  static std::array<BYTE, 32> runControlHash(HANDLE file) {
    LARGE_INTEGER origin{};
    require(SetFilePointerEx(file, origin, nullptr, FILE_BEGIN) != 0,
            "run_control_image_hash");
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) ==
                STATUS_SUCCESS,
            "run_control_image_hash");
    ULONG objectLength = 0, ignored = 0;
    require(BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                              reinterpret_cast<PUCHAR>(&objectLength), sizeof(objectLength),
                              &ignored, 0) == STATUS_SUCCESS,
            "run_control_image_hash");
    std::vector<BYTE> state(objectLength), buffer(64 * 1024);
    std::array<BYTE, 32> digest{};
    require(BCryptCreateHash(algorithm, &hash, state.data(), objectLength, nullptr, 0, 0) ==
                STATUS_SUCCESS,
            "run_control_image_hash");
    for (;;) {
      DWORD read = 0;
      if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
        require(GetLastError() == ERROR_HANDLE_EOF, "run_control_image_hash");
        break;
      }
      if (read == 0)
        break;
      require(BCryptHashData(hash, buffer.data(), read, 0) == STATUS_SUCCESS,
              "run_control_image_hash");
    }
    require(BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) ==
                STATUS_SUCCESS,
            "run_control_image_hash");
    BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    LARGE_INTEGER reset{};
    require(SetFilePointerEx(file, reset, nullptr, FILE_BEGIN) != 0,
            "run_control_image_hash");
    return digest;
  }
  static std::wstring runControlCurrentSid() {
    std::vector<BYTE> copied;
    runControlCopyCurrentSid(copied);
    return runControlSidString(copied.data());
  }
  static void runControlCopyCurrentSid(std::vector<BYTE> &copied) {
    HANDLE raw = nullptr;
    require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw) != 0,
            "run_control_owner_identity");
    Handle token(raw);
    DWORD size = 0;
    GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
    require(size > 0 && size < 1024 * 1024, "run_control_owner_identity");
    std::vector<BYTE> information(size);
    require(GetTokenInformation(token.value, TokenUser, information.data(), size, &size) != 0,
            "run_control_owner_identity");
    PSID sid = reinterpret_cast<TOKEN_USER *>(information.data())->User.Sid;
    const DWORD length = GetLengthSid(sid);
    require(length > 0 && length <= SECURITY_MAX_SID_SIZE, "run_control_owner_identity");
    copied.resize(length);
    require(CopySid(length, copied.data(), sid) != 0, "run_control_owner_identity");
  }
  static std::wstring runControlSidString(PSID sid) {
    LPWSTR value = nullptr;
    require(ConvertSidToStringSidW(sid, &value) != 0, "run_control_owner_identity");
    LocalMemory memory{value};
    return value;
  }
  static std::vector<BYTE> runControlProcessSid(HANDLE process) {
    HANDLE raw = nullptr;
    require(OpenProcessToken(process, TOKEN_QUERY, &raw) != 0, "run_control_owner_identity");
    Handle token(raw);
    DWORD size = 0;
    GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
    require(size > 0 && size < 1024 * 1024, "run_control_owner_identity");
    std::vector<BYTE> information(size);
    require(GetTokenInformation(token.value, TokenUser, information.data(), size, &size) != 0,
            "run_control_owner_identity");
    PSID sid = reinterpret_cast<TOKEN_USER *>(information.data())->User.Sid;
    const DWORD length = GetLengthSid(sid);
    require(length > 0 && length <= SECURITY_MAX_SID_SIZE, "run_control_owner_identity");
    std::vector<BYTE> copied(length);
    require(CopySid(length, copied.data(), sid) != 0, "run_control_owner_identity");
    return copied;
  }
  static FILETIME runControlBirth(HANDLE process) {
    FILETIME creation{}, exitTime{}, kernel{}, user{};
    require(GetProcessTimes(process, &creation, &exitTime, &kernel, &user) != 0,
            "run_control_process_identity");
    return creation;
  }
  static bool runControlAlive(HANDLE process) {
    return WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
  }
  static std::wstring runControlImagePath(HANDLE process) {
    std::vector<wchar_t> path(32768);
    DWORD size = static_cast<DWORD>(path.size());
    require(QueryFullProcessImageNameW(process, 0, path.data(), &size) != 0 && size > 0,
            "run_control_process_identity");
    return std::wstring(path.data(), size);
  }
  static FilePin runControlProcessImagePin(HANDLE process) {
    const auto path = runControlImagePath(process);
    require(path.size() >= 3 && path[1] == L':' && path[2] == L'\\',
            "run_control_path_alias");
    const auto extended = L"\\\\?\\" + path;
    Handle image(CreateFileW(extended.c_str(), GENERIC_READ,
                            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                            OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(static_cast<bool>(image), "run_control_process_identity");
    return runControlObserveFile(image.value, false);
  }
  static std::uint64_t runControlParentPid(HANDLE process) {
    using NtQueryInformationProcessFn =
        NTSTATUS(NTAPI *)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG, PULONG);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    require(ntdll != nullptr, "run_control_parent_join");
    auto query = reinterpret_cast<NtQueryInformationProcessFn>(
        GetProcAddress(ntdll, "NtQueryInformationProcess"));
    require(query != nullptr, "run_control_parent_join");
    // Native layout is kept local so this does not invent public SDK fields.
    struct RunControlProcessBasicInformation {
      PVOID reserved1;
      PVOID pebBaseAddress;
      PVOID reserved2[2];
      ULONG_PTR uniqueProcessId;
      ULONG_PTR inheritedFromUniqueProcessId;
    } information{};
    ULONG returned = 0;
    const NTSTATUS status =
        query(process, ProcessBasicInformation, &information, sizeof(information), &returned);
    require(status >= 0 && returned >= sizeof(information), "run_control_parent_join");
    return static_cast<std::uint64_t>(information.inheritedFromUniqueProcessId);
  }
  static ProcessPin runControlObserveProcess(HANDLE process) {
    require(runControlAlive(process), "run_control_process_identity");
    const FILETIME first = runControlBirth(process);
    const FILETIME second = runControlBirth(process);
    require(runControlSameBirth(first, second), "run_control_process_identity");
    ProcessPin pin;
    pin.pid = GetProcessId(process);
    pin.birth = first;
    pin.sid = runControlProcessSid(process);
    pin.image = runControlProcessImagePin(process);
    return pin;
  }
  static bool runControlSameProcess(const ProcessPin &a, const ProcessPin &b) {
    return a.pid == b.pid && runControlSameBirth(a.birth, b.birth) &&
           runControlSameSid(a.sid, b.sid) && runControlSameFile(a.image, b.image);
  }
  static bool runControlPrivateFile(HANDLE file, const std::wstring &owner) {
    return privateAcl(file, owner, nullptr);
  }
  void runControlDuplicateHeld() {
    HANDLE root = nullptr, config = nullptr, bun = nullptr, image = nullptr;
    require(DuplicateHandle(GetCurrentProcess(), held_.selectedDirectory, GetCurrentProcess(),
                            &root, 0, FALSE, DUPLICATE_SAME_ACCESS) &&
                DuplicateHandle(GetCurrentProcess(), held_.config, GetCurrentProcess(), &config,
                                0, FALSE, DUPLICATE_SAME_ACCESS) &&
                DuplicateHandle(GetCurrentProcess(), held_.intendedBun, GetCurrentProcess(), &bun,
                                0, FALSE, DUPLICATE_SAME_ACCESS) &&
                DuplicateHandle(GetCurrentProcess(), held_.processImage, GetCurrentProcess(),
                                &image, 0, FALSE, DUPLICATE_SAME_ACCESS),
            "run_control_held_inputs");
    selectedDirectory_.reset(root);
    config_.reset(config);
    intendedBun_.reset(bun);
    processImage_.reset(image);
  }
  void runControlValidateHeldInputs() {
    const FilePin root = runControlObserveFile(selectedDirectory_.value, true);
    const FilePin config = runControlObserveFile(config_.value, false);
    const FilePin imageBefore = runControlObserveFile(processImage_.value, false);
    require(runControlSameFile(root, expected_.root) &&
                runControlSameFile(config, expected_.config) &&
                runControlSameFile(imageBefore, expected_.image) &&
                root.fileId != config.fileId && root.fileId != imageBefore.fileId &&
                config.fileId != imageBefore.fileId &&
                runControlPrivateFile(selectedDirectory_.value, ownerSid_) &&
                runControlPrivateFile(config_.value, ownerSid_) &&
                runControlPrivateFile(processImage_.value, ownerSid_),
            "run_control_held_identity");
    const auto imageHash = runControlHash(processImage_.value);
    const FilePin imageAfter = runControlObserveFile(processImage_.value, false);
    require(imageBefore.fileId == imageAfter.fileId &&
                imageBefore.volumeSerial == imageAfter.volumeSerial &&
                imageBefore.size == imageAfter.size && imageBefore.size > 0 &&
                imageAfter.size == expected_.image.size && imageHash == expected_.image.sha256 &&
                expected_.image.hasSha256,
            "run_control_image_changed");
    heldImageHash_ = imageHash;
    const ProcessPin child = runControlObserveProcess(intendedBun_.value);
    require(runControlSameProcess(child, expected_.client) &&
                runControlSameFile(child.image, expected_.image) &&
                runControlParentPid(intendedBun_.value) == GetCurrentProcessId(),
            "run_control_parent_join");
    const FILETIME parentBirth = runControlBirth(GetCurrentProcess());
    require(filetime(parentBirth) <= filetime(child.birth), "run_control_parent_birth");
    require(runControlSameBirth(parentBirth, runControlBirth(GetCurrentProcess())),
            "run_control_parent_birth");
    require(runControlSameSid(child.sid, expected_.client.sid), "run_control_held_identity");
  }
  void runControlRevalidateHeld() {
    require(runControlAlive(intendedBun_.value), "run_process_changed");
    const FilePin before = runControlObserveFile(processImage_.value, false);
    const auto hash = runControlHash(processImage_.value);
    const FilePin after = runControlObserveFile(processImage_.value, false);
    require(runControlSameFile(before, expected_.image) &&
                runControlSameFile(after, expected_.image) && before.size == after.size &&
                hash == heldImageHash_, "run_control_image_changed");
    const ProcessPin child = runControlObserveProcess(intendedBun_.value);
    require(runControlSameProcess(child, expected_.client), "run_process_changed");
  }
  void runControlAuthenticate(Connection &connection) {
    runControlRevalidateHeld();
    const DWORD peerPid = connection.side == Side::server
                              ? runControlPipePeerPid(connection.pipe.value, true)
                              : runControlPipePeerPid(connection.pipe.value, false);
    require(peerPid != 0, "run_control_peer_identity");
    Handle peer(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, peerPid));
    require(static_cast<bool>(peer), "run_control_peer_identity");
    const ProcessPin peerPin = runControlObserveProcess(peer.value);
    const ProcessPin localPin = runControlObserveProcess(GetCurrentProcess());
    const ProcessPin expectedPeer = connection.side == Side::server ? expected_.client : expected_.server;
    const ProcessPin expectedLocal = connection.side == Side::server ? expected_.server : expected_.client;
    require(runControlSameProcess(peerPin, expectedPeer) &&
                runControlSameProcess(localPin, expectedLocal) &&
                runControlSameFile(peerPin.image, expectedPeer.image) &&
                runControlSameFile(localPin.image, expectedLocal.image),
            "run_control_peer_identity");
    connection.peer = peerPin;
    connection.local = localPin;
    connection.authenticated = true;
  }
  static DWORD runControlPipePeerPid(HANDLE pipe, bool client) {
    ULONG pid = 0;
    const BOOL ok = client ? GetNamedPipeClientProcessId(pipe, &pid)
                           : GetNamedPipeServerProcessId(pipe, &pid);
    require(ok && pid != 0, "run_control_peer_identity");
    return pid;
  }
  static DWORD runControlRemaining(std::uint64_t deadline) {
    const ULONGLONG now = GetTickCount64();
    if (now >= deadline)
      return 0;
    const ULONGLONG left = deadline - now;
    return left > MAXDWORD ? MAXDWORD : static_cast<DWORD>(left);
  }
  static bool runControlWaitOperation(HANDLE pipe, OVERLAPPED &overlap, DWORD &transferred,
                                      DWORD timeout, HANDLE event) {
    if (WaitForSingleObject(event, timeout) != WAIT_OBJECT_0)
      return false;
    return GetOverlappedResult(pipe, &overlap, &transferred, FALSE) != 0;
  }
  static void runControlCancelOperation(HANDLE pipe, OVERLAPPED &overlap, HANDLE event) {
    CancelIoEx(pipe, &overlap);
    DWORD transferred = 0;
    // Cancellation is not completion. Drain with a finite bound; callers retain
    // the operation when this returns and poison the capability.
    for (DWORD elapsed = 0; elapsed < CANCEL_DRAIN_MS; elapsed += 50) {
      if (GetOverlappedResult(pipe, &overlap, &transferred, FALSE) != 0 ||
          GetLastError() != ERROR_IO_INCOMPLETE)
        return;
      WaitForSingleObject(event, 50);
    }
  }
  std::string runControlReadFrame(Connection &connection, DWORD timeout) {
    require(connection.readAccum.size() <= MAX_FRAME_BYTES, "run_control_frame_oversize");
    const std::uint64_t deadline = GetTickCount64() + timeout;
    for (;;) {
      if (!connection.readAccum.empty() && connection.readAccum.back() == '\n') {
        const size_t newline = connection.readAccum.find('\n');
        require(newline == connection.readAccum.size() - 1 &&
                    connection.readAccum.find('\r') == std::string::npos,
                "run_control_frame_invalid");
        std::string frame = connection.readAccum.substr(0, newline);
        connection.readAccum.clear();
        require(frame.size() < MAX_FRAME_BYTES && runControlStrictUtf8(frame),
                "run_control_frame_invalid");
        return frame;
      }
      require(connection.readAccum.size() < MAX_FRAME_BYTES + 1, "run_control_frame_oversize");
      auto operation = std::unique_ptr<IoOperation>(new IoOperation);
      operation->bytes.resize(64 * 1024);
      operation->event = Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr));
      require(static_cast<bool>(operation->event), "run_control_read_unknown");
      operation->overlap.hEvent = operation->event.value;
      connection.pending.push_back(std::move(operation));
      IoOperation &io = *connection.pending.back();
      BOOL issued = ReadFile(connection.pipe.value, io.bytes.data(),
                             static_cast<DWORD>(io.bytes.size()), nullptr, &io.overlap);
      if (!issued && GetLastError() != ERROR_IO_PENDING) {
        io.poisoned = connection.poisoned = true;
        throw NativeError{"run_control_read_unknown", GetLastError(), "read"};
      }
      const DWORD remaining = runControlRemaining(deadline);
      if (!runControlWaitOperation(connection.pipe.value, io.overlap, io.transferred, remaining,
                                   io.event.value)) {
        runControlCancelOperation(connection.pipe.value, io.overlap, io.event.value);
        io.poisoned = connection.poisoned = true;
        throw NativeError{"run_control_timeout", ERROR_OPERATION_ABORTED, "read"};
      }
      const std::string part(reinterpret_cast<const char *>(io.bytes.data()), io.transferred);
      connection.readAccum += part;
      connection.pending.pop_back();
      if (part.empty())
        throw NativeError{"run_control_disconnected", ERROR_BROKEN_PIPE, "read"};
      if (connection.readAccum.size() > MAX_FRAME_BYTES + 1)
        throw NativeError{"run_control_frame_oversize"};
    }
  }
  void runControlWriteFrame(Connection &connection, const std::string &bytes, DWORD timeout) {
    const std::uint64_t deadline = GetTickCount64() + timeout;
    size_t offset = 0;
    while (offset < bytes.size()) {
      auto operation = std::unique_ptr<IoOperation>(new IoOperation);
      operation->bytes.assign(bytes.begin() + static_cast<std::ptrdiff_t>(offset), bytes.end());
      operation->event = Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr));
      require(static_cast<bool>(operation->event), "run_control_write_unknown");
      operation->overlap.hEvent = operation->event.value;
      connection.pending.push_back(std::move(operation));
      IoOperation &io = *connection.pending.back();
      BOOL issued = WriteFile(connection.pipe.value, io.bytes.data(),
                              static_cast<DWORD>(io.bytes.size()), nullptr, &io.overlap);
      if (!issued && GetLastError() != ERROR_IO_PENDING) {
        io.poisoned = connection.poisoned = true;
        throw NativeError{"run_control_write_unknown", GetLastError(), "write"};
      }
      const DWORD remaining = runControlRemaining(deadline);
      if (!runControlWaitOperation(connection.pipe.value, io.overlap, io.transferred, remaining,
                                   io.event.value)) {
        runControlCancelOperation(connection.pipe.value, io.overlap, io.event.value);
        io.poisoned = connection.poisoned = true;
        throw NativeError{"run_control_timeout", ERROR_OPERATION_ABORTED, "write"};
      }
      require(io.transferred > 0 && io.transferred <= io.bytes.size(),
              "run_control_write_partial");
      offset += io.transferred;
      connection.pending.pop_back();
    }
  }
  void runControlRetire(Connection &connection, bool shutdown) {
    for (auto &operation : connection.pending) {
      CancelIoEx(connection.pipe.value, &operation->overlap);
      runControlCancelOperation(connection.pipe.value, operation->overlap, operation->event.value);
      DWORD transferred = 0;
      if (GetOverlappedResult(connection.pipe.value, &operation->overlap, &transferred, FALSE) == 0 &&
          GetLastError() == ERROR_IO_INCOMPLETE) {
        operation->unresolved = operation->poisoned = true;
        connection.poisoned = true;
        if (!shutdown)
          throw NativeError{"cleanup_unknown"};
      }
    }
    connection.pipe.reset();
    connection.retired = true;
  }
  JsonObject runControlShutdownReceipt() const {
    JsonObject result;
    flag(result, L"shutdown", true);
    return result;
  }

  HeldInputs held_;
  ExpectedBinding expected_;
  std::vector<BYTE> sealedBinding_;
  std::array<BYTE, 32> heldImageHash_{};
  std::wstring ownerSid_;
  std::vector<BYTE> ownerSidBytes_;
  Handle selectedDirectory_, config_, intendedBun_, processImage_;
  std::unique_ptr<Listener> listener_;
  std::map<std::uint64_t, std::unique_ptr<Connection>> registry_;
  bool shutdown_ = false;
};
