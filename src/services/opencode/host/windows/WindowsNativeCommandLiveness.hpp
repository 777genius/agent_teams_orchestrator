#pragma once
#include <cstdint>
#include <string>

// Included only by WindowsKernelScope.cpp, after its require() helper. This
// policy owns no HANDLE and performs no check itself; Scope supplies both.
//
// A complete reconciliation re-proves every realpath anchor chain, shared read
// root, project and ancestor ACL and the held DLL. With one root per graph
// package it costs seconds, while command stdio data operations only move bytes
// through HANDLEs this scope already holds. Those operations may reuse the
// latest successful complete proof for one fixed monotonic interval, and only
// after the constant-time scope/process checks pass. Start, retire and close
// always reconcile. A refused cheap check falls through to the complete
// reconciliation, and any failure discards the proof: amortized, never skipped.
enum class CommandLivenessKind { complete, data };
static CommandLivenessKind commandLivenessKind(const std::wstring &operation) {
  if (operation == L"commandRead" || operation == L"commandWriteStdin" ||
      operation == L"commandEndStdin" || operation == L"commandStatus")
    return CommandLivenessKind::data;
  require(operation == L"commandStart" || operation == L"commandRetire" ||
              operation == L"commandClose",
          "execution_invalid_response");
  return CommandLivenessKind::complete;
}
class CommandLivenessGate {
  bool proven = false;
  std::uint64_t provenAt = 0;

public:
  static constexpr std::uint64_t reuseMs = 5000;
  // now() returns monotonic milliseconds. The proof is valid for reuseMs after
  // the complete reconciliation finished; a clock step back never extends it.
  template <class Now, class Cheap, class Complete>
  void admit(CommandLivenessKind kind, Now now, Cheap cheap, Complete complete) {
    if (kind == CommandLivenessKind::data && proven) {
      const std::uint64_t at = now();
      if (at >= provenAt && at - provenAt < reuseMs && cheap()) return;
    }
    proven = false;
    complete();
    provenAt = now();
    proven = true;
  }
};
