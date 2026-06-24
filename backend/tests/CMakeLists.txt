cmake_minimum_required(VERSION 3.20)

find_package(GTest REQUIRED)

add_executable(hyni_web_tests
    test_chat_api.cpp
)
target_include_directories(hyni_web_tests PRIVATE .)
target_link_libraries(hyni_web_tests PRIVATE
    GTest::gtest
    GTest::gtest_main
    CURL::libcurl
    nlohmann_json::nlohmann_json
    Threads::Threads
)
target_compile_options(hyni_web_tests PRIVATE -Wall -Wextra)

include(GoogleTest)
gtest_discover_tests(hyni_web_tests
    PROPERTIES
        # Default ctest timeout per case (live-LLM calls can be slow).
        TIMEOUT 120
        # Real-screenshot fixtures live next to this file; expose the path
        # so the binary can find them regardless of CWD when launched.
        ENVIRONMENT "HYNI_TEST_FIXTURES_DIR=${CMAKE_CURRENT_SOURCE_DIR}/fixtures"
)
