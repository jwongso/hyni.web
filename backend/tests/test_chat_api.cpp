// hyni.web integration tests — exercise the live HTTP endpoints of a
// running hyni_web_server.
//
// Prerequisites:
//   1. The server is running on the URL pointed to by HYNI_TEST_BASE_URL
//      (default http://localhost:8848). Tests that cannot reach the server
//      are SKIPPED with a clear message.
//   2. For tests that hit real LLM providers (and therefore cost real
//      money), set HYNI_TESTS_LIVE_LLM=1 to opt in. Otherwise those
//      tests are SKIPPED.
//   3. If the server has HYNI_OWNER_TOKEN set, supply the same value via
//      HYNI_TEST_OWNER_TOKEN so the owner-mode tests can authenticate.
//
// Run:
//   cd backend
//   cmake -S . -B build -DHYNI_BUILD_TESTS=ON
//   cmake --build build -j
//   HYNI_TESTS_LIVE_LLM=1 HYNI_TEST_OWNER_TOKEN=Auckland2023 ./build/hyni_web_tests
//   ./build/hyni_web_tests --gtest_color=yes
//
// Cost note: each live-LLM test sends ≤1 KB prompt + ≤16 output tokens.
// A full pass against OpenAI + Anthropic is well under $0.05.

#include <cstdlib>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include "http_client.h"
#include "test_assets.h"

using json = nlohmann::json;
using hyni_tests::HttpClient;
using hyni_tests::HttpResponse;

namespace {

std::string getenv_or(const char* k, const std::string& def) {
    const char* v = std::getenv(k);
    return v ? std::string(v) : def;
}

bool envtrue(const char* k) {
    const char* v = std::getenv(k);
    if (!v) return false;
    return std::string(v) == "1" || std::string(v) == "true";
}

std::string base_url() { return getenv_or("HYNI_TEST_BASE_URL", "http://localhost:8848"); }

std::string owner_token() { return getenv_or("HYNI_TEST_OWNER_TOKEN", ""); }

std::vector<std::string> auth_headers() {
    const auto t = owner_token();
    if (t.empty()) return {};
    return { "Authorization: Bearer " + t };
}

bool live_llm() { return envtrue("HYNI_TESTS_LIVE_LLM"); }

// True if the server is reachable at all. Used to SKIP whole tests when
// the developer ran ctest without `scripts/run.sh` going.
bool server_up() {
    try {
        HttpClient c;
        auto r = c.get(base_url() + "/api/config");
        return r.status >= 200 && r.status < 500;
    } catch (...) { return false; }
}

// Fetch the server's owner_mode_enabled flag once per process.
bool server_owner_mode_enabled() {
    static int cached = -1;
    if (cached != -1) return cached == 1;
    try {
        HttpClient c;
        auto r = c.get(base_url() + "/api/config");
        if (r.status != 200) return false;
        auto j = json::parse(r.body);
        cached = j.value("owner_mode_enabled", false) ? 1 : 0;
        return cached == 1;
    } catch (...) { return false; }
}

// Single-image / three-image payload builders shared by several tests.
json image_obj(const char* base64, const char* mime = "image/png") {
    return { {"image_base64", base64}, {"mime_type", mime} };
}

} // namespace

// --- Fixture ----------------------------------------------------------------

class HyniWebApiTest : public ::testing::Test {
protected:
    void SetUp() override {
        if (!server_up()) {
            GTEST_SKIP() << "hyni_web_server not reachable at " << base_url()
                         << " — start it with scripts/run.sh first.";
        }
    }
    HttpClient http;
};

// ============================================================================
// Config endpoint
// ============================================================================

TEST_F(HyniWebApiTest, ConfigReturnsExpectedShape) {
    const auto r = http.get(base_url() + "/api/config", auth_headers());
    ASSERT_EQ(r.status, 200);
    ASSERT_NE(r.content_type.find("application/json"), std::string::npos);

    const auto j = json::parse(r.body);
    EXPECT_TRUE(j.contains("providers"));
    EXPECT_TRUE(j["providers"].is_array());
    EXPECT_GE(j["providers"].size(), 4u);
    EXPECT_TRUE(j.contains("modes"));
    EXPECT_TRUE(j["modes"].is_array());

    // Every provider entry has the expected keys.
    for (const auto& p : j["providers"]) {
        EXPECT_TRUE(p.contains("id"));
        EXPECT_TRUE(p.contains("default_model"));
        EXPECT_TRUE(p.contains("has_key"));
    }

    EXPECT_TRUE(j.contains("owner_mode_enabled"));
    EXPECT_TRUE(j.contains("is_owner"));
}

// ============================================================================
// Input validation (no LLM calls — always run)
// ============================================================================

TEST_F(HyniWebApiTest, BadJsonBodyReturns400) {
    const auto r = http.post_json(base_url() + "/api/chat",
                                  R"({"this isn't valid json)",
                                  auth_headers());
    EXPECT_EQ(r.status, 400);
}

TEST_F(HyniWebApiTest, MissingMessageAndImagesReturns400) {
    const json body = { {"provider", "openai"}, {"mode", "general"} };
    const auto r = http.post_json(base_url() + "/api/chat", body.dump(), auth_headers());
    EXPECT_EQ(r.status, 400);
}

TEST_F(HyniWebApiTest, UnknownProviderReturns400) {
    const json body = {
        {"provider", "made-up-provider"},
        {"mode", "general"},
        {"message", "hello"},
    };
    const auto r = http.post_json(base_url() + "/api/chat", body.dump(), auth_headers());
    EXPECT_EQ(r.status, 400);
}

// ============================================================================
// Owner-mode lockdown
// ============================================================================

TEST_F(HyniWebApiTest, GuestRequestIs402WhenOwnerModeEnabled) {
    if (!server_owner_mode_enabled()) {
        GTEST_SKIP() << "server is in open mode (no HYNI_OWNER_TOKEN set) — "
                        "lockdown path cannot be exercised";
    }
    const json body = {
        {"provider", "openai"}, {"mode", "general"},
        {"message", "hi"}, {"max_tokens", 1},
    };
    // No Authorization header on purpose.
    const auto r = http.post_json(base_url() + "/api/chat", body.dump(), {});
    EXPECT_EQ(r.status, 402);
}

TEST_F(HyniWebApiTest, WrongBearerIs402WhenOwnerModeEnabled) {
    if (!server_owner_mode_enabled()) {
        GTEST_SKIP() << "server is in open mode";
    }
    const json body = {
        {"provider", "openai"}, {"mode", "general"},
        {"message", "hi"}, {"max_tokens", 1},
    };
    const auto r = http.post_json(base_url() + "/api/chat", body.dump(),
                                  { "Authorization: Bearer this-is-not-the-token" });
    EXPECT_EQ(r.status, 402);
}

// ============================================================================
// Live LLM round-trips
// ============================================================================

// Helper: standard 'reply with exactly OK' probe against a given provider.
// Returns the parsed JSON response body; success() asserts the HTTP and
// LLM-level success flags both passed.
static json post_chat_or_skip(HttpClient& http,
                              const std::string& provider,
                              const json& extra_body = json::object()) {
    if (!live_llm()) {
        ADD_FAILURE() << "live_llm() not set — should have been gated by caller";
    }
    json body = {
        {"provider", provider},
        {"mode", "general"},
        {"message", "Reply with exactly: OK"},
        {"max_tokens", 4},
        {"temperature", 0.0},
    };
    body.update(extra_body);
    const auto r = http.post_json(base_url() + "/api/chat", body.dump(), auth_headers());
    EXPECT_EQ(r.status, 200) << "body: " << r.body;
    return json::parse(r.body);
}

TEST_F(HyniWebApiTest, TextOnlyOpenAi) {
    if (!live_llm()) GTEST_SKIP() << "HYNI_TESTS_LIVE_LLM not set";
    auto j = post_chat_or_skip(http, "openai");
    EXPECT_TRUE(j["success"].get<bool>()) << j.dump(2);
    EXPECT_FALSE(j["content"].get<std::string>().empty());
    EXPECT_GT(j["latency_ms"].get<long long>(), 0);
}

TEST_F(HyniWebApiTest, TextOnlyAnthropic) {
    if (!live_llm()) GTEST_SKIP() << "HYNI_TESTS_LIVE_LLM not set";
    auto j = post_chat_or_skip(http, "anthropic");
    EXPECT_TRUE(j["success"].get<bool>()) << j.dump(2);
    EXPECT_FALSE(j["content"].get<std::string>().empty());
}

TEST_F(HyniWebApiTest, TextOnlyDeepSeek) {
    if (!live_llm()) GTEST_SKIP() << "HYNI_TESTS_LIVE_LLM not set";
    auto j = post_chat_or_skip(http, "deepseek");
    EXPECT_TRUE(j["success"].get<bool>()) << j.dump(2);
}

TEST_F(HyniWebApiTest, TextOnlyMistral) {
    if (!live_llm()) GTEST_SKIP() << "HYNI_TESTS_LIVE_LLM not set";
    auto j = post_chat_or_skip(http, "mistral");
    EXPECT_TRUE(j["success"].get<bool>()) << j.dump(2);
}

// ============================================================================
// Multimodal — the original "are all images forwarded?" question
// ============================================================================

// Helper to extract digits 1/2/3 mentioned by the LLM in its reply.
// We instruct the model to reply in a tight format; we tolerate either
// 'count=3 digits=1,2,3' or natural-language equivalents.
static int count_digits_in(const std::string& s, const std::vector<char>& digits) {
    int found = 0;
    for (char d : digits) if (s.find(d) != std::string::npos) ++found;
    return found;
}

TEST_F(HyniWebApiTest, SingleImageOpenAi) {
    if (!live_llm()) GTEST_SKIP() << "HYNI_TESTS_LIVE_LLM not set";
    const json body = {
        {"provider", "openai"},
        {"mode", "general"},
        {"message",
         "What single digit is written large in this image? Reply with ONLY the digit."},
        {"max_tokens", 4},
        {"temperature", 0.0},
        {"images", { image_obj(hyni_tests::PNG_2_BASE64) }},
    };
    const auto r = http.post_json(base_url() + "/api/chat", body.dump(), auth_headers());
    ASSERT_EQ(r.status, 200) << r.body;
    const auto j = json::parse(r.body);
    ASSERT_TRUE(j["success"].get<bool>()) << j.dump(2);
    EXPECT_NE(j["content"].get<std::string>().find('2'), std::string::npos)
        << "model did not see digit '2' in the single image. content: "
        << j["content"];
}

TEST_F(HyniWebApiTest, ThreeImagesOpenAi) {
    if (!live_llm()) GTEST_SKIP() << "HYNI_TESTS_LIVE_LLM not set";
    const json body = {
        {"provider", "openai"},
        {"mode", "general"},
        {"message",
         "Three images are attached, each shows ONE large white digit. "
         "Reply in this exact format: count=N digits=A,B,C"},
        {"max_tokens", 32},
        {"temperature", 0.0},
        {"images", json::array({
            image_obj(hyni_tests::PNG_1_BASE64),
            image_obj(hyni_tests::PNG_2_BASE64),
            image_obj(hyni_tests::PNG_3_BASE64),
        })},
    };
    const auto r = http.post_json(base_url() + "/api/chat", body.dump(), auth_headers());
    ASSERT_EQ(r.status, 200) << r.body;
    const auto j = json::parse(r.body);
    ASSERT_TRUE(j["success"].get<bool>()) << j.dump(2);
    const auto content = j["content"].get<std::string>();
    EXPECT_EQ(count_digits_in(content, {'1','2','3'}), 3)
        << "expected all three digits in reply. content: " << content;
}

TEST_F(HyniWebApiTest, ThreeImagesAnthropic) {
    if (!live_llm()) GTEST_SKIP() << "HYNI_TESTS_LIVE_LLM not set";
    const json body = {
        {"provider", "anthropic"},
        {"mode", "general"},
        {"message",
         "Three images are attached, each shows ONE large white digit. "
         "Reply in this exact format: count=N digits=A,B,C"},
        {"max_tokens", 32},
        {"temperature", 0.0},
        {"images", json::array({
            image_obj(hyni_tests::PNG_1_BASE64),
            image_obj(hyni_tests::PNG_2_BASE64),
            image_obj(hyni_tests::PNG_3_BASE64),
        })},
    };
    const auto r = http.post_json(base_url() + "/api/chat", body.dump(), auth_headers());
    ASSERT_EQ(r.status, 200) << r.body;
    const auto j = json::parse(r.body);
    ASSERT_TRUE(j["success"].get<bool>()) << j.dump(2);
    const auto content = j["content"].get<std::string>();
    EXPECT_EQ(count_digits_in(content, {'1','2','3'}), 3)
        << "Anthropic missed one or more attached images. content: " << content;
}

// ============================================================================
// Mode-specific behaviour
// ============================================================================

TEST_F(HyniWebApiTest, BehavioralModeStartsWithSituation) {
    if (!live_llm()) GTEST_SKIP() << "HYNI_TESTS_LIVE_LLM not set";
    const json body = {
        {"provider", "openai"},
        {"mode", "behavioral"},
        {"profile", {
            {"target_role", "Senior Software Engineer"},
            {"resume_text",
             "Senior Software Engineer at Acme Corp (2019-2024). Led migration "
             "of monolithic billing system to a microservices architecture; "
             "reduced p99 latency by 40 percent."},
            {"extra_notes", ""},
        }},
        {"message", "Tell me about a time you led a difficult migration."},
        {"max_tokens", 400},
        {"temperature", 0.0},
    };
    const auto r = http.post_json(base_url() + "/api/chat", body.dump(), auth_headers());
    ASSERT_EQ(r.status, 200) << r.body;
    const auto j = json::parse(r.body);
    ASSERT_TRUE(j["success"].get<bool>()) << j.dump(2);
    const auto content = j["content"].get<std::string>();
    EXPECT_EQ(content.find("Situation"), 0u)
        << "Behavioral reply did not start with 'Situation' — preamble crept "
        << "back in. content: " << content;
}

TEST_F(HyniWebApiTest, CodingModeReturnsCode) {
    if (!live_llm()) GTEST_SKIP() << "HYNI_TESTS_LIVE_LLM not set";
    const json body = {
        {"provider", "openai"},
        {"mode", "coding"},
        {"message", "Write a function that reverses a string."},
        {"max_tokens", 200},
        {"temperature", 0.0},
    };
    const auto r = http.post_json(base_url() + "/api/chat", body.dump(), auth_headers());
    ASSERT_EQ(r.status, 200) << r.body;
    const auto j = json::parse(r.body);
    ASSERT_TRUE(j["success"].get<bool>()) << j.dump(2);
    const auto content = j["content"].get<std::string>();
    // Coding mode defaults to Python, so a 'def ' should appear somewhere.
    EXPECT_NE(content.find("def "), std::string::npos)
        << "Coding mode did not emit a Python def. content: " << content;
}

// ============================================================================
// Streaming endpoint
// ============================================================================

TEST_F(HyniWebApiTest, StreamReturnsMultipleDeltaFrames) {
    if (!live_llm()) GTEST_SKIP() << "HYNI_TESTS_LIVE_LLM not set";
    const json body = {
        {"provider", "openai"},
        {"mode", "general"},
        {"message", "Count from 1 to 5, one number per line."},
        {"max_tokens", 32},
        {"temperature", 0.0},
    };
    const auto r = http.post_json(base_url() + "/api/chat/stream",
                                  body.dump(), auth_headers());
    ASSERT_EQ(r.status, 200);
    ASSERT_NE(r.content_type.find("text/event-stream"), std::string::npos);

    // Count the number of SSE "data: " frames (delta + done).
    size_t pos = 0, frames = 0, deltas = 0;
    bool done = false;
    while ((pos = r.body.find("data:", pos)) != std::string::npos) {
        ++frames;
        const size_t end = r.body.find("\n\n", pos);
        const std::string payload = r.body.substr(
            pos + 5, end == std::string::npos ? std::string::npos : end - (pos + 5));
        if (payload.find("\"delta\"") != std::string::npos) ++deltas;
        if (payload.find("\"done\"")  != std::string::npos) done = true;
        pos = (end == std::string::npos) ? r.body.size() : end + 2;
    }
    EXPECT_GE(frames, 2u) << "expected at least one delta and one done frame";
    EXPECT_GE(deltas, 1u) << "expected at least one delta frame";
    EXPECT_TRUE(done) << "no done frame received";
}
