cmake_minimum_required(VERSION 3.20)
project(hyni_web CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Optional ccache for faster rebuilds.
find_program(CCACHE ccache)
if(CCACHE)
    set(CMAKE_CXX_COMPILER_LAUNCHER ${CCACHE})
endif()

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_compile_options($<$<CONFIG:Release>:-O2>)
add_compile_options($<$<CONFIG:Debug>:-O0>)
add_compile_options($<$<CONFIG:Debug>:-g>)

# ---------------------------------------------------------------------------
# System dependencies: nlohmann/json (header-only) + libcurl + threads.
# ---------------------------------------------------------------------------
find_package(CURL REQUIRED)
find_package(Threads REQUIRED)
find_package(nlohmann_json QUIET)
if(NOT nlohmann_json_FOUND)
    # nlohmann/json is header-only and ships at /usr/include on Gentoo / Debian.
    if(NOT EXISTS "/usr/include/nlohmann/json.hpp")
        message(FATAL_ERROR
            "nlohmann/json not found. Install dev-cpp/nlohmann_json or set "
            "CMAKE_PREFIX_PATH to your json install.")
    endif()
    add_library(nlohmann_json::nlohmann_json INTERFACE IMPORTED)
endif()

# ---------------------------------------------------------------------------
# Drogon via CPM (FetchContent under the hood).
# First build pulls + compiles Drogon (~3-5 min). Cached after that.
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
# hyni_core: stateless LLM client (web_client + sys_prompts).
# ---------------------------------------------------------------------------
add_library(hyni_core STATIC
    src/hyni/web_client.cpp
    src/hyni/sys_prompts.cpp
)
target_include_directories(hyni_core PUBLIC src)
target_link_libraries(hyni_core PUBLIC
    CURL::libcurl
    nlohmann_json::nlohmann_json
    Threads::Threads
)
target_compile_options(hyni_core PRIVATE -Wall -Wextra -Wpedantic)

# ---------------------------------------------------------------------------
# hyni_web_server: Drogon app + controllers.
# ---------------------------------------------------------------------------
add_executable(hyni_web_server
    src/main.cc
    src/controllers/ChatController.cc
)
target_include_directories(hyni_web_server PRIVATE src)
target_link_libraries(hyni_web_server PRIVATE
    hyni_core
    drogon
)
target_compile_options(hyni_web_server PRIVATE -Wall -Wextra -Wpedantic)

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
