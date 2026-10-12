#pragma once

#include <bcrypt.h>
#include <aclapi.h>
#include <sddl.h>
#include <winternl.h>

#include <algorithm>
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
  enum class Role { client, server };
  struct FilePin {
    std::array<BYTE, 16> fileId{};
    ULONGLONG volumeSerial = 0;
    std::uint64_t size = 0;
    std::array<BYTE, 32> sha256{};
    bool directory = false;
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
    ProcessPin parent, client, server;
    std::wstring endpoint;
  };
  struct HeldInputs {
    HANDLE selectedDirectory = nullptr;
    HANDLE config = nullptr;
    // This is the retained parent Bun PROCESS, never the local helper role.
    HANDLE intendedBun = nullptr;
    HANDLE processImage = nullptr;
    PSID selectedPackage = nullptr;
    Role localRole = Role::server;
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
    runControlAbandonPending();
  }

  static constexpr DWORD MAX_FRAME_BYTES = 512 * 1024;
  static constexpr size_t MAX_CONNECTIONS = 8;
  static constexpr size_t MAX_CAPABILITIES = 64;
  static constexpr size_t MAX_RETAINED_OPERATIONS = MAX_CONNECTIONS + 1;
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
    auto connection = runControlMakeConnection(std::move(pipe), Role::client, timeout);
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
    require(!listener_->poisoned && !listener_->acceptOperation, "run_control_foreign");
    require(runControlActiveCount() < MAX_CONNECTIONS &&
                registry_.size() < MAX_CAPABILITIES,
            "run_control_connection_limit");
    const DWORD timeout = runControlTimeoutMs(input, L"timeoutMs");
    require(static_cast<bool>(listener_->pending), "run_control_accept_unknown");
    auto owned = std::unique_ptr<IoOperation>(new IoOperation);
    owned->kind = IoKind::accept;
    owned->issuingHandle = runControlDuplicateHandle(listener_->pending.value);
    owned->event = Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    require(static_cast<bool>(owned->event), "run_control_accept_unknown");
    owned->overlap.hEvent = owned->event.value;
    IoOperation *operation = runControlRetain(std::move(owned));
    listener_->acceptOperation = operation;

    BOOL connected = ConnectNamedPipe(operation->issuingHandle.value, &operation->overlap);
    DWORD error = connected ? ERROR_SUCCESS : GetLastError();
    operation->issued = true;
    if (!connected && error != ERROR_IO_PENDING && error != ERROR_PIPE_CONNECTED) {
      operation->complete = true;
      operation->error = error;
      runControlForget(operation);
      throw NativeError{"run_control_accept_unknown", error, "accept"};
    }
    if (!connected && error == ERROR_IO_PENDING) {
      const auto wait = runControlWaitOperation(*operation, timeout);
      if (!wait.completed) {
        const auto cancelled = runControlCancelAndDrain(*operation);
        if (!cancelled.completed) {
          operation->unresolved = operation->poisoned = listener_->poisoned = true;
          throw NativeError{"cleanup_unknown", ERROR_OPERATION_ABORTED, "accept"};
        }
        runControlForget(operation);
        throw NativeError{"run_control_accept_timeout", ERROR_OPERATION_ABORTED, "accept"};
      }
      operation->transferred = wait.transferred;
      operation->error = wait.error;
    }
    require(operation->error == ERROR_SUCCESS, "run_control_accept_unknown");
    operation->complete = true;
    Handle accepted = std::move(operation->issuingHandle);
    runControlForget(operation);

    auto connection = runControlMakeConnection(std::move(accepted), Role::server, timeout);
    connection->endpoint = listener_->name;
    runControlAuthenticate(*connection);
    const auto id = connection->id;
    registry_.emplace(id, std::move(connection));

    // The accepted instance remains connected and owned by the registry. The
    // listener is independently retained and immediately offers a fresh server
    // instance; no DisconnectNamedPipe call destroys the accepted endpoint.
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
      const bool complete = runControlRetire(*found->second);
      if (!complete)
        throw NativeError{"cleanup_unknown", ERROR_OPERATION_ABORTED, "close"};
    }
    JsonObject result;
    flag(result, L"closed", true);
    flag(result, L"foreign", foreign);
    return result;
  }

  JsonObject shutdown() {
    if (shutdown_)
      return runControlShutdownReceipt(shutdownComplete_);
    shutdown_ = true;
    bool complete = true;
    if (listener_) {
      if (listener_->acceptOperation) {
        const auto cancelled = runControlCancelAndDrain(*listener_->acceptOperation);
        if (cancelled.completed)
          runControlForget(listener_->acceptOperation);
        else {
          listener_->acceptOperation->unresolved = listener_->acceptOperation->poisoned = true;
          listener_->poisoned = true;
          complete = false;
        }
      }
      listener_.reset();
    }
    for (auto &entry : registry_) {
      if (!entry.second->retired)
        complete = runControlRetire(*entry.second) && complete;
    }
    shutdownComplete_ = complete;
    return runControlShutdownReceipt(complete);
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
  enum class IoKind { accept, read, write };
  struct IoResult {
    bool completed = false;
    DWORD transferred = 0;
    DWORD error = ERROR_IO_INCOMPLETE;
  };
  struct IoOperation {
    OVERLAPPED overlap{};
    Handle event;
    Handle issuingHandle;
    std::vector<BYTE> bytes;
    DWORD transferred = 0;
    DWORD error = ERROR_SUCCESS;
    IoKind kind = IoKind::read;
    bool issued = false;
    bool complete = false;
    bool poisoned = false;
    bool unresolved = false;
  };
  struct Connection {
    std::uint64_t id = 0;
    Role side = Role::client;
    Handle pipe;
    DWORD timeout = 0;
    std::wstring endpoint;
    bool authenticated = false;
    bool poisoned = false;
    bool retired = false;
    std::vector<IoOperation *> pending;
    std::string readAccum;
    Handle peerProcess;
    ProcessPin peer;
    ProcessPin local;
  };
  struct Listener {
    std::uint64_t generation = 0;
    std::wstring name;
    std::wstring endpoint;
    std::wstring owner;
    Handle pending;
    IoOperation *acceptOperation = nullptr;
    bool poisoned = false;
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
  static Handle runControlDuplicateHandle(HANDLE source,
                                          const char *code = "run_control_held_inputs") {
    require(source != nullptr && source != INVALID_HANDLE_VALUE, "run_control_held_inputs");
    HANDLE raw = nullptr;
    require(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &raw, 0, FALSE,
                            DUPLICATE_SAME_ACCESS),
            code);
    Handle acquired(raw);
    require(static_cast<bool>(acquired), code);
    return acquired;
  }
  std::unique_ptr<Connection> runControlMakeConnection(Handle pipe, Role side, DWORD timeout) {
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
           a.directory == b.directory;
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
  static std::array<BYTE, 32> runControlSha256(HANDLE file) {
    struct Algorithm {
      BCRYPT_ALG_HANDLE value = nullptr;
      ~Algorithm() {
        if (value)
          BCryptCloseAlgorithmProvider(value, 0);
      }
    } algorithm;
    struct Hash {
      BCRYPT_HASH_HANDLE value = nullptr;
      ~Hash() {
        if (value)
          BCryptDestroyHash(value);
      }
    } hash;
    LARGE_INTEGER original{};
    require(SetFilePointerEx(file, LARGE_INTEGER{}, &original, FILE_CURRENT) != 0,
            "run_control_image_hash");
    struct Position {
      HANDLE file;
      LARGE_INTEGER position;
      ~Position() {
        SetFilePointerEx(file, position, nullptr, FILE_BEGIN);
      }
    } restore{file, original};
    require(SetFilePointerEx(file, LARGE_INTEGER{}, nullptr, FILE_BEGIN) != 0,
            "run_control_image_hash");
    require(BCryptOpenAlgorithmProvider(&algorithm.value, BCRYPT_SHA256_ALGORITHM, nullptr, 0) ==
                STATUS_SUCCESS,
            "run_control_image_hash");
    ULONG objectLength = 0, ignored = 0;
    require(BCryptGetProperty(algorithm.value, BCRYPT_OBJECT_LENGTH,
                              reinterpret_cast<PUCHAR>(&objectLength), sizeof(objectLength),
                              &ignored, 0) == STATUS_SUCCESS &&
                objectLength > 0 && objectLength <= 1024 * 1024,
            "run_control_image_hash");
    std::vector<BYTE> state(objectLength), buffer(64 * 1024);
    std::array<BYTE, 32> digest{};
    require(BCryptCreateHash(algorithm.value, &hash.value, state.data(), objectLength, nullptr, 0,
                             0) == STATUS_SUCCESS,
            "run_control_image_hash");
    for (;;) {
      DWORD read = 0;
      if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
        require(GetLastError() == ERROR_HANDLE_EOF, "run_control_image_hash");
        break;
      }
      if (read == 0)
        break;
      require(BCryptHashData(hash.value, buffer.data(), read, 0) == STATUS_SUCCESS,
              "run_control_image_hash");
    }
    require(BCryptFinishHash(hash.value, digest.data(), static_cast<ULONG>(digest.size()), 0) ==
                STATUS_SUCCESS,
            "run_control_image_hash");
    return digest;
  }
  static std::array<BYTE, 32> runControlVerifyImage(HANDLE file, const FilePin &sealed) {
    const FilePin before = runControlObserveFile(file, false);
    require(runControlSameFile(before, sealed), "run_control_image_changed");
    const auto digest = runControlSha256(file);
    const FilePin after = runControlObserveFile(file, false);
    require(runControlSameFile(before, after) && runControlSameFile(after, sealed) &&
                before.size > 0 && digest == sealed.sha256,
            "run_control_image_changed");
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
  void runControlDuplicateHeld() {
    Handle root = runControlDuplicateHandle(held_.selectedDirectory);
    Handle config = runControlDuplicateHandle(held_.config);
    Handle parent = runControlDuplicateHandle(held_.intendedBun);
    Handle image = runControlDuplicateHandle(held_.processImage);
    selectedDirectory_ = std::move(root);
    config_ = std::move(config);
    intendedBun_ = std::move(parent);
    processImage_ = std::move(image);
  }
  void runControlValidateHeldInputs() {
    const FilePin root = runControlObserveFile(selectedDirectory_.value, true);
    const FilePin config = runControlObserveFile(config_.value, false);
    const FilePin image = runControlObserveFile(processImage_.value, false);
    require(runControlSameFile(root, expected_.root) &&
                runControlSameFile(config, expected_.config) &&
                runControlSameFile(image, expected_.image) && root.fileId != config.fileId &&
                root.fileId != image.fileId && config.fileId != image.fileId,
            "run_control_held_identity");
    const JsonObject rootIdentity =
        fileIdentity(selectedDirectory_.value, ownerSid_, true, held_.selectedPackage);
    const JsonObject configIdentity =
        fileIdentity(config_.value, ownerSid_, false, held_.selectedPackage);
    const JsonObject imageIdentity =
        fileIdentity(processImage_.value, ownerSid_, false, held_.selectedPackage);
    require(rootIdentity.HasKey(L"fileId") && configIdentity.HasKey(L"fileId") &&
                imageIdentity.HasKey(L"fileId"),
            "run_control_held_identity");
    const auto imageHash = runControlVerifyImage(processImage_.value, expected_.image);
    heldImageHash_ = imageHash;

    const FILETIME parentBirthBefore = runControlBirth(intendedBun_.value);
    require(runControlAlive(intendedBun_.value), "run_control_parent_join");
    const ProcessPin parentBefore = runControlObserveProcess(intendedBun_.value);
    const ProcessPin helper = runControlObserveProcess(GetCurrentProcess());
    const ProcessPin parentAfter = runControlObserveProcess(intendedBun_.value);
    require(runControlParentPid(GetCurrentProcess()) == parentBefore.pid &&
                runControlSameProcess(parentBefore, parentAfter) &&
                runControlSameBirth(parentBirthBefore, parentAfter.birth),
            "run_control_parent_join");
    const FILETIME parentBirth = runControlBirth(GetCurrentProcess());
    require(filetime(parentBefore.birth) <= filetime(helper.birth) &&
                filetime(parentBirth) <= filetime(helper.birth),
            "run_control_parent_birth");
    require(runControlSameBirth(parentBirth, runControlBirth(GetCurrentProcess())),
            "run_control_parent_birth");
    const ProcessPin expectedLocal =
        held_.localRole == Role::server ? expected_.server : expected_.client;
    const ProcessPin expectedPeer =
        held_.localRole == Role::server ? expected_.client : expected_.server;
    require(runControlSameProcess(parentBefore, expected_.parent) &&
                runControlSameProcess(helper, expectedLocal) &&
                runControlSameFile(helper.image, expectedLocal.image) &&
                runControlSameFile(image, expectedLocal.image) &&
                !runControlSameProcess(expected_.client, expected_.server) &&
                !runControlSameProcess(expected_.parent, expected_.client) &&
                !runControlSameProcess(expected_.parent, expected_.server) &&
                !runControlSameProcess(expectedLocal, expectedPeer),
            "run_control_held_identity");
  }
  void runControlRevalidateHeld() {
    require(runControlAlive(intendedBun_.value), "run_control_parent_join");
    const ProcessPin parentBefore = runControlObserveProcess(intendedBun_.value);
    const ProcessPin helper = runControlObserveProcess(GetCurrentProcess());
    const ProcessPin parentAfter = runControlObserveProcess(intendedBun_.value);
    const ProcessPin expectedLocal =
        held_.localRole == Role::server ? expected_.server : expected_.client;
    require(runControlParentPid(GetCurrentProcess()) == parentBefore.pid &&
                runControlSameProcess(parentBefore, expected_.parent) &&
                runControlSameProcess(parentBefore, parentAfter) &&
                runControlSameProcess(helper, expectedLocal) &&
                runControlSameFile(helper.image, expectedLocal.image),
            "run_process_changed");
    const auto hash = runControlVerifyImage(processImage_.value, expected_.image);
    require(hash == heldImageHash_, "run_control_image_changed");
  }
  void runControlAuthenticate(Connection &connection) {
    runControlRevalidateHeld();
    const DWORD peerPid =
        connection.side == Role::server
            ? runControlPipePeerPid(connection.pipe.value, true)
            : runControlPipePeerPid(connection.pipe.value, false);
    require(peerPid != 0, "run_control_peer_identity");
    if (!connection.peerProcess) {
      Handle peer(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, peerPid));
      require(static_cast<bool>(peer), "run_control_peer_identity");
      connection.peerProcess = std::move(peer);
    }
    const ProcessPin peerPin = runControlObserveProcess(connection.peerProcess.value);
    const ProcessPin localPin = runControlObserveProcess(GetCurrentProcess());
    const ProcessPin expectedPeer =
        connection.side == Role::server ? expected_.client : expected_.server;
    const ProcessPin expectedLocal =
        connection.side == Role::server ? expected_.server : expected_.client;
    require(runControlSameProcess(peerPin, expectedPeer) &&
                runControlSameProcess(localPin, expectedLocal) &&
                runControlSameFile(peerPin.image, expectedPeer.image) &&
                runControlSameFile(localPin.image, expectedLocal.image) &&
                !runControlSameProcess(peerPin, localPin) &&
                (!connection.authenticated ||
                 (runControlSameProcess(peerPin, connection.peer) &&
                  runControlSameProcess(localPin, connection.local))),
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
  static IoResult runControlPollOperation(IoOperation &operation) {
    IoResult result;
    DWORD transferred = 0;
    if (GetOverlappedResult(operation.issuingHandle.value, &operation.overlap, &transferred,
                            FALSE) != 0) {
      result.completed = true;
      result.transferred = transferred;
      result.error = ERROR_SUCCESS;
    } else {
      const DWORD error = GetLastError();
      if (error != ERROR_IO_INCOMPLETE) {
        result.completed = true;
        result.transferred = transferred;
        result.error = error;
      }
    }
    return result;
  }
  static IoResult runControlWaitOperation(IoOperation &operation, DWORD timeout) {
    const DWORD waited = WaitForSingleObject(operation.event.value, timeout);
    if (waited == WAIT_TIMEOUT)
      return {};
    // A wait failure is not completion proof. GetOverlappedResult remains the
    // sole authority for both success and terminal failure of the kernel I/O.
    return runControlPollOperation(operation);
  }
  static IoResult runControlCancelAndDrain(IoOperation &operation) {
    if (operation.complete)
      return {true, operation.transferred, operation.error};
    CancelIoEx(operation.issuingHandle.value, &operation.overlap);
    const std::uint64_t deadline = GetTickCount64() + CANCEL_DRAIN_MS;
    for (;;) {
      const auto result = runControlPollOperation(operation);
      if (result.completed)
        return result;
      const DWORD remaining = runControlRemaining(deadline);
      if (remaining == 0)
        break;
      WaitForSingleObject(operation.event.value, remaining < 50 ? remaining : 50);
    }
    return runControlPollOperation(operation);
  }
  IoOperation *runControlRetain(std::unique_ptr<IoOperation> operation) {
    for (auto &slot : retainedIo_) {
      if (!slot) {
        IoOperation *raw = operation.get();
        slot = std::move(operation);
        return raw;
      }
    }
    require(false, "cleanup_unknown");
    return nullptr;
  }
  void runControlForget(IoOperation *operation) {
    if (listener_ && listener_->acceptOperation == operation)
      listener_->acceptOperation = nullptr;
    for (auto &entry : registry_) {
      auto &pending = entry.second->pending;
      pending.erase(std::remove(pending.begin(), pending.end(), operation), pending.end());
    }
    for (auto &slot : retainedIo_)
      if (slot.get() == operation)
        slot.reset();
  }
  void runControlAbandonPending() {
    // OVERLAPPED, event and issuing HANDLE storage must outlive this object if
    // the kernel has not reported completion. The fixed owner is bounded by one
    // operation per capability plus one accept operation.
    for (auto &slot : retainedIo_)
      if (slot)
        (void)slot.release();
  }
  static bool runControlExtractFrame(std::string &accum, std::string &frame) {
    if (accum.empty())
      return false;
    const size_t newline = accum.find('\n');
    if (newline == std::string::npos) {
      require(accum.size() <= MAX_FRAME_BYTES, "run_control_frame_oversize");
      return false;
    }
    require(newline + 1 <= MAX_FRAME_BYTES && accum.find('\r') == std::string::npos,
            "run_control_frame_invalid");
    frame.assign(accum.data(), newline);
    require(frame.size() < MAX_FRAME_BYTES && runControlStrictUtf8(frame),
            "run_control_frame_invalid");
    const size_t tail = accum.size() - newline - 1;
    require(tail <= MAX_FRAME_BYTES, "run_control_frame_oversize");
    accum.erase(0, newline + 1);
    return true;
  }
  std::string runControlReadFrame(Connection &connection, DWORD timeout) {
    require(connection.readAccum.size() <= MAX_FRAME_BYTES, "run_control_frame_oversize");
    const std::uint64_t deadline = GetTickCount64() + timeout;
    for (;;) {
      std::string frame;
      if (runControlExtractFrame(connection.readAccum, frame))
        return frame;
      auto operation = std::unique_ptr<IoOperation>(new IoOperation);
      operation->kind = IoKind::read;
      operation->issuingHandle =
          runControlDuplicateHandle(connection.pipe.value, "run_control_read_unknown");
      operation->bytes.resize(64 * 1024);
      operation->event = Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr));
      require(static_cast<bool>(operation->event), "run_control_read_unknown");
      operation->overlap.hEvent = operation->event.value;
      IoOperation *raw = runControlRetain(std::move(operation));
      connection.pending.push_back(raw);
      IoOperation &io = *raw;
      BOOL issued = ReadFile(io.issuingHandle.value, io.bytes.data(),
                             static_cast<DWORD>(io.bytes.size()), nullptr, &io.overlap);
      io.issued = true;
      const DWORD issueError = issued ? ERROR_SUCCESS : GetLastError();
      if (!issued && issueError != ERROR_IO_PENDING) {
        io.complete = true;
        io.error = issueError;
        io.poisoned = connection.poisoned = true;
        runControlForget(&io);
        throw NativeError{issueError == ERROR_BROKEN_PIPE ? "run_control_disconnected"
                                                         : "run_control_read_unknown",
                          issueError, "read"};
      }
      const auto waited = runControlWaitOperation(io, runControlRemaining(deadline));
      if (!waited.completed) {
        const auto cancelled = runControlCancelAndDrain(io);
        if (!cancelled.completed) {
          io.unresolved = io.poisoned = connection.poisoned = true;
          throw NativeError{"cleanup_unknown", ERROR_OPERATION_ABORTED, "read"};
        }
        io.complete = true;
        io.transferred = cancelled.transferred;
        io.error = cancelled.error;
        connection.readAccum.clear();
        connection.poisoned = true;
        const bool retired = runControlRetire(connection);
        if (!retired)
          throw NativeError{"cleanup_unknown", ERROR_OPERATION_ABORTED, "read"};
        throw NativeError{"run_control_timeout", ERROR_OPERATION_ABORTED, "read"};
      }
      io.complete = true;
      io.transferred = waited.transferred;
      io.error = waited.error;
      require(waited.error == ERROR_SUCCESS, waited.error == ERROR_BROKEN_PIPE
                                                  ? "run_control_disconnected"
                                                  : "run_control_read_unknown");
      require(waited.transferred <= io.bytes.size(), "run_control_read_unknown");
      const std::string part(reinterpret_cast<const char *>(io.bytes.data()), io.transferred);
      connection.readAccum += part;
      runControlForget(&io);
      if (part.empty())
        throw NativeError{"run_control_disconnected", ERROR_BROKEN_PIPE, "read"};
      if (connection.readAccum.size() > 2 * MAX_FRAME_BYTES)
        throw NativeError{"run_control_frame_oversize"};
    }
  }
  void runControlWriteFrame(Connection &connection, const std::string &bytes, DWORD timeout) {
    const std::uint64_t deadline = GetTickCount64() + timeout;
    size_t offset = 0;
    while (offset < bytes.size()) {
      auto operation = std::unique_ptr<IoOperation>(new IoOperation);
      operation->kind = IoKind::write;
      operation->issuingHandle =
          runControlDuplicateHandle(connection.pipe.value, "run_control_write_unknown");
      operation->bytes.assign(bytes.begin() + static_cast<std::ptrdiff_t>(offset), bytes.end());
      operation->event = Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr));
      require(static_cast<bool>(operation->event), "run_control_write_unknown");
      operation->overlap.hEvent = operation->event.value;
      IoOperation *raw = runControlRetain(std::move(operation));
      connection.pending.push_back(raw);
      IoOperation &io = *raw;
      BOOL issued = WriteFile(io.issuingHandle.value, io.bytes.data(),
                              static_cast<DWORD>(io.bytes.size()), nullptr, &io.overlap);
      io.issued = true;
      const DWORD issueError = issued ? ERROR_SUCCESS : GetLastError();
      if (!issued && issueError != ERROR_IO_PENDING) {
        io.complete = true;
        io.error = issueError;
        io.poisoned = connection.poisoned = true;
        runControlForget(&io);
        throw NativeError{issueError == ERROR_BROKEN_PIPE ? "run_control_disconnected"
                                                         : "run_control_write_unknown",
                          issueError, "write"};
      }
      const auto waited = runControlWaitOperation(io, runControlRemaining(deadline));
      if (!waited.completed) {
        const auto cancelled = runControlCancelAndDrain(io);
        if (!cancelled.completed) {
          io.unresolved = io.poisoned = connection.poisoned = true;
          throw NativeError{"cleanup_unknown", ERROR_OPERATION_ABORTED, "write"};
        }
        io.complete = true;
        io.transferred = cancelled.transferred;
        io.error = cancelled.error;
        connection.poisoned = true;
        const bool retired = runControlRetire(connection);
        if (!retired)
          throw NativeError{"cleanup_unknown", ERROR_OPERATION_ABORTED, "write"};
        throw NativeError{"run_control_timeout", ERROR_OPERATION_ABORTED, "write"};
      }
      io.complete = true;
      io.transferred = waited.transferred;
      io.error = waited.error;
      require(waited.error == ERROR_SUCCESS, waited.error == ERROR_BROKEN_PIPE
                                                  ? "run_control_disconnected"
                                                  : "run_control_write_unknown");
      require(waited.transferred > 0 && waited.transferred <= io.bytes.size(),
              "run_control_write_partial");
      offset += waited.transferred;
      runControlForget(&io);
    }
  }
  bool runControlRetire(Connection &connection) {
    bool complete = true;
    const auto pending = connection.pending;
    for (IoOperation *operation : pending) {
      const auto cancelled = runControlCancelAndDrain(*operation);
      if (cancelled.completed) {
        operation->complete = true;
        operation->transferred = cancelled.transferred;
        operation->error = cancelled.error;
        runControlForget(operation);
      } else {
        operation->unresolved = operation->poisoned = connection.poisoned = true;
        complete = false;
      }
    }
    if (!complete)
      return false;
    connection.pipe.reset();
    connection.retired = true;
    return complete;
  }
  JsonObject runControlShutdownReceipt(bool complete) const {
    JsonObject result;
    flag(result, L"shutdown", true);
    flag(result, L"complete", complete);
    flag(result, L"cleanupUnknown", !complete);
    flag(result, L"success", complete);
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
  std::array<std::unique_ptr<IoOperation>, MAX_RETAINED_OPERATIONS> retainedIo_;
  bool shutdown_ = false;
  bool shutdownComplete_ = true;
};
