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
// after the constant-time scope/process checks pass. Start always reconciles,
// because it admits new work. A refused cheap check falls through to the
// complete reconciliation, and any failure discards the proof: amortized, never
// skipped.
//
// Retire and close only terminate and release a command this scope already
// holds. Reconciling every anchor first cannot protect that teardown; it can
// only delay or refuse it, while the child's bounded Scope close waits for it.
// Teardown therefore requires the same constant-time scope/process checks,
// neither creates nor extends a proof, and a refusal discards the proof.
enum class CommandLivenessKind { complete, data, teardown };
static CommandLivenessKind commandLivenessKind(const std::wstring &operation) {
  if (operation == L"commandRead" || operation == L"commandWriteStdin" ||
      operation == L"commandEndStdin" || operation == L"commandStatus")
    return CommandLivenessKind::data;
  if (operation == L"commandRetire" || operation == L"commandClose")
    return CommandLivenessKind::teardown;
  require(operation == L"commandStart", "execution_invalid_response");
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
    if (kind == CommandLivenessKind::teardown) {
      const bool live = cheap();
      if (!live) proven = false;
      require(live, "execution_identity_mismatch");
      return;
    }
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
