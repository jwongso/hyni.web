cmake_minimum_required(VERSION 3.20)
project(hyni_web CXX)

# ---------------------------------------------------------------------------
# Language: C++23.
# Most modern compilers (gcc 13+, clang 17+) support enough of C++23 for the
# subset we use (std::expected-style errors, move-only function captures,
# std::format, ranges::to). We do not enable extensions.
# ---------------------------------------------------------------------------
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ccache transparently caches object files between rebuilds.
find_program(CCACHE ccache)
if(CCACHE)
    set(CMAKE_CXX_COMPILER_LAUNCHER ${CCACHE})
endif()

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# ---------------------------------------------------------------------------
# Release build: production-grade codegen.
#
#   -O3        full optimisation
#   -pipe      pass intermediates between cc1/as through pipes rather than
#              temp files (faster on machines with healthy I/O bandwidth)
#   -flto      link-time optimisation across translation units (cross-TU
#              inlining + dead-code stripping)
#   -fno-plt   eliminate PLT indirection for shared-lib calls (requires
#              -Wl,-z,now to bind at startup instead of lazily)
#   -march=znver5
#              target Zen 5 (Ryzen AI 9 HX 370 / Ryzen 9000 series). Enables
#              AVX-512 + VNNI + BF16. simdjson auto-picks its best kernel
#              based on detected ISA, so znver5 yields its haswell+ paths
#              plus aggressive Zen 5 scheduling.
#
# These are gated by HYNI_NATIVE_OPTS so the same source tree still builds
# on generic x86-64 hosts (CI, older CPUs) with `cmake -DHYNI_NATIVE_OPTS=OFF`.
# ---------------------------------------------------------------------------
add_compile_options($<$<CONFIG:Release>:-O3>)
add_compile_options($<$<CONFIG:Release>:-pipe>)

option(HYNI_NATIVE_OPTS "Apply -march=znver5 + LTO in Release builds" ON)
if(HYNI_NATIVE_OPTS)
    add_compile_options($<$<CONFIG:Release>:-flto>)
    add_compile_options($<$<CONFIG:Release>:-march=znver5>)
    add_compile_options($<$<CONFIG:Release>:-fno-plt>)
    add_link_options(   $<$<CONFIG:Release>:-flto>)
    add_link_options(   $<$<CONFIG:Release>:-Wl,-z,now,-z,relro>)
endif()

# ---------------------------------------------------------------------------
# Debug build: sanitisers on by default. Applied globally because Drogon is
# OK with sanitisers and it catches issues in third-party glue code too.
# ---------------------------------------------------------------------------
add_compile_options($<$<CONFIG:Debug>:-O0>)
add_compile_options($<$<CONFIG:Debug>:-g>)
add_compile_options($<$<CONFIG:Debug>:-fsanitize=address,undefined>)
add_link_options(   $<$<CONFIG:Debug>:-fsanitize=address,undefined>)

# ---------------------------------------------------------------------------
# Warnings — applied via an INTERFACE target so they bind only to *our* code
# (hyni_core + hyni_web_server), not to FetchContent-pulled Drogon/Trantor
# which trigger -Wunused-parameter / -Wdeprecated-declarations on us.
# ---------------------------------------------------------------------------
add_library(hyni_warnings INTERFACE)
target_compile_options(hyni_warnings INTERFACE
    -Wall -Wextra -Wpedantic
    -Wno-missing-field-initializers
)

# ---------------------------------------------------------------------------
# System dependencies.
# ---------------------------------------------------------------------------
find_package(CURL REQUIRED)
find_package(Threads REQUIRED)

find_package(nlohmann_json QUIET)
if(NOT nlohmann_json_FOUND)
    # Header-only; ships at /usr/include on Gentoo / Debian.
    if(NOT EXISTS "/usr/include/nlohmann/json.hpp")
        message(FATAL_ERROR
            "nlohmann/json not found. Install dev-cpp/nlohmann_json or set "
            "CMAKE_PREFIX_PATH to your json install.")
    endif()
    add_library(nlohmann_json::nlohmann_json INTERFACE IMPORTED)
endif()

find_package(simdjson QUIET)
if(NOT simdjson_FOUND)
    # Fallback: system shared lib (Gentoo dev-libs/simdjson, Debian libsimdjson-dev).
    if(NOT EXISTS "/usr/include/simdjson.h")
        message(FATAL_ERROR
            "simdjson not found. Install dev-libs/simdjson or set "
            "CMAKE_PREFIX_PATH to your simdjson install.")
    endif()
    add_library(simdjson::simdjson INTERFACE IMPORTED)
    target_link_libraries(simdjson::simdjson INTERFACE simdjson)
endif()

# ---------------------------------------------------------------------------
# Drogon via CPM (FetchContent under the hood).
# First build pulls + compiles Drogon (~3-5 min). Cached after that.
# Drogon and its TUs inherit the global -O3 / -flto / -march=znver5 from
# add_compile_options above, so the framework is built with the same
# production codegen as our app. -w silences its own warnings.
# ---------------------------------------------------------------------------
include(cmake/CPM.cmake)
CPMAddPackage(
    NAME drogon
    GITHUB_REPOSITORY drogonframework/drogon
    GIT_TAG v1.9.7
    OPTIONS
        "BUILD_EXAMPLES OFF"
        "BUILD_CTL OFF"
        "BUILD_TESTING OFF"
        "BUILD_DROGON_SHARED OFF"
        "USE_POSTGRESQL OFF"
        "USE_MYSQL OFF"
        "USE_SQLITE3 OFF"
        "USE_REDIS OFF"
)
if(drogon_ADDED)
    set_property(TARGET drogon PROPERTY SYSTEM ON)
    target_compile_options(drogon PRIVATE -Wno-deprecated-declarations -w)
endif()

# ---------------------------------------------------------------------------
# hyni_core: stateless LLM client (sys_prompts + web_client + streaming).
# ---------------------------------------------------------------------------
add_library(hyni_core STATIC
    src/hyni/web_client.cpp
    src/hyni/sys_prompts.cpp
    src/hyni/mcp_client.cpp
)
target_include_directories(hyni_core PUBLIC src)
target_link_libraries(hyni_core
    PUBLIC
        CURL::libcurl
        nlohmann_json::nlohmann_json
        simdjson::simdjson
        Threads::Threads
    PRIVATE
        hyni_warnings
)

# ---------------------------------------------------------------------------
# hyni_web_server: Drogon app + controllers.
# ---------------------------------------------------------------------------
add_executable(hyni_web_server
    src/main.cc
    src/controllers/ChatController.cc
)
target_include_directories(hyni_web_server PRIVATE src)
target_link_libraries(hyni_web_server
    PRIVATE
        hyni_core
        drogon
        hyni_warnings
)

# Copy config + symlink the project-level public/ next to the binary for the
# default Drogon `document_root: ./public` resolution.
add_custom_command(TARGET hyni_web_server POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory $<TARGET_FILE_DIR:hyni_web_server>/config
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            ${CMAKE_CURRENT_SOURCE_DIR}/config/drogon.json
            $<TARGET_FILE_DIR:hyni_web_server>/config/drogon.json
    COMMAND ${CMAKE_COMMAND} -E create_symlink
            ${CMAKE_CURRENT_SOURCE_DIR}/../public
            $<TARGET_FILE_DIR:hyni_web_server>/public
    VERBATIM
)

# ---------------------------------------------------------------------------
# Integration tests (GTest). Opt-in so a default `cmake --build` doesn't
# pull GTest into the build.
# ---------------------------------------------------------------------------
option(HYNI_BUILD_TESTS "Build the hyni.web integration test binary" OFF)
if(HYNI_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

# ---------------------------------------------------------------------------
# Build summary printed at the end of `cmake -S backend -B build`.
# ---------------------------------------------------------------------------
message(STATUS "------------------------------------------------------------")
message(STATUS "  hyni.web backend")
message(STATUS "    C++ standard           : ${CMAKE_CXX_STANDARD}")
message(STATUS "    Build type             : ${CMAKE_BUILD_TYPE}")
message(STATUS "    Compiler               : ${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}")
message(STATUS "    ccache                 : ${CCACHE}")
message(STATUS "    HYNI_NATIVE_OPTS       : ${HYNI_NATIVE_OPTS}")
if(HYNI_NATIVE_OPTS)
message(STATUS "      └─ Release flags     : -O3 -pipe -flto -march=znver5 -fno-plt")
else()
message(STATUS "      └─ Release flags     : -O3 -pipe (portable)")
endif()
message(STATUS "------------------------------------------------------------")
