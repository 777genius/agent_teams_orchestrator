#pragma once

#include <bcrypt.h>
#include <aclapi.h>
#include <sddl.h>
#include <winternl.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

// Included after WindowsKernelScope.cpp's HANDLE, NativeError and JSON helpers.
// The owner boundary is deliberately narrow: only the retained-selection root
// issuer can construct this object. All observable identifiers are registry
// generations; HANDLE and PID values never cross the JSON boundary.
static constexpr DWORD RUN_CONTROL_MAX_FRAME_BYTES = 512 * 1024;
static std::string runControlCanonicalJson(const IJsonValue &value) {
  switch (value.ValueType()) {
  case JsonValueType::Null:
    return "null";
  case JsonValueType::Boolean:
    return value.GetBoolean() ? "true" : "false";
  case JsonValueType::Number:
    return narrow(std::wstring(value.Stringify()));
  case JsonValueType::String:
    return narrow(std::wstring(JsonValue::CreateStringValue(value.GetString()).Stringify()));
  case JsonValueType::Array: {
    const auto array = value.GetArray();
    std::string out = "[";
    for (size_t i = 0; i < array.Size(); ++i) {
      if (i)
        out += ",";
      out += runControlCanonicalJson(array.GetAt(i));
    }
    return out + "]";
  }
  case JsonValueType::Object: {
    const auto object = value.GetObject();
    std::vector<std::pair<std::wstring, IJsonValue>> entries;
    for (auto pair : object)
      entries.emplace_back(std::wstring(pair.Key()), pair.Value());
    std::sort(entries.begin(), entries.end(),
              [](const auto &left, const auto &right) { return left.first < right.first; });
    std::string out = "{";
    for (size_t i = 0; i < entries.size(); ++i) {
      if (i)
        out += ",";
      out += narrow(std::wstring(JsonValue::CreateStringValue(entries[i].first).Stringify()));
      out += ":";
      out += runControlCanonicalJson(entries[i].second);
    }
    return out + "}";
  }
  default:
    throw NativeError{"run_control_frame_invalid"};
  }
}
static std::wstring runControlDigestHex(const std::array<BYTE, 32> &digest) {
  static const wchar_t hex[] = L"0123456789abcdef";
  std::wstring result;
  for (BYTE byte : digest) {
    result += hex[byte >> 4];
    result += hex[byte & 15];
  }
  return result;
}
static std::wstring runControlSha256Hex(const std::string &data) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  ULONG objectLength = 0, returned = 0;
  require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0 &&
              BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                                reinterpret_cast<PUCHAR>(&objectLength), sizeof(objectLength),
                                &returned, 0) == 0 &&
              objectLength > 0 && objectLength <= 4096,
          "run_control_hmac_unknown");
  std::vector<BYTE> object(objectLength), digest(32);
  const bool created = BCryptCreateHash(algorithm, &hash, object.data(), objectLength,
                                        nullptr, 0, 0) == 0;
  const bool hashed = created &&
                      BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char *>(data.data())),
                                     static_cast<ULONG>(data.size()), 0) == 0 &&
                      BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) == 0;
  if (hash)
    BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  require(hashed, "run_control_hmac_unknown");
  std::array<BYTE, 32> fixed{};
  std::memcpy(fixed.data(), digest.data(), fixed.size());
  return runControlDigestHex(fixed);
}
static std::vector<BYTE> runControlDecodeFrameBase64(const std::wstring &value) {
  require(value.size() % 4 == 0 && value.size() <= (RUN_CONTROL_MAX_FRAME_BYTES / 3) * 4,
          "run_control_frame_oversize");
  std::vector<BYTE> out;
  const size_t decodedUpperBound = (value.size() / 4) * 3;
  require(decodedUpperBound <= RUN_CONTROL_MAX_FRAME_BYTES, "run_control_frame_oversize");
  out.reserve(decodedUpperBound);
  auto digit = [](wchar_t c) -> int {
    if (c >= L'A' && c <= L'Z') return c - L'A';
    if (c >= L'a' && c <= L'z') return c - L'a' + 26;
    if (c >= L'0' && c <= L'9') return c - L'0' + 52;
    if (c == L'+') return 62;
    if (c == L'/') return 63;
    return -1;
  };
  for (size_t i = 0; i < value.size(); i += 4) {
    const int a = digit(value[i]), b = digit(value[i + 1]);
    const int c = value[i + 2] == L'=' ? 0 : digit(value[i + 2]);
    const int d = value[i + 3] == L'=' ? 0 : digit(value[i + 3]);
    require(a >= 0 && b >= 0 && c >= 0 && d >= 0 &&
                (i + 4 == value.size() || (value[i + 2] != L'=' && value[i + 3] != L'=')) &&
                !(value[i + 2] == L'=' && value[i + 3] != L'='),
            "run_control_frame_invalid");
    const unsigned v = (a << 18) | (b << 12) | (c << 6) | d;
    out.push_back(static_cast<BYTE>(v >> 16));
    if (value[i + 2] != L'=') out.push_back(static_cast<BYTE>(v >> 8));
    if (value[i + 3] != L'=') out.push_back(static_cast<BYTE>(v));
  }
  require(out.size() <= RUN_CONTROL_MAX_FRAME_BYTES, "run_control_frame_oversize");
  return out;
}
struct WindowsNativeRunControlIssuer;
struct WindowsNativeRunState;
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
  struct ExpectedEndpoint {
    ProcessPin helper, bun;
    bool present = false;
  };
  struct HeldInputs {
    HANDLE selectedDirectory = nullptr;
    HANDLE config = nullptr;
    // This is the retained parent Bun PROCESS, never the local helper role.
    HANDLE intendedBun = nullptr;
    HANDLE processImage = nullptr;
    PSID selectedPackage = nullptr;
    // Retained only by the native run-state issuer after its sealed join.
    std::shared_ptr<const ClosedControllerCohort> selectedCohort;
    // Optional AppContainer peer access is derived only from this retained
    // PROCESS and matched against the native Scope's own generated package SID.
    HANDLE packagePeerProcess = nullptr;
    PSID packagePeerSid = nullptr;
    Role localRole = Role::server;
    WindowsNativeRunState *runState = nullptr;
    bool fixedPeer = false;
    std::wstring sealedPath;
    std::wstring sealedBinding;
    ExpectedBinding expected;
    ExpectedEndpoint expectedEndpoint;
  };

  friend struct WindowsNativeRunControlIssuer;
  friend struct WindowsNativeRunStateIssuer;
  friend struct NativeSelfImageCustody;
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

  static constexpr DWORD MAX_FRAME_BYTES = RUN_CONTROL_MAX_FRAME_BYTES;
  static constexpr size_t MAX_CONNECTIONS = 8;
  static constexpr size_t MAX_CAPABILITIES = 64;
  static constexpr size_t MAX_RETAINED_OPERATIONS = MAX_CONNECTIONS + 1;
  static constexpr DWORD CANCEL_DRAIN_MS = 5000;

  JsonObject listen(const JsonObject &input) {
    std::lock_guard<std::recursive_mutex> lock(controlMutex_);
    (void)input;
    require(!listener_ && !shutdown_, "run_control_foreign");
    auto name = runControlUnpredictablePipeName();
    listener_.reset(new Listener);
    listener_->name = name;
    listener_->owner = ownerSid_;
    listener_->pending = runControlCreateServer(name, true);
    listener_->endpoint = name;
    expected_.endpoint = name;
    JsonObject result;
    num(result, L"id", listener_->generation = runControlNewId());
    str(result, L"name", name);
    return result;
  }
  void startRequestPump();
  void stopRequestPump();
  JsonObject endpointRecord(const JsonObject &binding, const std::wstring &directory,
                            std::uint64_t deadline, const std::wstring &sourceSha256) const {
    std::lock_guard<std::recursive_mutex> lock(controlMutex_);
    require(static_cast<bool>(listener_), "run_control_foreign");
    JsonObject record;
    num(record, L"schema", 1);
    num(record, L"protocol", 1);
    record.SetNamedValue(L"binding", binding);
    str(record, L"directory", directory);
    num(record, L"deadline", deadline);
    str(record, L"sourceSha256", sourceSha256);
    str(record, L"platform", L"win32");
    record.SetNamedValue(L"process", runControlNativeIdentity(GetCurrentProcess(), GetCurrentProcessId()));
    JsonObject endpoint;
    str(endpoint, L"kind", L"windows-native-pipe");
    str(endpoint, L"name", listener_->name);
    endpoint.SetNamedValue(L"helper", runControlNativeIdentity(GetCurrentProcess(), GetCurrentProcessId()));
    endpoint.SetNamedValue(L"bun", runControlNativeIdentity(intendedBun_.value,
                                                            GetProcessId(intendedBun_.value)));
    record.SetNamedValue(L"endpoint", endpoint);
    return record;
  }

  JsonObject connect(const JsonObject &input, std::uint64_t deadline = 0) {
    std::lock_guard<std::recursive_mutex> lock(controlMutex_);
    require(!shutdown_, "run_control_foreign");
    const auto endpoint = text(input, L"endpoint");
    require(runControlValidPipeEndpoint(endpoint) &&
                (expected_.endpoint.empty() || endpoint == expected_.endpoint),
            "run_control_foreign");
    runControlReapCompleted();
    require(runControlActiveCount() < MAX_CONNECTIONS &&
                registry_.size() < MAX_CAPABILITIES,
            "run_control_connection_limit");
    const DWORD timeout = runControlTimeoutMs(input, L"timeoutMs");
    if (deadline == 0) deadline = GetTickCount64() + timeout;
    Handle pipe;
    for (DWORD connectError = ERROR_SUCCESS;;) {
      // Budget expiry publishes the LAST observed endpoint condition, never an
      // ambiguous generic token: a pipe object absent for the whole budget means
      // no listener ever offered one, a saturated pool kept every instance busy,
      // and no attempt at all is idle. No errno text or endpoint is published.
      if (runControlRemaining(deadline) == 0) {
        if (connectError == ERROR_FILE_NOT_FOUND)
          throw NativeError{"run_control_connect_no_listener_expired"};
        if (connectError == ERROR_PIPE_BUSY || connectError == ERROR_SEM_TIMEOUT)
          throw NativeError{"run_control_connect_busy_timeout_expired"};
        throw NativeError{"run_control_connect_idle_expired"};
      }
      const HANDLE raw = CreateFileW(endpoint.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                                     OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
      const DWORD error = raw == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
      pipe = Handle(raw);
      if (pipe) break;
      connectError = error;
      // A saturated or momentarily absent endpoint is a wait inside the same
      // deadline, never a refusal; only an unexpected errno publishes the
      // closed connect failure.
      if (error != ERROR_PIPE_BUSY && error != ERROR_SEM_TIMEOUT &&
          error != ERROR_FILE_NOT_FOUND)
        throw NativeError{"run_control_connect_unknown", error, "connect"};
      const DWORD remaining = runControlRemaining(deadline);
      if (remaining == 0) continue;
      // Another client can win the next open; wait only for this same endpoint
      // and consume the original budget before any request bytes are submitted.
      if (!WaitNamedPipeW(endpoint.c_str(), remaining)) {
        const DWORD waitError = GetLastError();
        if (waitError != ERROR_SEM_TIMEOUT && waitError != ERROR_FILE_NOT_FOUND)
          throw NativeError{"run_control_connect_unknown", waitError, "connect"};
        connectError = waitError;
        // A missing endpoint is momentarily absent rather than refused; poll
        // the same deadline instead of expiring the caller on that absence.
        if (waitError == ERROR_FILE_NOT_FOUND)
          Sleep(10);
      }
    }
    auto connection = runControlMakeConnection(std::move(pipe), Role::client, timeout);
    connection->endpoint = endpoint;
    runControlAuthenticate(*connection);
    const auto id = connection->id;
    registry_.emplace(id, std::move(connection));
    JsonObject result;
    num(result, L"id", id);
    return result;
  }

  JsonObject accept(const JsonObject &input, bool retainIdleWait = false, const char **phase = nullptr) {
    if (phase) *phase = "accept_wait";
    std::unique_lock<std::recursive_mutex> lock(controlMutex_);
    require(listener_ && !shutdown_, "run_control_foreign");
    require(!listener_->poisoned && !listener_->acceptOperation, "run_control_foreign");
    runControlReapCompleted();
    // A saturated live owner keeps all held requests. Only its internal pump
    // waits for a free slot; an explicit low-level accept still refuses capacity.
    while (retainIdleWait && (runControlActiveCount() >= MAX_CONNECTIONS ||
                             registry_.size() >= MAX_CAPABILITIES)) {
      require(!requestPumpStop_ && !shutdown_, "run_control_accept_timeout");
      lock.unlock();
      Sleep(10);
      lock.lock();
      runControlReapCompleted();
    }
    require(listener_ && !shutdown_ && (!retainIdleWait || !requestPumpStop_),
            "run_control_accept_timeout");
    require(runControlActiveCount() < MAX_CONNECTIONS &&
                registry_.size() < MAX_CAPABILITIES,
            "run_control_connection_limit");
    const DWORD timeout = runControlTimeoutMs(input, L"timeoutMs");
    require(static_cast<bool>(listener_->pending), "run_control_accept_unknown");
    auto owned = std::make_shared<IoOperation>();
    owned->kind = IoKind::accept;
    owned->issuingHandle = runControlDuplicateHandle(listener_->pending.value);
    owned->event = Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    require(static_cast<bool>(owned->event), "run_control_accept_unknown");
    owned->overlap.hEvent = owned->event.value;
    auto operation = runControlRetain(std::move(owned));
    listener_->acceptOperation = operation;

    BOOL connected = ConnectNamedPipe(operation->issuingHandle.value, &operation->overlap);
    DWORD error = connected ? ERROR_SUCCESS : GetLastError();
    operation->issued = true;
    if (!connected && error != ERROR_IO_PENDING && error != ERROR_PIPE_CONNECTED) {
      operation->complete = true;
      operation->error = error;
      operation->poisoned = true;
      runControlForget(operation);
      throw NativeError{"run_control_accept_unknown", error, "accept"};
    }
    if (!connected && error == ERROR_IO_PENDING) {
      lock.unlock();
      auto wait = runControlWaitOperation(*operation, timeout);
      // The owner pump has no request deadline while waiting for a client.
      // Keep the same held HANDLE and OVERLAPPED across idle observation ticks.
      // Shutdown still enters the existing cancel-and-drain path within a tick;
      // explicit low-level accept requests retain their bounded timeout.
      while (!wait.completed && retainIdleWait && !requestPumpStop_ && !shutdown_)
        wait = runControlWaitOperation(*operation, timeout);
      if (!wait.completed) {
        const auto cancelled = runControlCancelAndDrain(*operation);
        lock.lock();
        if (!operation->complete) {
          if (!cancelled.completed) {
            operation->unresolved = operation->poisoned = true;
            if (listener_)
              listener_->poisoned = true;
            runControlForget(operation);
            throw NativeError{"cleanup_unknown", ERROR_OPERATION_ABORTED, "accept"};
          }
          operation->complete = true;
          operation->transferred = cancelled.transferred;
          operation->error = cancelled.error;
        }
        operation->poisoned = true;
        if (listener_)
          listener_->poisoned = true;
        runControlForget(operation);
        throw NativeError{"run_control_accept_timeout", ERROR_OPERATION_ABORTED, "accept"};
      }
      lock.lock();
      if (shutdown_ || operation->poisoned) {
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

    // The accepted instance remains connected and owned by the registry; no
    // DisconnectNamedPipe call destroys the accepted endpoint. Its fresh
    // listening replacement is offered before any fallible connection work, so
    // a refused handshake can never leave the listener without an instance.
    if (phase) *phase = "accept_replenish";
    runControlReapCompleted();
    runControlOfferPending();

    if (phase) *phase = "accept_authenticate";
    auto connection = runControlMakeConnection(std::move(accepted), Role::server, timeout);
    connection->endpoint = listener_->name;
    runControlAuthenticate(*connection);
    const auto id = connection->id;
    registry_.emplace(id, std::move(connection));
    JsonObject result;
    num(result, L"id", id);
    return result;
  }

  JsonObject read(const JsonObject &input) {
    std::shared_ptr<Connection> connection;
    DWORD timeout = 0;
    {
      std::lock_guard<std::recursive_mutex> lock(controlMutex_);
      connection = runControlConnectionFor(input);
      runControlAuthenticate(*connection);
      timeout = runControlTimeoutMs(input, L"timeoutMs");
    }
    auto frame = runControlReadFrame(*connection, timeout);
    JsonObject result;
    str(result, L"frame", runControlWide(frame));
    num(result, L"read", frame.size());
    return result;
  }

  JsonObject write(const JsonObject &input) {
    std::shared_ptr<Connection> connection;
    DWORD timeout = 0;
    std::string bytes;
    {
      std::lock_guard<std::recursive_mutex> lock(controlMutex_);
      connection = runControlConnectionFor(input);
      runControlAuthenticate(*connection);
      timeout = runControlTimeoutMs(input, L"timeoutMs");
      const auto value = text(input, L"frame");
      bytes = runControlNarrow(value);
      require(runControlStrictUtf8(bytes) && bytes.size() + 1 <= MAX_FRAME_BYTES &&
                  bytes.find('\r') == std::string::npos &&
                  bytes.find('\n') == std::string::npos,
              "run_control_frame_invalid");
      bytes.push_back('\n');
    }
    runControlWriteFrame(*connection, bytes, timeout);
    JsonObject result;
    num(result, L"written", bytes.size());
    return result;
  }

  JsonObject close(const JsonObject &input, std::uint64_t cleanupDeadline = 0) {
    std::shared_ptr<Connection> connection;
    bool foreign = false;
    {
      std::lock_guard<std::recursive_mutex> lock(controlMutex_);
      require(input.HasKey(L"id") && input.GetNamedValue(L"id").ValueType() == JsonValueType::Number,
              "run_control_foreign");
      const double number = input.GetNamedNumber(L"id");
      require(number > 0 && number == static_cast<std::uint64_t>(number), "run_control_foreign");
      const auto id = static_cast<std::uint64_t>(number);
      auto found = registry_.find(id);
      foreign = found == registry_.end();
      if (!foreign)
        connection = found->second;
    }
    if (connection && !runControlRetire(*connection, cleanupDeadline))
      throw NativeError{"cleanup_unknown", ERROR_OPERATION_ABORTED, "close"};
    JsonObject result;
    flag(result, L"closed", true);
    flag(result, L"foreign", foreign);
    return result;
  }

  JsonObject shutdown() {
    std::unique_lock<std::recursive_mutex> lock(controlMutex_);
    if (shutdown_)
      return runControlShutdownReceipt(shutdownComplete_);
    shutdown_ = true;
    requestPumpStop_ = true;
    std::vector<std::shared_ptr<IoOperation>> pending;
    for (auto &slot : retainedIo_) {
      if (!slot || !slot->issued || slot->complete)
        continue;
      slot->poisoned = true;
      CancelIoEx(slot->issuingHandle.value, &slot->overlap);
      pending.push_back(slot);
    }
    lock.unlock();
    // Every waiter owns its shared operation while the kernel observes
    // completion; state publication and retirement are reacquired below.
    for (const auto &operation : pending) {
      const auto cancelled = runControlCancelAndDrain(*operation);
      std::lock_guard<std::recursive_mutex> update(controlMutex_);
      if (cancelled.completed) {
        if (!operation->complete) {
          operation->complete = true;
          operation->transferred = cancelled.transferred;
          operation->error = cancelled.error;
        }
        runControlForget(operation);
      } else {
        operation->unresolved = operation->poisoned = true;
        runControlForget(operation);
      }
    }
    lock.lock();
    if (requestPump_.joinable()) {
      auto thread = std::move(requestPump_);
      lock.unlock();
      thread.join();
      lock.lock();
    }
    bool complete = true;
    if (listener_) {
      if (listener_->acceptOperation) {
        const auto operation = listener_->acceptOperation;
        if (operation->unresolved) {
          operation->poisoned = true;
          listener_->poisoned = true;
          complete = false;
        } else {
          runControlForget(operation);
        }
      }
      listener_.reset();
    }
    std::vector<std::shared_ptr<Connection>> connections;
    for (auto &entry : registry_)
      if (!entry.second->retired)
        connections.push_back(entry.second);
    lock.unlock();
    for (const auto &connection : connections)
      complete = runControlRetire(*connection) && complete;
    lock.lock();
    shutdownComplete_ = complete;
    return runControlShutdownReceipt(complete);
  }

  JsonObject request(const std::wstring &operation, const JsonObject &input) {
    // Shutdown coordinates its own cancellation and pump join after releasing
    // every dispatch acquisition. Read/write/accept each release the mutex while
    // the kernel wait runs and reacquire it before publishing state.
    if (operation == L"shutdown")
      return shutdown();
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
    throw NativeError{"run_control_foreign"};
  }

  void prepareExpectedEndpoint() {
    require(runState_, "run_control_endpoint_changed");
    const auto record = runState_->endpointRecord();
    const auto endpoint = object(record, L"endpoint");
    const auto name = text(endpoint, L"name");
    require(runControlValidPipeEndpoint(name), "run_control_endpoint_changed");
    const auto helperValue = object(endpoint, L"helper");
    const auto bunValue = object(endpoint, L"bun");
    const auto helperPid = static_cast<DWORD>(helperValue.GetNamedNumber(L"pid"));
    const auto bunPid = static_cast<DWORD>(bunValue.GetNamedNumber(L"pid"));
    Handle helper(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, helperPid));
    Handle bun(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, bunPid));
    require(helper && bun, "run_control_endpoint_changed");
    const auto helperIdentity = runControlNativeIdentity(helper.value, helperPid);
    const auto bunIdentity = runControlNativeIdentity(bun.value, bunPid);
    require(runControlCanonicalJson(helperIdentity) == runControlCanonicalJson(helperValue) &&
                runControlCanonicalJson(bunIdentity) == runControlCanonicalJson(bunValue),
            "run_control_endpoint_changed");
    expected_.endpoint = name;
    expectedEndpoint_.helper = runControlObserveProcess(helper.value);
    expectedEndpoint_.bun = runControlObserveProcess(bun.value);
    expectedEndpoint_.present = true;
  }

  JsonObject clientRequest(const std::string &payloadBytes, std::uint64_t deadline) {
    require(payloadBytes.size() <= MAX_FRAME_BYTES && runControlStrictUtf8(payloadBytes),
            "run_control_frame_invalid");
    auto payload = JsonObject::Parse(wide(payloadBytes));
    bool stop = false;
    if (payload.HasKey(L"request") && payload.GetNamedValue(L"request").ValueType() == JsonValueType::Object) {
      const auto request = payload.GetNamedObject(L"request");
      stop = request.Size() == 1 && request.HasKey(L"operation") &&
          request.GetNamedValue(L"operation").ValueType() == JsonValueType::String &&
          request.GetNamedString(L"operation") == L"stop";
    }
    std::uint64_t originalWallDeadline = 0;
    if (stop) {
      const double value = payload.GetNamedNumber(L"deadline");
      require(value > 0 && value <= 9007199254740991.0 &&
                  value == static_cast<double>(static_cast<std::uint64_t>(value)),
              "run_control_invalid");
      originalWallDeadline = static_cast<std::uint64_t>(value);
    }
    const DWORD available = runControlRemaining(deadline);
    require(available > 1, "run_control_client_budget_exhausted");
    const DWORD replyAllowance = std::min<DWORD>(100, std::max<DWORD>(1, available / 8));
    const DWORD cleanupAllowance = std::min<DWORD>(stop ? 1000 : CANCEL_DRAIN_MS, available / 4);
    const std::uint64_t cleanupDeadline = deadline - replyAllowance;
    const std::uint64_t ioDeadline = cleanupDeadline - cleanupAllowance;
    const auto remaining = [&] {
      const DWORD value = runControlRemaining(ioDeadline);
      require(value > 0, "run_control_client_budget_exhausted");
      return value;
    };
    prepareExpectedEndpoint();
    require(runState_ && expectedEndpoint_.present && payloadBytes.size() <= MAX_FRAME_BYTES &&
                runControlStrictUtf8(payloadBytes),
            "run_control_frame_invalid");
    JsonObject connectInput;
    str(connectInput, L"endpoint", expected_.endpoint);
    num(connectInput, L"timeoutMs", remaining());
    const auto connected = connect(connectInput, ioDeadline);
    const auto connection = runControlConnectionFor(connected);
    try {
      std::string signedPayload = payloadBytes;
      if (stop) {
        FILETIME wallTime{};
        GetSystemTimeAsFileTime(&wallTime);
        const auto wallNow = filetime(wallTime) / 10000 - 11644473600000ULL;
        const DWORD activeRemaining = remaining();
        require(activeRemaining > replyAllowance, "run_control_client_budget_exhausted");
        // Only shrink the caller's original deadline, leaving the existing
        // response-flush margin inside the active read window. Sign it AFTER
        // endpoint/connect work consumed its portion of the same30s budget.
        num(payload, L"deadline", std::min<std::uint64_t>(originalWallDeadline,
            wallNow + activeRemaining - replyAllowance));
        signedPayload = runControlCanonicalJson(payload);
        require(signedPayload.size() <= MAX_FRAME_BYTES && runControlStrictUtf8(signedPayload),
                "run_control_frame_invalid");
      }
      const auto mac = runControlHmacHex(runState_->challenge(), signedPayload);
      JsonObject frame;
      str(frame, L"payloadBytesBase64", wide(base64(std::vector<BYTE>(signedPayload.begin(),
                                                                     signedPayload.end()))));
      str(frame, L"mac", mac);
      const std::string frameBytes = narrow(std::wstring(frame.Stringify())) + "\n";
      runControlWriteFrame(*connection, frameBytes, remaining(), cleanupDeadline);
      const std::string responseBytes = runControlReadFrame(*connection, remaining(), cleanupDeadline);
      const auto responseFrame = JsonObject::Parse(wide(responseBytes));
      const auto responseMac = text(responseFrame, L"mac");
      const auto responsePayload = runControlDecodeFrameBase64(text(responseFrame, L"payloadBytesBase64"));
      require(responsePayload.size() <= MAX_FRAME_BYTES &&
                  responseMac == runControlHmacHex(runState_->challenge(),
                                                   std::string(responsePayload.begin(), responsePayload.end())),
              "run_control_foreign");
      const auto response = JsonObject::Parse(wide(std::string(responsePayload.begin(), responsePayload.end())));
      JsonObject result;
      result.SetNamedValue(L"response", response);
      close(connected, cleanupDeadline);
      return result;
    } catch (...) {
      if (!runControlRetire(*connection, cleanupDeadline))
        throw NativeError{"cleanup_unknown", ERROR_OPERATION_ABORTED, "close"};
      throw;
    }
  }

  JsonObject currentBunIdentity() const {
    return runControlNativeIdentity(intendedBun_.value, GetProcessId(intendedBun_.value));
  }

  void respond(const JsonObject &input) {
    std::shared_ptr<Connection> connection;
    DWORD timeout = 0;
    std::string frameBytes;
    {
      std::lock_guard<std::recursive_mutex> lock(controlMutex_);
      connection = runControlConnectionFor(input);
      require(input.HasKey(L"response") && input.GetNamedValue(L"response").ValueType() == JsonValueType::Object,
              "run_control_frame_invalid");
      const std::string bytes = runControlCanonicalJson(input.GetNamedValue(L"response"));
      require(bytes.size() <= MAX_FRAME_BYTES && runControlStrictUtf8(bytes), "run_control_frame_invalid");
      JsonObject frame;
      str(frame, L"payloadBytesBase64", wide(base64(std::vector<BYTE>(bytes.begin(), bytes.end()))));
      str(frame, L"mac", runControlHmacHex(runState_->challenge(), bytes));
      frameBytes = narrow(std::wstring(frame.Stringify())) + "\n";
      timeout = runControlTimeoutMs(input, L"timeoutMs");
    }
    runControlWriteFrame(*connection, frameBytes, timeout);
    std::lock_guard<std::recursive_mutex> lock(controlMutex_);
    connection->responseWritten = true;
  }

  void validateRequestPayload(std::uint64_t id, const JsonObject &payload) {
    std::lock_guard<std::recursive_mutex> lock(controlMutex_);
    auto found = registry_.find(id);
    require(found != registry_.end() && found->second->authenticated && found->second->sealedPeer,
            "run_control_peer_identity");
    const auto client = object(payload, L"client");
    auto &connection = *found->second;
    require(runControlAlive(connection.peerParent.value) &&
                runControlRequireFullToken(connection.peerParent.value),
            "run_control_peer_identity");
    const ProcessPin parentBefore = runControlObserveProcess(connection.peerParent.value);
    const auto measured = runControlNativeIdentity(connection.peerParent.value,
                                                   connection.peerParentPin.pid);
    const ProcessPin parentAfter = runControlObserveProcess(connection.peerParent.value);
    const ProcessPin peerAfter = runControlObserveProcess(connection.peerProcess.value);
    require(runControlSameProcess(parentBefore, connection.peerParentPin) &&
                runControlSameProcess(parentAfter, connection.peerParentPin) &&
                runControlSameProcess(peerAfter, connection.peer) &&
                runControlCanonicalJson(client) == runControlCanonicalJson(measured),
            "run_control_peer_identity");
    require(runState_ && runState_->validatePayload(payload), "run_control_foreign");
  }

  void poisonConnection(const JsonObject &input) {
    std::shared_ptr<Connection> connection;
    {
      std::lock_guard<std::recursive_mutex> lock(controlMutex_);
      connection = runControlConnectionFor(input);
      connection->poisoned = true;
    }
    (void)runControlRetire(*connection);
  }

private:
  static std::wstring runControlHmacHex(const std::vector<BYTE> &key,
                                        const std::string &data) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    ULONG objectLength = 0, returned = 0;
    require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr,
                                        BCRYPT_ALG_HANDLE_HMAC_FLAG) == 0 &&
                BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                                  reinterpret_cast<PUCHAR>(&objectLength), sizeof(objectLength),
                                  &returned, 0) == 0 &&
                objectLength > 0 && objectLength <= 4096,
            "run_control_hmac_unknown");
    std::vector<BYTE> object(objectLength);
    std::vector<BYTE> digest(32);
    const bool created =
        BCryptCreateHash(algorithm, &hash, object.data(), objectLength,
                         const_cast<PUCHAR>(key.data()), static_cast<ULONG>(key.size()), 0) == 0;
    const bool hashed = created &&
                        BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char *>(data.data())),
                                       static_cast<ULONG>(data.size()), 0) == 0 &&
                        BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) == 0;
    if (hash)
      BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    require(hashed, "run_control_hmac_unknown");
    return runControlHashHex(*reinterpret_cast<const std::array<BYTE, 32> *>(digest.data()));
  }

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
  // Pipe framing is deliberately separate from the bounded 16-KiB owner-record
  // and unbase64 decoders. Capacity is checked before every backing allocation.
  struct PipeFrameDecoder {
    std::string pending;
    void clear() { pending.clear(); }
    void feed(const BYTE *bytes, DWORD transferred) {
      require(bytes && transferred <= MAX_FRAME_BYTES, "run_control_read_unknown");
      require(transferred == 0 || pending.size() <= MAX_FRAME_BYTES - transferred,
              "run_control_frame_oversize");
      pending.append(reinterpret_cast<const char *>(bytes), transferred);
    }
    bool extract(std::string &frame) {
      const size_t newline = pending.find('\n');
      if (newline == std::string::npos) {
        require(pending.size() <= MAX_FRAME_BYTES, "run_control_frame_oversize");
        return false;
      }
      require(newline + 1 <= MAX_FRAME_BYTES && pending.find('\r') == std::string::npos,
              "run_control_frame_invalid");
      frame.assign(pending.data(), newline);
      require(frame.size() < MAX_FRAME_BYTES && runControlStrictUtf8(frame),
              "run_control_frame_invalid");
      pending.erase(0, newline + 1);
      require(pending.size() <= MAX_FRAME_BYTES, "run_control_frame_oversize");
      return true;
    }
  };
  struct Connection {
    std::uint64_t id = 0;
    Role side = Role::client;
    Handle pipe;
    DWORD timeout = 0;
    std::wstring endpoint;
    bool responseWritten = false;
    bool authenticated = false;
    bool poisoned = false;
    bool retired = false;
    std::vector<std::shared_ptr<IoOperation>> pending;
    PipeFrameDecoder frameDecoder;
    Handle peerProcess;
    Handle peerParent;
    ProcessPin peer, peerParentPin;
    ProcessPin local;
    bool sealedPeer = false;
  };
  struct Listener {
    std::uint64_t generation = 0;
    std::wstring name;
    std::wstring endpoint;
    std::wstring owner;
    Handle pending;
    std::shared_ptr<IoOperation> acceptOperation;
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
    expectedEndpoint_ = held_.expectedEndpoint;
    fixedPeer_ = held_.fixedPeer;
    runState_ = held_.runState;
    sealedBinding_ = held_.expected.bytes;
    runControlValidateHeldInputs();
    require((held_.packagePeerProcess == nullptr) == (held_.packagePeerSid == nullptr),
            "run_control_package_peer_identity");
    if (held_.packagePeerProcess) {
      packagePeerProcess_ = runControlDuplicateHandle(held_.packagePeerProcess);
      require(IsValidSid(held_.packagePeerSid), "run_control_package_peer_identity");
      const DWORD length = GetLengthSid(held_.packagePeerSid);
      require(length > 0 && length <= SECURITY_MAX_SID_SIZE, "run_control_package_peer_identity");
      expectedPackageSid_.resize(length);
      require(CopySid(length, expectedPackageSid_.data(), held_.packagePeerSid),
              "run_control_package_peer_identity");
      runControlValidatePackagePeer();
    }
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
                            BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0,
            "run_control_pipe_name");
    static const wchar_t hex[] = L"0123456789abcdef";
    std::wstring name = L"\\\\.\\pipe\\agt-v2-run-control-";
    for (BYTE byte : random) {
      name += hex[byte >> 4];
      name += hex[byte & 15];
    }
    return name;
  }
  static PSECURITY_DESCRIPTOR runControlProtectedPipeDescriptor(
      const std::wstring &owner, const std::wstring &packageSid) {
    std::wstring sddl = L"O:" + owner + L"D:P(A;;GRGW;;;SY)(A;;GRGW;;;" + owner + L")";
    if (!packageSid.empty()) sddl += L"(A;;GRGW;;;" + packageSid + L")";
    sddl += L"S:(ML;;NW;;;LW)";
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != 0,
            "run_control_pipe_security");
    return descriptor;
  }
  // A replenish refusal must never deny the endpoint its next listening
  // instance: transient instance exhaustion is retried before the failure
  // surfaces, and a create refusal never poisons the listener.
  void runControlOfferPending() {
    for (DWORD attempt = 0;; ++attempt) {
      try {
        listener_->pending = runControlCreateServer(listener_->name, false);
        return;
      } catch (const NativeError &failure) {
        if (attempt >= 2 || failure.win32 != ERROR_PIPE_BUSY)
          throw failure;
        Sleep(10);
      }
    }
  }
  Handle runControlCreateServer(const std::wstring &name, bool first) {
    if (packagePeerProcess_) runControlValidatePackagePeer();
    LocalMemory descriptor{runControlProtectedPipeDescriptor(ownerSid_, packageSid_)};
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.value, FALSE};
    DWORD mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
    if (first)
      mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    HANDLE raw = CreateNamedPipeW(name.c_str(), mode,
                                  PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
                                      PIPE_REJECT_REMOTE_CLIENTS,
                                  static_cast<DWORD>(MAX_CONNECTIONS + 2), MAX_FRAME_BYTES,
                                  MAX_FRAME_BYTES, 0, &attributes);
    if (raw == INVALID_HANDLE_VALUE)
      throw NativeError{"run_control_listen_unknown", GetLastError(), "listen"};
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
  std::shared_ptr<Connection> runControlMakeConnection(Handle pipe, Role side, DWORD timeout) {
    require(static_cast<bool>(pipe), "run_control_foreign");
    std::shared_ptr<Connection> connection(new Connection);
    connection->id = runControlNewId();
    connection->side = side;
    connection->pipe = std::move(pipe);
    connection->timeout = timeout;
    return connection;
  }
  std::shared_ptr<Connection> runControlConnectionFor(const JsonObject &input) {
    std::lock_guard<std::recursive_mutex> lock(controlMutex_);
    require(input.HasKey(L"id") && input.GetNamedValue(L"id").ValueType() == JsonValueType::Number,
            "run_control_foreign");
    const double number = input.GetNamedNumber(L"id");
    require(number > 0 && number == static_cast<std::uint64_t>(number), "run_control_foreign");
    const auto id = static_cast<std::uint64_t>(number);
    auto found = registry_.find(id);
    require(found != registry_.end() && !found->second->retired && !found->second->poisoned,
            "run_control_foreign");
    return found->second;
  }
  std::shared_ptr<Connection> runControlConnectionById(std::uint64_t id) {
    std::lock_guard<std::recursive_mutex> lock(controlMutex_);
    auto found = registry_.find(id);
    require(found != registry_.end() && !found->second->retired && !found->second->poisoned,
            "run_control_foreign");
    return found->second;
  }
  // No unread reply is discarded: a completed server response is retired only
  // after the kernel positively reports that its client closed this instance.
  // Pins held by in-flight callers outlive removal from this generation map.
  void runControlReapCompleted() {
    std::lock_guard<std::recursive_mutex> lock(controlMutex_);
    for (auto it = registry_.begin(); it != registry_.end();) {
      const auto connection = it->second;
      if (!connection->retired && connection->side == Role::server &&
          connection->responseWritten && connection->pending.empty()) {
        const BOOL connected = PeekNamedPipe(connection->pipe.value, nullptr, 0,
                                             nullptr, nullptr, nullptr);
        const DWORD error = connected ? ERROR_SUCCESS : GetLastError();
        if (!connected && (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED))
          (void)runControlRetire(*connection);
      }
      if (connection->retired && connection->pending.empty())
        it = registry_.erase(it);
      else
        ++it;
    }
  }
  size_t runControlActiveCount() const {
    std::lock_guard<std::recursive_mutex> lock(controlMutex_);
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
    };
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
                0,
            "run_control_image_hash");
    ULONG objectLength = 0, ignored = 0;
    require(BCryptGetProperty(algorithm.value, BCRYPT_OBJECT_LENGTH,
                              reinterpret_cast<PUCHAR>(&objectLength), sizeof(objectLength),
                              &ignored, 0) == 0 &&
                objectLength > 0 && objectLength <= 1024 * 1024,
            "run_control_image_hash");
    std::vector<BYTE> state(objectLength), buffer(64 * 1024);
    // BCrypt retains pbHashObject until DestroyHash; hash must be destroyed
    // before its backing vector, while the algorithm provider remains alive.
    Hash hash;
    std::array<BYTE, 32> digest{};
    require(BCryptCreateHash(algorithm.value, &hash.value, state.data(), objectLength, nullptr, 0,
                             0) == 0,
            "run_control_image_hash");
    for (;;) {
      DWORD read = 0;
      if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
        require(GetLastError() == ERROR_HANDLE_EOF, "run_control_image_hash");
        break;
      }
      if (read == 0)
        break;
      require(BCryptHashData(hash.value, buffer.data(), read, 0) == 0,
              "run_control_image_hash");
    }
    require(BCryptFinishHash(hash.value, digest.data(), static_cast<ULONG>(digest.size()), 0) ==
                0,
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
  static bool runControlRequireFullToken(HANDLE process) {
    HANDLE raw = nullptr;
    require(OpenProcessToken(process, TOKEN_QUERY, &raw) != 0, "run_control_peer_identity");
    Handle token(raw);
    DWORD size = 0;
    GetTokenInformation(token.value, TokenIsAppContainer, nullptr, 0, &size);
    require(size == sizeof(DWORD), "run_control_peer_identity");
    DWORD appContainer = 1;
    return GetTokenInformation(token.value, TokenIsAppContainer, &appContainer, size, &size) != 0 &&
           appContainer == 0;
  }
  static bool runControlRequireFreshFullTokens(HANDLE first, HANDLE second) {
    const bool firstFull = runControlRequireFullToken(first);
    const bool secondFull = runControlRequireFullToken(second);
    return firstFull && secondFull;
  }
  static FILETIME runControlBirth(HANDLE process) {
    FILETIME creation{}, exitTime{}, kernel{}, user{};
    if (!GetProcessTimes(process, &creation, &exitTime, &kernel, &user)) {
      const DWORD error = GetLastError();
      throw NativeError{"run_control_process_identity", error, "process_birth"};
    }
    return creation;
  }
  static bool runControlAlive(HANDLE process) {
    return WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
  }
  static std::wstring runControlImagePath(HANDLE process) {
    std::vector<wchar_t> path(32768);
    DWORD size = static_cast<DWORD>(path.size());
    if (!QueryFullProcessImageNameW(process, 0, path.data(), &size)) {
      const DWORD error = GetLastError();
      throw NativeError{"run_control_process_identity", error, "process_image_path"};
    }
    require(size > 0, "run_control_process_identity", "process_image_path");
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
    if (!image) {
      const DWORD error = GetLastError();
      throw NativeError{"run_control_process_identity", error, "process_image_open"};
    }
    auto pin = runControlObserveFile(image.value, false);
    pin.sha256 = runControlSha256(image.value);
    return pin;
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
    const DWORD status = WaitForSingleObject(process, 0);
    if (status != WAIT_TIMEOUT) {
      const DWORD error = status == WAIT_FAILED ? GetLastError() : status;
      throw NativeError{"run_control_process_identity", error,
                        status == WAIT_FAILED ? "process_alive_wait" : "process_alive"};
    }
    const FILETIME first = runControlBirth(process);
    const FILETIME second = runControlBirth(process);
    require(runControlSameBirth(first, second), "run_control_process_identity", "process_birth_changed");
    ProcessPin pin;
    pin.pid = GetProcessId(process);
    pin.birth = first;
    pin.sid = runControlProcessSid(process);
    pin.image = runControlProcessImagePin(process);
    return pin;
  }
  static JsonObject runControlNativeIdentity(HANDLE process, DWORD pid) {
    const auto pin = runControlObserveProcess(process);
    JsonObject value;
    num(value, L"pid", pid);
    JsonObject creation;
    str(creation, L"kind", L"windows-filetime");
    str(creation, L"value", decimal(filetime(pin.birth)));
    creation.SetNamedValue(L"bootId", JsonValue::CreateNullValue());
    value.SetNamedValue(L"processCreationTime", creation);
    str(value, L"executablePath", runControlImagePath(process));
    str(value, L"executableSha256", runControlHashHex(pin.image.sha256));
    require(!pin.sid.empty() && IsValidSid(const_cast<BYTE *>(pin.sid.data())),
            "run_control_owner_identity");
    str(value, L"userSid",
        runControlSidString(const_cast<BYTE *>(pin.sid.data())));
    flag(value, L"appContainer", false);
    return value;
  }
  static std::wstring runControlHashHex(const std::array<BYTE, 32> &hash) {
    static const wchar_t hex[] = L"0123456789abcdef";
    std::wstring result;
    for (BYTE byte : hash) {
      result += hex[byte >> 4];
      result += hex[byte & 15];
    }
    return result;
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
    const auto cohortSids = held_.selectedCohort
        ? closedControllerCohortSids(*held_.selectedCohort) : std::vector<std::wstring>();
    const auto *cohortSidsPtr = held_.selectedCohort ? &cohortSids : nullptr;
    const JsonObject rootIdentity =
        fileIdentity(selectedDirectory_.value, ownerSid_, true, held_.selectedPackage, cohortSidsPtr);
    const JsonObject configIdentity =
        fileIdentity(config_.value, ownerSid_, false, held_.selectedPackage, cohortSidsPtr);
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
                runControlSameFile(image, expectedLocal.image),
            "run_control_held_identity");
    if (fixedPeer_)
      require(!runControlSameProcess(expected_.client, expected_.server) &&
                  !runControlSameProcess(expected_.parent, expected_.client) &&
                  !runControlSameProcess(expected_.parent, expected_.server) &&
                  !runControlSameProcess(expectedLocal, expectedPeer),
              "run_control_held_identity");
  }
  void runControlValidatePackagePeer() {
    const ProcessPin expectedPeer = held_.localRole == Role::server ? expected_.client : expected_.server;
    const ProcessPin before = runControlObserveProcess(packagePeerProcess_.value);
    require(runControlAlive(packagePeerProcess_.value) && runControlSameProcess(before, expectedPeer),
            "run_control_package_peer_identity");
    HANDLE raw = nullptr;
    require(OpenProcessToken(packagePeerProcess_.value, TOKEN_QUERY, &raw),
            "run_control_package_peer_identity");
    Handle token(raw);
    DWORD isContainer = 0, returned = 0;
    require(GetTokenInformation(token.value, TokenIsAppContainer, &isContainer,
                                 sizeof(isContainer), &returned) &&
                returned == sizeof(isContainer) && isContainer == 1,
            "run_control_package_peer_identity");
    DWORD size = 0;
    GetTokenInformation(token.value, TokenAppContainerSid, nullptr, 0, &size);
    require(size >= sizeof(TOKEN_APPCONTAINER_INFORMATION) && size <= 65536,
            "run_control_package_peer_identity");
    std::vector<BYTE> information(size);
    require(GetTokenInformation(token.value, TokenAppContainerSid, information.data(),
                                 size, &returned) && returned >= sizeof(TOKEN_APPCONTAINER_INFORMATION) && returned <= size,
            "run_control_package_peer_identity");
    PSID actual = reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION *>(information.data())->TokenAppContainer;
    const auto first = reinterpret_cast<std::uintptr_t>(information.data());
    const auto last = first + returned;
    const auto address = reinterpret_cast<std::uintptr_t>(actual);
    require(actual && address >= first && address <= last && last - address >= 8,
            "run_control_package_peer_identity");
    const DWORD actualLength = GetLengthSid(actual);
    require(actualLength >= 8 && actualLength <= SECURITY_MAX_SID_SIZE &&
                actualLength <= last - address && IsValidSid(actual) &&
                EqualSid(actual, expectedPackageSid_.data()),
            "run_control_package_peer_identity");
    const auto actualString = runControlSidString(actual);
    require(actualString.rfind(L"S-1-15-2-", 0) == 0 && actualString != L"S-1-15-2-1",
            "run_control_package_peer_identity");
    const ProcessPin after = runControlObserveProcess(packagePeerProcess_.value);
    require(runControlSameProcess(before, after) && runControlSameProcess(after, expectedPeer),
            "run_control_package_peer_identity");
    if (!packageSid_.empty()) require(packageSid_ == actualString, "run_control_package_peer_identity");
    packageSid_ = actualString;
  }
  void runControlRevalidateHeld() {
    require(runControlAlive(intendedBun_.value), "run_control_parent_join");
    const ProcessPin parentBefore = runControlObserveProcess(intendedBun_.value);
    const ProcessPin helper = runControlObserveProcess(GetCurrentProcess());
    const ProcessPin parentAfter = runControlObserveProcess(intendedBun_.value);
    const ProcessPin expectedLocal =
        held_.localRole == Role::server ? expected_.server : expected_.client;
    require(runControlParentPid(GetCurrentProcess()) == parentBefore.pid &&
                runControlSameProcess(parentBefore, parentAfter) &&
                (fixedPeer_ ? runControlSameProcess(parentBefore, expected_.parent) &&
                                  runControlSameProcess(helper, expectedLocal) &&
                                  runControlSameFile(helper.image, expectedLocal.image)
                            : runControlRequireFreshFullTokens(intendedBun_.value,
                                                               GetCurrentProcess()) &&
                                  runControlSameSid(parentBefore.sid, helper.sid) &&
                                  helper.image.sha256 == heldImageHash_),
            "run_process_changed");
    const auto hash = runControlVerifyImage(processImage_.value, expected_.image);
    require(hash == heldImageHash_, "run_control_image_changed");
  }
  void runControlAuthenticate(Connection &connection) {
    runControlRevalidateHeld();
    if (packagePeerProcess_) runControlValidatePackagePeer();
    if (!expectedEndpoint_.present)
      prepareExpectedEndpoint();
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
    const auto peerParentPid = runControlParentPid(connection.peerProcess.value);
    require(peerParentPid > 0 && peerParentPid <= MAXDWORD, "run_control_parent_join");
    if (!connection.peerParent) {
      Handle parent(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE,
                                static_cast<DWORD>(peerParentPid)));
      require(static_cast<bool>(parent), "run_control_parent_join");
      connection.peerParent = std::move(parent);
    }
    const ProcessPin peerParentBefore = runControlObserveProcess(connection.peerParent.value);
    const ProcessPin peerAfter = runControlObserveProcess(connection.peerProcess.value);
    require(filetime(peerParentBefore.birth) < filetime(peerPin.birth) &&
                runControlSameProcess(peerPin, peerAfter) &&
                runControlSameProcess(peerParentBefore,
                                      runControlObserveProcess(connection.peerParent.value)) &&
                runControlSameSid(peerPin.sid, peerParentBefore.sid),
            "run_control_peer_identity");
    if (!fixedPeer_) {
      require(runControlRequireFreshFullTokens(connection.peerProcess.value,
                                               connection.peerParent.value),
              "run_control_peer_identity");
      const ProcessPin localParent = runControlObserveProcess(intendedBun_.value);
      const ProcessPin expectedHelper =
          connection.side == Role::server ? expectedEndpoint_.helper : expectedEndpoint_.helper;
      const ProcessPin expectedBun =
          connection.side == Role::server ? expectedEndpoint_.bun : expectedEndpoint_.bun;
      require(expectedEndpoint_.present &&
                  runControlSameFile(peerPin.image, expectedHelper.image) &&
                  runControlSameFile(peerParentBefore.image, expectedBun.image) &&
                  runControlSameSid(peerPin.sid, expectedHelper.sid) &&
                  runControlSameSid(peerParentBefore.sid, expectedBun.sid) &&
                  runControlSameFile(localPin.image, expected_.image) &&
                  runControlSameFile(localParent.image, expected_.parent.image) &&
                  runControlSameSid(localPin.sid, localParent.sid),
              "run_control_peer_identity");
      if (connection.side == Role::client) {
        require(runControlSameProcess(peerPin, expectedHelper) &&
                    runControlSameProcess(peerParentBefore, expectedBun),
                "run_control_endpoint_changed");
      } else {
        // Fresh CLI parents deliberately have different PIDs and births. Only
        // their measured image/user pair joins the selected server policy.
        require(peerParentPid != expectedBun.pid &&
                    peerPin.image.sha256 == expectedHelper.image.sha256 &&
                    peerParentBefore.image.sha256 == expectedBun.image.sha256,
                "run_control_peer_identity");
      }
    }
    const ProcessPin expectedPeer =
        connection.side == Role::server ? expected_.client : expected_.server;
    const ProcessPin expectedLocal =
        connection.side == Role::server ? expected_.server : expected_.client;
    require((fixedPeer_ ? runControlSameProcess(peerPin, expectedPeer) &&
                              runControlSameFile(peerPin.image, expectedPeer.image)
                        : runControlSameFile(peerPin.image, expectedEndpoint_.helper.image)) &&
                runControlSameProcess(localPin, expectedLocal) &&
                runControlSameFile(localPin.image, expectedLocal.image) &&
                !runControlSameProcess(peerPin, localPin) &&
                (!connection.authenticated ||
                 (runControlSameProcess(peerPin, connection.peer) &&
                  runControlSameProcess(peerParentBefore, connection.peerParentPin) &&
                  runControlSameProcess(localPin, connection.local))),
            "run_control_peer_identity");
    connection.peer = peerPin;
    connection.peerParentPin = peerParentBefore;
    connection.local = localPin;
    connection.authenticated = true;
    connection.sealedPeer = true;
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
  static IoResult runControlCancelAndDrain(IoOperation &operation,
                                           std::uint64_t cleanupDeadline = 0) {
    CancelIoEx(operation.issuingHandle.value, &operation.overlap);
    const std::uint64_t deadline = cleanupDeadline == 0
        ? GetTickCount64() + CANCEL_DRAIN_MS
        : std::min<std::uint64_t>(GetTickCount64() + CANCEL_DRAIN_MS, cleanupDeadline);
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
  std::shared_ptr<IoOperation> runControlRetain(std::shared_ptr<IoOperation> operation) {
    std::lock_guard<std::recursive_mutex> lock(controlMutex_);
    for (auto &slot : retainedIo_) {
      if (!slot) {
        slot = std::move(operation);
        return slot;
      }
    }
    require(false, "cleanup_unknown");
    return nullptr;
  }
  void runControlForget(const std::shared_ptr<IoOperation> &operation) {
    std::lock_guard<std::recursive_mutex> lock(controlMutex_);
    // An unresolved kernel operation keeps every publication and ownership
    // edge until GetOverlappedResult proves completion. Completed operations
    // are removed and their duplicated issuing HANDLE may then be released.
    if (operation->unresolved)
      return;
    if (listener_ && listener_->acceptOperation == operation)
      listener_->acceptOperation = nullptr;
    for (auto &entry : registry_) {
      auto &pending = entry.second->pending;
      pending.erase(std::remove(pending.begin(), pending.end(), operation), pending.end());
    }
    for (auto &slot : retainedIo_)
      if (slot == operation)
        slot.reset();
  }
  void runControlAbandonPending() {
    std::lock_guard<std::recursive_mutex> lock(controlMutex_);
    // OVERLAPPED, event and issuing HANDLE storage must outlive this object if
    // the kernel has not reported completion. The fixed owner is bounded by one
    // operation per capability plus one accept operation.
    auto &abandoned = runControlAbandonedOperations();
    for (auto &slot : retainedIo_) {
      if (slot)
        abandoned.push_back(std::move(slot));
    }
  }
  static std::vector<std::shared_ptr<IoOperation>> &runControlAbandonedOperations() {
    static std::vector<std::shared_ptr<IoOperation>> abandoned;
    return abandoned;
  }
  std::string runControlReadFrame(Connection &connection, DWORD timeout,
                                  std::uint64_t cleanupDeadline = 0) {
    const std::uint64_t deadline = GetTickCount64() + timeout;
    for (;;) {
      std::shared_ptr<IoOperation> io;
      DWORD transferred = 0;
      {
        std::lock_guard<std::recursive_mutex> lock(controlMutex_);
        require(connection.frameDecoder.pending.size() <= MAX_FRAME_BYTES,
                "run_control_frame_oversize");
        std::string frame;
        if (connection.frameDecoder.extract(frame))
          return frame;
        auto operation = std::make_shared<IoOperation>();
        operation->kind = IoKind::read;
        operation->bytes.resize(64 * 1024);
        operation->event = Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        require(static_cast<bool>(operation->event), "run_control_read_unknown");
        operation->overlap.hEvent = operation->event.value;
        require(!shutdown_ && !connection.retired && !connection.poisoned,
                "run_control_timeout");
        // Duplicate the pipe only while the state guard owns retirement. The
        // duplicated HANDLE and OVERLAPPED storage outlive every waiter.
        operation->issuingHandle =
            runControlDuplicateHandle(connection.pipe.value, "run_control_read_unknown");
        io = runControlRetain(std::move(operation));
        connection.pending.push_back(io);
        BOOL issued = ReadFile(io->issuingHandle.value, io->bytes.data(),
                               static_cast<DWORD>(io->bytes.size()), nullptr, &io->overlap);
        io->issued = true;
        const DWORD issueError = issued ? ERROR_SUCCESS : GetLastError();
        if (!issued && issueError != ERROR_IO_PENDING) {
          io->complete = true;
          io->error = issueError;
          io->poisoned = connection.poisoned = true;
          runControlForget(io);
          throw NativeError{issueError == ERROR_BROKEN_PIPE ? "run_control_disconnected"
                                                           : "run_control_read_unknown",
                            issueError, "read"};
        }
      }

      const auto waited = runControlWaitOperation(*io, runControlRemaining(deadline));
      if (!waited.completed) {
        const auto cancelled = runControlCancelAndDrain(*io, cleanupDeadline);
        bool unresolved = false;
        {
          std::lock_guard<std::recursive_mutex> lock(controlMutex_);
          if (!io->complete) {
            if (!cancelled.completed) {
              io->unresolved = io->poisoned = connection.poisoned = true;
              runControlForget(io);
              unresolved = true;
            } else {
              io->complete = true;
              io->transferred = cancelled.transferred;
              io->error = cancelled.error;
              connection.poisoned = true;
              connection.frameDecoder.clear();
              runControlForget(io);
            }
          } else {
            io->poisoned = connection.poisoned = true;
            connection.frameDecoder.clear();
            runControlForget(io);
          }
        }
        if (unresolved)
          throw NativeError{"cleanup_unknown", ERROR_OPERATION_ABORTED, "read"};
        if (!runControlRetire(connection, cleanupDeadline))
          throw NativeError{"cleanup_unknown", ERROR_OPERATION_ABORTED, "read"};
        throw NativeError{"run_control_timeout", ERROR_OPERATION_ABORTED, "read"};
      }

      {
        std::lock_guard<std::recursive_mutex> lock(controlMutex_);
        if (io->complete && io->poisoned) {
          runControlForget(io);
          throw NativeError{"run_control_timeout", ERROR_OPERATION_ABORTED, "read"};
        }
        if (!io->complete) {
          io->complete = true;
          io->transferred = waited.transferred;
          io->error = waited.error;
        }
        if (io->poisoned || connection.poisoned || connection.retired) {
          connection.poisoned = true;
          runControlForget(io);
          throw NativeError{"run_control_timeout", ERROR_OPERATION_ABORTED, "read"};
        }
        if (io->error != ERROR_SUCCESS) {
          const char *code = io->error == ERROR_BROKEN_PIPE ? "run_control_disconnected"
                                                           : "run_control_read_unknown";
          connection.poisoned = true;
          runControlForget(io);
          throw NativeError{code, io->error, "read"};
        }
        if (io->transferred > io->bytes.size()) {
          runControlForget(io);
          throw NativeError{"run_control_read_unknown", ERROR_INVALID_DATA, "read"};
        }
        transferred = io->transferred;
        connection.frameDecoder.feed(io->bytes.data(), transferred);
        runControlForget(io);
      }
      if (transferred == 0)
        throw NativeError{"run_control_disconnected", ERROR_BROKEN_PIPE, "read"};
    }
  }

  void runControlWriteFrame(Connection &connection, const std::string &bytes, DWORD timeout,
                            std::uint64_t cleanupDeadline = 0) {
    const std::uint64_t deadline = GetTickCount64() + timeout;
    size_t offset = 0;
    while (offset < bytes.size()) {
      std::shared_ptr<IoOperation> io;
      DWORD transferred = 0;
      {
        std::lock_guard<std::recursive_mutex> lock(controlMutex_);
        auto operation = std::make_shared<IoOperation>();
        operation->kind = IoKind::write;
        operation->bytes.assign(bytes.begin() + static_cast<std::ptrdiff_t>(offset), bytes.end());
        operation->event = Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        require(static_cast<bool>(operation->event), "run_control_write_unknown");
        operation->overlap.hEvent = operation->event.value;
        require(!shutdown_ && !connection.retired && !connection.poisoned,
                "run_control_timeout");
        operation->issuingHandle =
            runControlDuplicateHandle(connection.pipe.value, "run_control_write_unknown");
        io = runControlRetain(std::move(operation));
        connection.pending.push_back(io);
        BOOL issued = WriteFile(io->issuingHandle.value, io->bytes.data(),
                                static_cast<DWORD>(io->bytes.size()), nullptr, &io->overlap);
        io->issued = true;
        const DWORD issueError = issued ? ERROR_SUCCESS : GetLastError();
        if (!issued && issueError != ERROR_IO_PENDING) {
          io->complete = true;
          io->error = issueError;
          io->poisoned = connection.poisoned = true;
          runControlForget(io);
          throw NativeError{issueError == ERROR_BROKEN_PIPE ? "run_control_disconnected"
                                                           : "run_control_write_unknown",
                            issueError, "write"};
        }
      }

      const auto waited = runControlWaitOperation(*io, runControlRemaining(deadline));
      if (!waited.completed) {
        const auto cancelled = runControlCancelAndDrain(*io, cleanupDeadline);
        bool unresolved = false;
        {
          std::lock_guard<std::recursive_mutex> lock(controlMutex_);
          if (!io->complete) {
            if (!cancelled.completed) {
              io->unresolved = io->poisoned = connection.poisoned = true;
              runControlForget(io);
              unresolved = true;
            } else {
              io->complete = true;
              io->transferred = cancelled.transferred;
              io->error = cancelled.error;
              connection.poisoned = true;
              runControlForget(io);
            }
          } else {
            io->poisoned = connection.poisoned = true;
            runControlForget(io);
          }
        }
        if (unresolved)
          throw NativeError{"cleanup_unknown", ERROR_OPERATION_ABORTED, "write"};
        if (!runControlRetire(connection, cleanupDeadline))
          throw NativeError{"cleanup_unknown", ERROR_OPERATION_ABORTED, "write"};
        throw NativeError{"run_control_timeout", ERROR_OPERATION_ABORTED, "write"};
      }

      {
        std::lock_guard<std::recursive_mutex> lock(controlMutex_);
        if (io->complete && io->poisoned) {
          runControlForget(io);
          throw NativeError{"run_control_timeout", ERROR_OPERATION_ABORTED, "write"};
        }
        if (!io->complete) {
          io->complete = true;
          io->transferred = waited.transferred;
          io->error = waited.error;
        }
        if (io->poisoned || connection.poisoned || connection.retired) {
          connection.poisoned = true;
          runControlForget(io);
          throw NativeError{"run_control_timeout", ERROR_OPERATION_ABORTED, "write"};
        }
        if (io->error != ERROR_SUCCESS) {
          const char *code = io->error == ERROR_BROKEN_PIPE ? "run_control_disconnected"
                                                           : "run_control_write_unknown";
          connection.poisoned = true;
          runControlForget(io);
          throw NativeError{code, io->error, "write"};
        }
        if (io->transferred == 0 || io->transferred > io->bytes.size()) {
          runControlForget(io);
          throw NativeError{"run_control_write_partial", ERROR_WRITE_FAULT, "write"};
        }
        transferred = io->transferred;
        runControlForget(io);
      }
      offset += transferred;
    }
  }

  bool runControlRetire(Connection &connection, std::uint64_t cleanupDeadline = 0) {
    std::vector<std::shared_ptr<IoOperation>> pending;
    {
      std::lock_guard<std::recursive_mutex> lock(controlMutex_);
      if (connection.retired)
        return true;
      connection.poisoned = true;
      connection.frameDecoder.clear();
      pending = connection.pending;
      for (const auto &operation : pending) {
        operation->poisoned = true;
        if (operation->issued && !operation->complete)
          CancelIoEx(operation->issuingHandle.value, &operation->overlap);
      }
    }
    for (const auto &operation : pending) {
      const auto cancelled = runControlCancelAndDrain(*operation, cleanupDeadline);
      std::lock_guard<std::recursive_mutex> lock(controlMutex_);
      if (cancelled.completed) {
        if (!operation->complete) {
          operation->complete = true;
          operation->transferred = cancelled.transferred;
          operation->error = cancelled.error;
        }
        runControlForget(operation);
      } else {
        operation->unresolved = operation->poisoned = connection.poisoned = true;
        runControlForget(operation);
      }
    }
    std::lock_guard<std::recursive_mutex> lock(controlMutex_);
    bool complete = true;
    for (const auto &operation : connection.pending)
      complete = complete && !operation->unresolved;
    if (!complete)
      return false;
    connection.pipe.reset();
    connection.retired = true;
    return true;
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
  ExpectedEndpoint expectedEndpoint_;
  WindowsNativeRunState *runState_ = nullptr;
  bool fixedPeer_ = true;
  std::vector<BYTE> sealedBinding_;
  std::array<BYTE, 32> heldImageHash_{};
  std::wstring ownerSid_;
  std::vector<BYTE> ownerSidBytes_;
  Handle selectedDirectory_, config_, intendedBun_, processImage_, packagePeerProcess_;
  std::vector<BYTE> expectedPackageSid_;
  std::wstring packageSid_;
  std::unique_ptr<Listener> listener_;
  std::map<std::uint64_t, std::shared_ptr<Connection>> registry_;
  std::array<std::shared_ptr<IoOperation>, MAX_RETAINED_OPERATIONS> retainedIo_;
  std::thread requestPump_;
  std::atomic<bool> requestPumpStop_{false};
  mutable std::recursive_mutex controlMutex_;
  std::atomic<bool> shutdown_{false};
  bool shutdownComplete_ = true;
};

inline void WindowsNativeRunControl::startRequestPump() {
  std::lock_guard<std::recursive_mutex> lock(controlMutex_);
  require(listener_ && !requestPump_.joinable(), "run_control_foreign");
  requestPumpStop_ = false;
  requestPump_ = std::thread([this] {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    while (!requestPumpStop_ && !shutdown_) {
      std::uint64_t activeId = 0;
      const char *phase = "accept_wait";
      const auto reportFailure = [&](const char *code, DWORD nativeCode) {
        if (requestPumpStop_ || shutdown_) return;
        try {
          JsonObject failure;
          str(failure, L"phase", wide(phase));
          str(failure, L"code", wide(code));
          num(failure, L"nativeCode", nativeCode);
          event(L"runControlFailure", failure);
        } catch (...) { /* Diagnostics cannot change retirement or authority. */ }
      };
      try {
        JsonObject acceptedInput;
        num(acceptedInput, L"timeoutMs", 1000);
        const auto accepted = accept(acceptedInput, true, &phase);
        const auto number = accepted.GetNamedNumber(L"id");
        const auto id = static_cast<std::uint64_t>(number);
        activeId = id;
        const auto connection = runControlConnectionById(id);
        JsonObject readInput;
        num(readInput, L"id", id);
        num(readInput, L"timeoutMs", 30000);
        phase = "read_frame";
        const std::string frameBytes = runControlReadFrame(*connection, 30000);
        phase = "verify_frame";
        const auto frame = JsonObject::Parse(wide(frameBytes));
        const auto mac = text(frame, L"mac");
        const auto signedBytes = runControlDecodeFrameBase64(text(frame, L"payloadBytesBase64"));
        require(signedBytes.size() <= MAX_FRAME_BYTES, "run_control_frame_oversize");
        const std::string payloadBytes(signedBytes.begin(), signedBytes.end());
        require(mac == runControlHmacHex(runState_->challenge(), payloadBytes),
                "run_control_foreign");
        const auto payload = JsonObject::Parse(wide(payloadBytes));
        phase = "validate_payload";
        validateRequestPayload(id, payload);
        JsonObject envelope;
        str(envelope, L"connection", decimal(id));
        envelope.SetNamedValue(L"payload", payload);
        phase = "publish_request";
        event(L"runControlRequest", envelope);
      } catch (const NativeError &failure) {
        if (std::strcmp(failure.code.c_str(), "run_control_accept_timeout") != 0)
          reportFailure(failure.code.c_str(), failure.win32);
        if (activeId != 0) {
          JsonObject poison;
          num(poison, L"id", activeId);
          try { poisonConnection(poison); } catch (...) {}
        }
        if (requestPumpStop_ || shutdown_)
          break;
        if (std::strcmp(failure.code.c_str(), "run_control_accept_timeout") == 0)
          continue;
        // Only a listener-scoped refusal ends the pump. A connection-scoped
        // failure retires just its own connection while the listener keeps
        // offering a fresh instance to the clients that follow.
        if (std::strcmp(phase, "accept_wait") == 0 ||
            std::strcmp(phase, "accept_replenish") == 0)
          break;
      } catch (...) {
        reportFailure("run_control_pump_unknown", 0);
        if (activeId != 0) {
          JsonObject poison;
          num(poison, L"id", activeId);
          try { poisonConnection(poison); } catch (...) {}
        }
        break;
      }
    }
  });
}

inline void WindowsNativeRunControl::stopRequestPump() {
  std::unique_lock<std::recursive_mutex> lock(controlMutex_);
  requestPumpStop_ = true;
  if (requestPump_.joinable()) {
    auto thread = std::move(requestPump_);
    lock.unlock();
    thread.join();
  }
}
