#include "worker/native_job.hpp"

#include <iostream>

int main(int argc, char** argv) {
  if (argc > 1 && std::string_view(argv[1]) == "--worker") {
    return patchy::worker::native_job_worker_main(argc, argv);
  }
  std::cerr << "patchy-native-job is invoked through the native worker supervisor\n";
  return 64;
}
