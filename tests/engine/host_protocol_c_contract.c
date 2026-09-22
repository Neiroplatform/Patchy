#include "engine/host_protocol.h"

_Static_assert(PATCHY_ENGINE_CAP_LAYER_PROJECTION == (UINT64_C(1) << 0),
               "low capability bit changed");
_Static_assert(PATCHY_ENGINE_CAP_SELECTION_REFINEMENT == (UINT64_C(1) << 40),
               "high capability bit changed");

int main(void) {
  enum patchy_engine_capability tagged =
      (enum patchy_engine_capability)PATCHY_ENGINE_CAP_LAYER_PROJECTION;
  const patchy_engine_capability high =
      PATCHY_ENGINE_CAP_SELECTION_REFINEMENT;
  return (uint64_t)tagged == PATCHY_ENGINE_CAP_LAYER_PROJECTION &&
                 high == PATCHY_ENGINE_CAP_SELECTION_REFINEMENT
             ? 0
             : 1;
}
