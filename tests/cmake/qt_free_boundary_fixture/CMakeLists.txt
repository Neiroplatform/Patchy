cmake_minimum_required(VERSION 3.21)
project(patchy_qt_free_boundary_fixture LANGUAGES CXX)

include("${PATCHY_SOURCE_DIR}/cmake/assert_qt_free_dependency_tree.cmake")

add_library(Qt6::Core INTERFACE IMPORTED)
add_library(boundary_leaf INTERFACE)
target_link_libraries(boundary_leaf INTERFACE Qt6::Core)
add_library(boundary_root INTERFACE)
target_link_libraries(boundary_root INTERFACE boundary_leaf)

patchy_assert_qt_free_dependency_tree(boundary_root)
