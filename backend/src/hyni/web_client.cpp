#include "web_client.h"

#include <chrono>
#include <stdexcept>
#include <curl/curl.h>

namespace hyni {

namespace {

constexpr const char OPENAI_URL[]    = "https://api.openai.com/v1/chat/completions";
constexpr const char ANTHROPIC_URL[] = "https://api.anthropic.com/v1/messages";

constexpr const char DEFAULT_OPENAI_MODEL[]    = "gpt-4o";
constexpr const char DEFAULT_ANTHROPIC_MODEL[] = "claude-sonnet-4-5-20250929";

size_t curl_write(void* contents, size_t size, size_t nmemb, std::string* out) {
    if (!out) return 0;
    size_t n = size * nmemb;
    try { out->append(static_cast<char*>(contents), n); }
    catch (const std::bad_alloc&) { return 0; }
    return n;
}

nlohmann::json build_openai_messages(const chat_request& req) {
    nlohmann::json messages = nlohmann::json::array();

    // System message.
    const std::string sys = compose_system_prompt(req.mode, req.profile);
    if (!sys.empty()) {
        messages.push_back({{"role", "system"}, {"content", sys}});
    }

    auto push_user_with_images = [](nlohmann::json& msgs,
                                    const std::string& text,
                                    const std::vector<image_data>& images) {
        nlohmann::json content = nlohmann::json::array();
        if (!text.empty()) {
            content.push_back({{"type", "text"}, {"text", text}});
        }
        for (const auto& img : images) {
            if (!img.is_valid()) continue;
            content.push_back({
                {"type", "image_url"},
                {"image_url", {
                    {"url", "data:" + img.mime_type + ";base64," + img.image_base64}
                }}
            });
        }
        if (content.empty()) {
            content.push_back({{"type", "text"}, {"text", "[empty message]"}});
        }
        msgs.push_back({{"role", "user"}, {"content", content}});
    };

    for (const auto& m : req.history) {
        if (m.role == "user") {
            push_user_with_images(messages, m.text, m.images);
        } else if (m.role == "assistant") {
            messages.push_back({{"role", "assistant"}, {"content", m.text}});
        }
    }

    push_user_with_images(messages, req.user_message, req.images);
    return messages;
}

nlohmann::json build_anthropic_messages(const chat_request& req,
                                        std::string& system_out) {
    system_out = compose_system_prompt(req.mode, req.profile);

    nlohmann::json messages = nlohmann::json::array();

    auto push_user_with_images = [](nlohmann::json& msgs,
                                    const std::string& text,
                                    const std::vector<image_data>& images) {
        nlohmann::json content = nlohmann::json::array();
        if (!text.empty()) {
            content.push_back({{"type", "text"}, {"text", text}});
        }
        for (const auto& img : images) {
            if (!img.is_valid()) continue;
            content.push_back({
                {"type", "image"},
                {"source", {
                    {"type", "base64"},
                    {"media_type", img.mime_type},
                    {"data", img.image_base64}
                }}
            });
        }
        if (content.empty()) {
            content.push_back({{"type", "text"}, {"text", "[empty message]"}});
        }
        msgs.push_back({{"role", "user"}, {"content", content}});
    };

    for (const auto& m : req.history) {
        if (m.role == "user") {
            push_user_with_images(messages, m.text, m.images);
        } else if (m.role == "assistant") {
            messages.push_back({
                {"role", "assistant"},
                {"content", nlohmann::json::array({
                    {{"type", "text"}, {"text", m.text}}
                })}
            });
        }
    }

    push_user_with_images(messages, req.user_message, req.images);
    return messages;
}

} // namespace

std::string default_model(API_PROVIDER provider) {
    switch (provider) {
    case API_PROVIDER::OpenAI:    return DEFAULT_OPENAI_MODEL;
    case API_PROVIDER::Anthropic: return DEFAULT_ANTHROPIC_MODEL;
    default:                       return "";
    }
}

nlohmann::json build_payload(const chat_request& req) {
    nlohmann::json payload;
    const std::string model = req.model.empty() ? default_model(req.provider) : req.model;

    switch (req.provider) {
    case API_PROVIDER::OpenAI: {
        payload["model"]    = model;
        payload["messages"] = build_openai_messages(req);
        payload["temperature"]           = req.temperature;
        payload["max_completion_tokens"] = req.max_tokens;
        break;
    }
    case API_PROVIDER::Anthropic: {
        std::string system;
        nlohmann::json messages = build_anthropic_messages(req, system);
        payload["model"]      = model;
        payload["messages"]   = messages;
        payload["max_tokens"] = req.max_tokens;
        payload["temperature"]= req.temperature;
        if (!system.empty()) payload["system"] = system;
        break;
    }
    default:
        throw std::invalid_argument("Unsupported provider");
    }
    return payload;
}

static chat_result parse_openai_response(const std::string& body, int http_status) {
    chat_result r;
    r.http_status = http_status;
    try {
        auto j = nlohmann::json::parse(body);
        if (j.contains("error")) {
            r.error = j["error"].value("message", j["error"].dump());
            return r;
        }
        if (j.contains("usage")) {
            r.prompt_tokens     = j["usage"].value("prompt_tokens", 0);
            r.completion_tokens = j["usage"].value("completion_tokens", 0);
        }
        if (!j.contains("choices") || j["choices"].empty()) {
            r.error = "OpenAI response missing 'choices'";
            return r;
        }
        const auto& msg = j["choices"][0]["message"];
        if (msg["content"].is_string()) {
            r.content = msg["content"].get<std::string>();
        } else if (msg["content"].is_array()) {
            for (const auto& it : msg["content"]) {
                if (it.value("type", "") == "text" || it.value("type", "") == "output_text") {
                    r.content += it.value("text", "");
                }
            }
        }
        r.success = !r.content.empty();
        if (!r.success) r.error = "OpenAI response has empty content";
    } catch (const std::exception& e) {
        r.error = std::string("Failed to parse OpenAI response: ") + e.what();
    }
    return r;
}

static chat_result parse_anthropic_response(const std::string& body, int http_status) {
    chat_result r;
    r.http_status = http_status;
    try {
        auto j = nlohmann::json::parse(body);
        if (j.contains("error")) {
            r.error = j["error"].value("message", j["error"].dump());
            return r;
        }
        if (j.contains("usage")) {
            r.prompt_tokens     = j["usage"].value("input_tokens", 0);
            r.completion_tokens = j["usage"].value("output_tokens", 0);
        }
        if (j.contains("content") && j["content"].is_array()) {
            for (const auto& it : j["content"]) {
                if (it.value("type", "") == "text") {
                    r.content += it.value("text", "");
                }
            }
        }
        r.success = !r.content.empty();
        if (!r.success && r.error.empty()) {
            r.error = "Anthropic response has empty content";
        }
    } catch (const std::exception& e) {
        r.error = std::string("Failed to parse Anthropic response: ") + e.what();
    }
    return r;
}

chat_result send_chat(const chat_request& req, const std::string& api_key) {
    chat_result r;
    if (api_key.empty()) {
        r.error = "Missing API key for provider " + provider_to_str(req.provider);
        return r;
    }

    const std::string url = (req.provider == API_PROVIDER::Anthropic)
                                ? ANTHROPIC_URL
                                : OPENAI_URL;

    nlohmann::json payload;
    try { payload = build_payload(req); }
    catch (const std::exception& e) { r.error = e.what(); return r; }

    const std::string payload_str = payload.dump();

    CURL* curl = curl_easy_init();
    if (!curl) { r.error = "curl_easy_init failed"; return r; }

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    if (req.provider == API_PROVIDER::Anthropic) {
        headers = curl_slist_append(headers, "anthropic-version: 2023-06-01");
        const std::string h = "x-api-key: " + api_key;
        headers = curl_slist_append(headers, h.c_str());
    } else {
        const std::string h = "Authorization: Bearer " + api_key;
        headers = curl_slist_append(headers, h.c_str());
    }

    std::string body;
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload_str.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(payload_str.size()));
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, static_cast<long>(req.timeout_seconds));
    curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2_0);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_TCP_KEEPALIVE, 1L);

    const auto t0 = std::chrono::steady_clock::now();
    CURLcode rc   = curl_easy_perform(curl);
    const auto t1 = std::chrono::steady_clock::now();
    r.latency_ms  = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (rc != CURLE_OK) {
        r.http_status = static_cast<int>(http_code);
        r.error = std::string("HTTP transport error: ") + curl_easy_strerror(rc);
        return r;
    }

    return (req.provider == API_PROVIDER::Anthropic)
               ? parse_anthropic_response(body, static_cast<int>(http_code))
               : parse_openai_response(body, static_cast<int>(http_code));
}

} // namespace hyni
