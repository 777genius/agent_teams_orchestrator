#include "WindowsNativeRealpath.hpp"

using opencode_v2::windows_realpath::AnchorV1;
using opencode_v2::windows_realpath::ErrorV1;

// Child-local ABI exports. Authority and physical identity checks remain in the native resolver.
extern "C" __declspec(dllexport) int32_t RP_OpenV1(
    uint32_t pid, uint64_t creation, const AnchorV1* anchors, uint32_t count,
    uint64_t* context, ErrorV1* error) noexcept {
  return opencode_v2::windows_realpath::OpenV1(pid, creation, anchors, count,
                                             context, error);
}

extern "C" __declspec(dllexport) int32_t RP_ResolveV1(
    uint64_t context, const wchar_t* input, uint32_t inputChars,
    wchar_t* output, uint32_t capacity, uint32_t* outputChars,
    ErrorV1* error) noexcept {
  return opencode_v2::windows_realpath::ResolveV1(
      context, input, inputChars, output, capacity, outputChars, error);
}

extern "C" __declspec(dllexport) int32_t RP_CloseV1(
    uint64_t context, ErrorV1* error) noexcept {
  return opencode_v2::windows_realpath::CloseV1(context, error);
}
