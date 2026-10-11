#pragma once
#include <chrono>

// Included only by WindowsKernelScope.cpp, after its native HANDLE, identity,
// attribute-list and JSON helpers. These objects never serialize HANDLE values.
struct NativeCommand {
  Handle job, process, input, inputWriter, output, error, outputReader, errorReader;
  DWORD pid = 0;
  ULONGLONG inputOffset = 0;
  bool pipedInput = false, inputClosed = false;
  std::atomic<bool> finished{false}, oversized{false};
  std::thread monitor;
  ~NativeCommand() {
    finished = true;
    if (job)
      TerminateJobObject(job.value, 99);
    if (process)
      WaitForSingleObject(process.value, INFINITE);
    if (monitor.joinable())
      monitor.join();
  }
  DWORD active() const {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
    require(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &info,
                                      sizeof(info), nullptr) != 0,
            "cleanup_unknown");
    return info.ActiveProcesses;
  }
  bool exited() const { return WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0; }
  static ULONGLONG size(HANDLE file) {
    LARGE_INTEGER length{};
    require(GetFileSizeEx(file, &length) && length.QuadPart >= 0,
            "execution_native_command_unknown");
    return static_cast<ULONGLONG>(length.QuadPart);
  }
  void startMonitor() {
    monitor = std::thread([this] {
      while (!finished) {
        try {
          // Both streams are checked even when the official consumer only
          // subscribes to one. A breached bound retires this command Job.
          if (size(outputReader.value) + size(errorReader.value) > 8 * 1024 * 1024) {
            oversized = true;
            TerminateJobObject(job.value, 99);
            return;
          }
        } catch (...) {
          TerminateJobObject(job.value, 99);
          return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }
    });
  }
  JsonObject status() {
    JsonObject result;
    flag(result, L"running", !exited());
    if (!exited())
      result.SetNamedValue(L"exitCode", JsonValue::CreateNullValue());
    else {
      DWORD code = 0;
      require(GetExitCodeProcess(process.value, &code) != 0, "execution_native_command_unknown");
      num(result, L"exitCode", code);
    }
    flag(result, L"outputLimitExceeded", oversized);
    return result;
  }
  JsonObject retire() {
    inputWriter.reset();
    inputClosed = true;
    require(TerminateJobObject(job.value, 99) != 0, "cleanup_unknown");
    ULONGLONG deadline = GetTickCount64() + 12000;
    while ((!exited() || active() != 0) && GetTickCount64() < deadline)
      Sleep(10);
    require(exited() && active() == 0, "cleanup_unknown");
    finished = true;
    if (monitor.joinable())
      monitor.join();
    // Preserve read handles until commandClose for the official final capture.
    input.reset();
    output.reset();
    error.reset();
    JsonObject result;
    flag(result, L"empty", true);
    num(result, L"activeProcesses", 0);
    flag(result, L"heldProcessExited", true);
    return result;
  }
  JsonObject writeInput(const JsonObject &value) {
    double offset = value.GetNamedNumber(L"offset");
    require(pipedInput && !inputClosed && inputWriter && !exited() && offset >= 0 &&
                offset == inputOffset && offset == static_cast<ULONGLONG>(offset),
            "execution_native_command_stdin_unknown");
    auto bytes = unbase64(text(value, L"bytesBase64"));
    require(!bytes.empty() && bytes.size() <= 8192 &&
                base64(bytes) == narrow(text(value, L"bytesBase64")) &&
                inputOffset + bytes.size() <= 64 * 1024 * 1024,
            "execution_native_command_stdin_unknown");
    Handle ready(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    require(static_cast<bool>(ready), "execution_native_command_stdin_unknown");
    OVERLAPPED overlap{};
    overlap.hEvent = ready.value;
    BOOL issued = WriteFile(inputWriter.value, bytes.data(), static_cast<DWORD>(bytes.size()),
                            nullptr, &overlap);
    if (!issued) {
      DWORD issueError = GetLastError();
      if (issueError != ERROR_IO_PENDING)
        throw NativeError{"execution_native_command_stdin_unknown", issueError,
                          "command_stdin_write"};
      HANDLE events[] = {ready.value, process.value};
      DWORD waited = WaitForMultipleObjects(2, events, FALSE, 10000);
      if (waited != WAIT_OBJECT_0) {
        // Unknown writes are never replayed. Complete the cancelled operation
        // before releasing its exact buffer/OVERLAPPED and retire this Job.
        CancelIoEx(inputWriter.value, &overlap);
        DWORD ignored = 0;
        GetOverlappedResult(inputWriter.value, &overlap, &ignored, TRUE);
        TerminateJobObject(job.value, 99);
        inputWriter.reset();
        inputClosed = true;
        throw NativeError{"execution_native_command_stdin_unknown", ERROR_OPERATION_ABORTED,
                          "command_stdin_wait"};
      }
    }
    DWORD written = 0;
    if (!GetOverlappedResult(inputWriter.value, &overlap, &written, FALSE)) {
      DWORD errorCode = GetLastError();
      TerminateJobObject(job.value, 99);
      inputWriter.reset();
      inputClosed = true;
      throw NativeError{"execution_native_command_stdin_unknown", errorCode,
                        "command_stdin_complete"};
    }
    require(written > 0 && written <= bytes.size(), "execution_native_command_stdin_unknown");
    inputOffset += written;
    JsonObject result;
    num(result, L"writtenBytes", written);
    num(result, L"nextOffset", inputOffset);
    return result;
  }
  JsonObject endInput(const JsonObject &value) {
    double offset = value.GetNamedNumber(L"offset");
    require(pipedInput && !inputClosed && offset >= 0 && offset == inputOffset &&
                offset == static_cast<ULONGLONG>(offset),
            "execution_native_command_stdin_unknown");
    inputWriter.reset();
    inputClosed = true;
    JsonObject result;
    flag(result, L"closed", true);
    num(result, L"nextOffset", inputOffset);
    return result;
  }
  JsonObject read(const JsonObject &inputValue) {
    auto stream = text(inputValue, L"stream");
    require(stream == L"stdout" || stream == L"stderr", "execution_native_command_unknown");
    auto file = stream == L"stdout" ? outputReader.value : errorReader.value;
    double rawOffset = inputValue.GetNamedNumber(L"offset"),
           rawMax = inputValue.GetNamedNumber(L"maxBytes");
    require(rawOffset >= 0 && rawOffset <= 8 * 1024 * 1024 &&
                rawOffset == static_cast<ULONGLONG>(rawOffset) && rawMax > 0 && rawMax <= 8192 &&
                rawMax == static_cast<DWORD>(rawMax),
            "execution_native_command_unknown");
    auto length = size(file), offset = static_cast<ULONGLONG>(rawOffset);
    require(length <= 8 * 1024 * 1024 && offset <= length && !oversized,
            "execution_native_command_output_limit");
    DWORD count =
        static_cast<DWORD>(std::min<ULONGLONG>(static_cast<DWORD>(rawMax), length - offset));
    LARGE_INTEGER position{};
    position.QuadPart = offset;
    require(SetFilePointerEx(file, position, nullptr, FILE_BEGIN) != 0,
            "execution_native_command_unknown");
    std::vector<BYTE> bytes(count);
    DWORD obtained = 0;
    require(ReadFile(file, bytes.data(), count, &obtained, nullptr) && obtained == count,
            "execution_native_command_unknown");
    JsonObject result;
    str(result, L"bytesBase64", wide(base64(bytes)));
    num(result, L"nextOffset", offset + obtained);
    // Descendants retaining output must finish before EOF becomes authoritative.
    flag(result, L"eof", exited() && active() == 0 && offset + obtained == size(file));
    return result;
  }
};
struct NativeCommandStore {
  HANDLE outer;
  PSID package, network;
  std::wstring directory, owner;
  JsonObject baseEnvironment;
  std::map<std::wstring, std::unique_ptr<NativeCommand>> commands;
  NativeCommandStore(HANDLE outerJob, PSID packageSid, PSID networkSid, std::wstring spool,
                     std::wstring ownerSid, JsonObject environment)
      : outer(outerJob), package(packageSid), network(networkSid), directory(std::move(spool)),
        owner(std::move(ownerSid)), baseEnvironment(JsonObject::Parse(environment.Stringify())) {}
  struct EnvironmentLess {
    bool operator()(const std::wstring &left, const std::wstring &right) const {
      return CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(),
                                  static_cast<int>(right.size()), TRUE) == CSTR_LESS_THAN;
    }
  };
  static std::wstring upperKey(std::wstring key) {
    for (auto &letter : key)
      if (letter >= L'a' && letter <= L'z')
        letter -= L'a' - L'A';
    return key;
  }
  static bool uuid(const std::wstring &value) {
    if (value.size() != 36)
      return false;
    for (size_t i = 0; i < value.size(); i++) {
      if (i == 8 || i == 13 || i == 18 || i == 23) {
        if (value[i] != L'-')
          return false;
      } else if (!((value[i] >= L'0' && value[i] <= L'9') ||
                   (value[i] >= L'a' && value[i] <= L'f')))
        return false;
    }
    return true;
  }
  Handle createFile(const std::wstring &name, DWORD access) {
    LocalMemory descriptor;
    auto sddl = L"O:" + owner + L"D:P(A;;FA;;;SY)(A;;FA;;;" + owner + L")";
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                                 &descriptor.value, nullptr) != 0,
            "execution_native_command_unknown");
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor.value, TRUE};
    Handle file(CreateFileW(extended(directory + L"\\" + name).c_str(),
                            access | READ_CONTROL | FILE_READ_ATTRIBUTES,
                            FILE_SHARE_READ | FILE_SHARE_WRITE, &security, CREATE_NEW,
                            FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(static_cast<bool>(file), "execution_native_command_unknown");
    fileIdentity(file.value, owner, false);
    return file;
  }
  Handle reader(const std::wstring &name) {
    Handle file(CreateFileW(extended(directory + L"\\" + name).c_str(), GENERIC_READ | READ_CONTROL,
                            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                            FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(static_cast<bool>(file), "execution_native_command_unknown");
    fileIdentity(file.value, owner, false);
    return file;
  }
  void createInputPipe(NativeCommand &command, const std::wstring &id) {
    LocalMemory descriptor;
    auto sddl = L"O:" + owner + L"D:P(A;;FA;;;SY)(A;;FA;;;" + owner + L")";
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                                 &descriptor.value, nullptr) != 0,
            "execution_native_command_stdin_unknown");
    // Only the trusted broker opens this pipe. The child receives the precise
    // read capability through HANDLE_LIST; it cannot reopen the host endpoint.
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor.value, FALSE};
    auto name = L"\\\\.\\pipe\\agt-v2-stdin-" + id;
    command.inputWriter = Handle(CreateNamedPipeW(
        name.c_str(), PIPE_ACCESS_OUTBOUND | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536,
        65536, 0, &security));
    require(static_cast<bool>(command.inputWriter), "execution_native_command_stdin_unknown");
    SECURITY_ATTRIBUTES inherited{sizeof(inherited), descriptor.value, TRUE};
    command.input = Handle(CreateFileW(name.c_str(), GENERIC_READ, 0, &inherited, OPEN_EXISTING,
                                       FILE_ATTRIBUTE_NORMAL, nullptr));
    require(static_cast<bool>(command.input), "execution_native_command_stdin_unknown");
    Handle ready(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    require(static_cast<bool>(ready), "execution_native_command_stdin_unknown");
    OVERLAPPED overlap{};
    overlap.hEvent = ready.value;
    BOOL connected = ConnectNamedPipe(command.inputWriter.value, &overlap);
    DWORD connectedError = connected ? ERROR_SUCCESS : GetLastError();
    // Our local CreateFile above establishes the connection synchronously.
    // A different/pending peer is not an acceptable stdin capability.
    if (!connected && connectedError == ERROR_IO_PENDING) {
      CancelIoEx(command.inputWriter.value, &overlap);
      DWORD ignored = 0;
      GetOverlappedResult(command.inputWriter.value, &overlap, &ignored, TRUE);
    }
    require(connected || connectedError == ERROR_PIPE_CONNECTED,
            "execution_native_command_stdin_unknown");
    ULONG clientPID = 0;
    require(GetNamedPipeClientProcessId(command.inputWriter.value, &clientPID) &&
                clientPID == GetCurrentProcessId(),
            "execution_native_command_stdin_unknown");
    command.pipedInput = true;
  }
  JsonObject start(const JsonObject &value) {
    auto id = text(value, L"commandId"), executable = text(value, L"executable"),
         cwd = text(value, L"cwd");
    auto inputMode = text(value, L"stdin");
    require(uuid(id) && commands.size() < 64 && !commands.count(id) &&
                (inputMode == L"ignore" || inputMode == L"pipe"),
            "execution_native_command_unknown");
    auto environment = JsonObject::Parse(baseEnvironment.Stringify());
    std::map<std::wstring, bool, EnvironmentLess> explicitKeys;
    for (auto entry : object(value, L"env")) {
      std::wstring key(entry.Key());
      auto folded = upperKey(key);
      require(!key.empty() && key.find(L'=') == std::wstring::npos &&
                  key.find(L'\0') == std::wstring::npos &&
                  entry.Value().ValueType() == JsonValueType::String &&
                  folded.rfind(L"OPENCODE_V2_", 0) != 0 && folded.rfind(L"NODE_CHANNEL_", 0) != 0,
              "execution_native_command_unknown");
      auto contents = std::wstring(entry.Value().GetString());
      require(contents.find(L'\0') == std::wstring::npos, "execution_native_command_unknown");
      require(explicitKeys.emplace(key, true).second, "execution_native_command_environment_alias");
      std::vector<std::wstring> replaced;
      for (auto previous : environment) {
        std::wstring previousKey(previous.Key());
        if (CompareStringOrdinal(key.data(), static_cast<int>(key.size()), previousKey.data(),
                                 static_cast<int>(previousKey.size()), TRUE) == CSTR_EQUAL)
          replaced.push_back(previousKey);
      }
      for (const auto &previous : replaced)
        environment.Remove(previous);
      str(environment, key.c_str(), contents);
    }
    require(!executable.empty() && executable.find(L'\0') == std::wstring::npos,
            "execution_native_command_unknown");
    // Bare shell names resolve only against the selected child's explicit PATH
    // plus System32; never the trusted broker's ambient cwd/PATH.
    if (executable.find(L'\\') == std::wstring::npos &&
        executable.find(L'/') == std::wstring::npos) {
      auto search = text(baseEnvironment, L"SystemRoot") + L"\\System32";
      if (environment.HasKey(L"PATH"))
        search += L";" + text(environment, L"PATH");
      std::vector<wchar_t> resolved(32768);
      DWORD size = SearchPathW(search.c_str(), executable.c_str(), L".exe",
                               static_cast<DWORD>(resolved.size()), resolved.data(), nullptr);
      require(size > 0 && size < resolved.size(), "execution_native_command_unknown");
      executable.assign(resolved.data(), size);
    }
    require(executable.size() >= 3 && executable[1] == L':', "execution_native_command_unknown");
    auto parents = ancestors(cwd);
    auto cwdHandle = canonicalDirectory(cwd);
    auto arguments = value.GetNamedArray(L"args");
    require(arguments.Size() <= 1024, "execution_native_command_unknown");
    std::vector<std::wstring> args;
    for (auto argument : arguments) {
      require(argument.ValueType() == JsonValueType::String, "execution_native_command_unknown");
      std::wstring item(argument.GetString());
      require(item.find(L'\0') == std::wstring::npos, "execution_native_command_unknown");
      args.push_back(item);
    }
    std::wstring line = quote(executable);
    auto name = executable.substr(executable.find_last_of(L"\\/") + 1);
    if (equalPath(name, L"cmd.exe") && args.size() == 4 && args[0] == L"/d" && args[1] == L"/s" &&
        args[2] == L"/c")
      line += L" /d /s /c \"" + args[3] + L"\"";
    else
      for (const auto &arg : args)
        line += L" " + quote(arg);
    require(line.size() < 32767, "execution_native_command_unknown");
    std::map<std::wstring, std::wstring, EnvironmentLess> pairs;
    for (auto entry : environment) {
      std::wstring key(entry.Key());
      auto folded = upperKey(key);
      if (folded.rfind(L"OPENCODE_V2_", 0) == 0 || folded.rfind(L"NODE_CHANNEL_", 0) == 0)
        continue;
      require(pairs.emplace(key, std::wstring(entry.Value().GetString())).second,
              "execution_native_command_environment_alias");
    }
    std::wstring block;
    for (const auto &entry : pairs)
      block += entry.first + L"=" + entry.second + L'\0';
    block += L'\0';
    require(block.size() < 32767, "execution_native_command_unknown");
    auto command = std::make_unique<NativeCommand>();
    if (inputMode == L"pipe")
      createInputPipe(*command, id);
    else
      command->input = createFile(id + L".stdin", GENERIC_READ);
    command->output = createFile(id + L".stdout", GENERIC_WRITE);
    command->error = createFile(id + L".stderr", GENERIC_WRITE);
    command->outputReader = reader(id + L".stdout");
    command->errorReader = reader(id + L".stderr");
    command->job = Handle(CreateJobObjectW(nullptr, nullptr));
    require(static_cast<bool>(command->job), "execution_native_command_unknown");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(command->job.value, JobObjectExtendedLimitInformation, &limits,
                                    sizeof(limits)) != 0,
            "execution_native_command_unknown");
    SID_AND_ATTRIBUTES capability{network, SE_GROUP_ENABLED};
    SECURITY_CAPABILITIES security{package, &capability, 1, 0};
    HANDLE jobs[] = {outer, command->job.value},
           stdio[] = {command->input.value, command->output.value, command->error.value};
    AttributeList attributes(3);
    attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, sizeof(jobs));
    attributes.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &security, sizeof(security));
    attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, stdio, sizeof(stdio));
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = attributes.get();
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdio[0];
    startup.StartupInfo.hStdOutput = stdio[1];
    startup.StartupInfo.hStdError = stdio[2];
    PROCESS_INFORMATION child{};
    require(CreateProcessW(executable.c_str(), line.data(), nullptr, nullptr, TRUE,
                           EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
                               CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                           block.data(), cwd.c_str(), &startup.StartupInfo, &child) != 0,
            "execution_native_command_unknown");
    command->process = Handle(child.hProcess);
    command->pid = child.dwProcessId;
    Handle thread(child.hThread);
    BOOL inOuter = FALSE, inCommand = FALSE;
    require(IsProcessInJob(command->process.value, outer, &inOuter) && inOuter &&
                IsProcessInJob(command->process.value, command->job.value, &inCommand) &&
                inCommand && command->active() == 1,
            "execution_identity_mismatch");
    auto created = birth(command->process.value);
    require(ResumeThread(thread.value) == 1, "execution_native_command_unknown");
    if (command->pipedInput)
      command->input.reset();
    command->startMonitor();
    JsonObject result;
    str(result, L"commandId", id);
    num(result, L"pid", command->pid);
    str(result, L"birthFiletime", text(created, L"value"));
    commands.emplace(id, std::move(command));
    return result;
  }
  JsonObject request(const std::wstring &operation, const JsonObject &value) {
    if (operation == L"commandStart")
      return start(value);
    auto id = text(value, L"commandId");
    auto found = commands.find(id);
    require(found != commands.end(), "execution_native_command_unknown");
    auto &command = *found->second;
    if (operation == L"commandRead")
      return command.read(value);
    if (operation == L"commandWriteStdin")
      return command.writeInput(value);
    if (operation == L"commandEndStdin")
      return command.endInput(value);
    if (operation == L"commandStatus")
      return command.status();
    if (operation == L"commandRetire")
      return command.retire();
    require(operation == L"commandClose" && command.exited() && command.active() == 0,
            "cleanup_unknown");
    commands.erase(found);
    JsonObject result;
    flag(result, L"closed", true);
    return result;
  }
  void retireAll() {
    for (auto &entry : commands)
      entry.second->retire();
    commands.clear();
  }
};
