file(REMOVE_RECURSE "${PATCHY_TEST_BINARY_DIR}")
execute_process(
  COMMAND "${CMAKE_COMMAND}"
          -S "${PATCHY_SOURCE_DIR}/tests/cmake/qt_free_boundary_fixture"
          -B "${PATCHY_TEST_BINARY_DIR}"
          -DPATCHY_SOURCE_DIR=${PATCHY_SOURCE_DIR}
  RESULT_VARIABLE configure_result
  OUTPUT_VARIABLE configure_stdout
  ERROR_VARIABLE configure_stderr
)
set(configure_output "${configure_stdout}\n${configure_stderr}")
if(configure_result EQUAL 0)
  message(FATAL_ERROR "Qt-free boundary fixture unexpectedly configured")
endif()
if(NOT configure_output MATCHES "Qt-free engine boundary violated")
  message(FATAL_ERROR
    "Qt-free boundary fixture failed for the wrong reason:\n${configure_output}")
endif()
