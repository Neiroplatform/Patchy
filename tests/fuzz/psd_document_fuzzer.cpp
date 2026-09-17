#include "psd/psd_document_io.hpp"

#include <cstddef>
#include <cstdint>
#include <span>
#include <stdexcept>

namespace {

patchy::psd::ReadOptions bounded_read_options() {
  constexpr std::uint64_t kMebibyte = 1024U * 1024U;

  patchy::psd::ReadOptions options;
  options.preserve_unknown_blocks = true;
  options.prefer_flat_composite = false;
  options.retain_flat_composite = true;
  options.budget.max_input_bytes = 4U * kMebibyte;
  options.budget.max_primary_pixel_bytes = 64U * kMebibyte;
  options.budget.max_decompressed_bytes = 64U * kMebibyte;
  options.budget.max_tracked_live_bytes = 64U * kMebibyte;
  options.budget.max_layer_records = 4096U;
  options.budget.max_channel_records = 32768U;
  options.budget.max_resource_records = 16384U;
  options.budget.max_descriptor_nodes = 65536U;
  options.budget.max_pattern_records = 4096U;
  options.budget.max_retained_payload_bytes = 32U * kMebibyte;
  return options;
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
  try {
    (void)patchy::psd::DocumentIo::read(
        std::span<const std::uint8_t>(data, size), bounded_read_options());
  } catch (const patchy::psd::ParseBudgetExceeded&) {
    // A finite parser budget rejecting an otherwise valid input is expected.
  } catch (const std::runtime_error&) {
    // Malformed and unsupported PSD/PSB structures use runtime_error.
  }
  return 0;
}
