#include "engine/host_protocol.h"

int main(void) {
  int (*render_region_with_progress)(
      patchy_engine_session *, int32_t, int32_t, int32_t, int32_t,
      patchy_engine_render_progress_fn, void *, patchy_engine_cancellation *,
      patchy_engine_buffer *,
      patchy_engine_event *, patchy_engine_error *) =
      patchy_engine_session_render_region_with_progress;
  int (*save_psd_as_with_progress)(
      patchy_engine_session *, uint8_t, patchy_engine_save_progress_fn,
      void *, patchy_engine_cancellation *, patchy_engine_buffer *,
      patchy_engine_event *, patchy_engine_error *) =
      patchy_engine_session_save_psd_as_with_progress;
  enum patchy_engine_capability tagged =
      (enum patchy_engine_capability)PATCHY_ENGINE_CAP_LAYER_PROJECTION;
  const patchy_engine_capability high =
      PATCHY_ENGINE_CAP_SELECTION_REFINEMENT;
  return render_region_with_progress != 0 && save_psd_as_with_progress != 0 &&
                 (uint64_t)tagged == PATCHY_ENGINE_CAP_LAYER_PROJECTION &&
                 high == PATCHY_ENGINE_CAP_SELECTION_REFINEMENT
             ? 0
             : 1;
}
