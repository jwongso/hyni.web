#include "web_client.h"
#include "mcp_client.h"

#include <chrono>
#include <cstring>
#include <stdexcept>
#include <string_view>
#include <curl/curl.h>
#include <simdjson.h>

namespace hyni {

namespace {

constexpr const char OPENAI_URL[]    = "https://api.openai.com/v1/chat/completions";
constexpr const char ANTHROPIC_URL[] = "https://api.anthropic.com/v1/messages";
constexpr const char DEEPSEEK_URL[]  = "https://api.deepseek.com/v1/chat/completions";
constexpr const char MISTRAL_URL[]   = "https://api.mistral.ai/v1/chat/completions";

// Default URL for the Local OpenAI-compatible provider. Override at runtime
// with `LOCAL_LLM_URL=http://localhost:8080/v1/chat/completions` (the value
// llama.cpp's `./server` binds to). Pick any of the OpenAI-compatible
// runtimes: llama.cpp, vLLM, Ollama (with the /v1 OpenAI shim enabled),
// LM Studio, text-generation-webui's openai extension, etc.
//
// Default points at the standard llama.cpp server port (8080); change in
// .env if yours lives elsewhere.
constexpr const char DEFAULT_LOCAL_URL[] = "http://localhost:8080/v1/chat/completions";

constexpr const char DEFAULT_OPENAI_MODEL[]    = "gpt-4o";
constexpr const char DEFAULT_ANTHROPIC_MODEL[] = "claude-sonnet-4-5-20250929";
constexpr const char DEFAULT_DEEPSEEK_MODEL[]  = "deepseek-chat";
constexpr const char DEFAULT_MISTRAL_MODEL[]   = "mistral-large-latest";
constexpr const char DEFAULT_LOCAL_MODEL[]     = "Qwen_Qwen3-8B-Q5_K_M.gguf";

// Curated, hand-tuned per-provider model catalogues exposed via /api/config
// so the frontend can render a real dropdown instead of a free-text input
// (which let users type non-existent slugs like 'deepseek-vl2'). Each entry
// is (id, label, vision_capable). Keep this list short and current — every
// addition here is a +1 to the picker; the user only has to redeploy the
// backend, not the SPA.
struct model_meta {
    const char* id;
    const char* label;
    bool        vision;
};

// Update freely as providers ship new models. Keep the default model
// (DEFAULT_*_MODEL above) inside its own catalogue so the picker always
// has a guaranteed match for the saved value.
constexpr model_meta OPENAI_MODELS[] = {
    {"gpt-4o",                 "GPT-4o (vision)",          true },
    {"gpt-4o-mini",            "GPT-4o mini (vision)",     true },
    {"gpt-5",                  "GPT-5",                    true },
    {"gpt-5-mini",             "GPT-5 mini",               true },
    {"gpt-5.5",                "GPT-5.5",                  true },
    {"o1",                     "o1 (reasoning, vision)",   true },
    {"o3-mini",                "o3-mini (reasoning)",      false},
};

constexpr model_meta ANTHROPIC_MODELS[] = {
    {"claude-opus-4-5-20251101",     "Claude Opus 4.5 (vision)",   true},
    {"claude-sonnet-4-5-20250929",   "Claude Sonnet 4.5 (vision)", true},
    {"claude-haiku-4-5-20250929",    "Claude Haiku 4.5 (vision)",  true},
    {"claude-3-5-sonnet-20241022",   "Claude 3.5 Sonnet (vision)", true},
    {"claude-3-5-haiku-20241022",    "Claude 3.5 Haiku",           false},
};

constexpr model_meta DEEPSEEK_MODELS[] = {
    {"deepseek-chat",      "DeepSeek-V3 chat",     false},
    {"deepseek-reasoner",  "DeepSeek-R1 reasoner", false},
};

constexpr model_meta MISTRAL_MODELS[] = {
    {"mistral-large-latest",   "Mistral Large",                 false},
    {"pixtral-large-latest",   "Pixtral Large (vision)",        true },
    {"pixtral-12b-2409",       "Pixtral 12B (vision)",          true },
    {"mistral-small-latest",   "Mistral Small",                 false},
};

// Local entry — defaults to llama.cpp's `./server` model. Users with a
// different setup either pick the placeholder 'local' or surface their
// own slug by editing this list. llama.cpp's /v1/chat/completions ignores
// the model field anyway, so any non-empty value works.
constexpr model_meta LOCAL_MODELS[] = {
    {"Qwen_Qwen3-8B-Q5_K_M.gguf", "Qwen3-8B (your local llama.cpp)", false},
    {"local",                      "Local (any other OpenAI-compatible)", false},
};

size_t curl_write(void* contents, size_t size, size_t nmemb, std::string* out) {
    if (!out) return 0;
    size_t n = size * nmemb;
    try { out->append(static_cast<char*>(contents), n); }
    catch (const std::bad_alloc&) { return 0; }
    return n;
}

// Per-model capability quirks.
//
// As of 2026:
//   - OpenAI's GPT-5 family (gpt-5, gpt-5.5, gpt-5-mini, ...) rejects any
//     `temperature` value other than the implicit default 1; sending
//     temperature:0 yields a 400 'Unsupported value' error. We omit the
//     field entirely on those models.
//   - DeepSeek's chat models — including deepseek-vl2 as of writing — do
//     not accept OpenAI-style `image_url` content blocks; the API errors
//     with 'unknown variant image_url'. We silently drop image content
//     when targeting DeepSeek. The text and history still flow.
//   - Mistral's pixtral-* lineage handles `image_url` correctly (other
//     mistral models simply ignore image blocks). Treat all mistral
//     models as image-capable; the user-facing UX should pick a vision
//     model if they want strong results.
//   - Anthropic Opus / Sonnet handle `temperature` and images natively.
bool model_supports_temperature(API_PROVIDER p, const std::string& model) {
    if (p != API_PROVIDER::OpenAI) return true;
    // gpt-5* refuses non-default temperature.
    return model.rfind("gpt-5", 0) != 0;
}

bool provider_supports_images(API_PROVIDER p) {
    // DeepSeek's HTTP API rejects image_url content blocks today, even on
    // their vision-tier model. Drop images server-side so requests don't
    // 400 — callers can keep a single payload shape regardless of
    // which provider they pick.
    if (p == API_PROVIDER::DeepSeek) return false;
    // Local (llama.cpp / Ollama / etc.) — most text-only GGUF models do not
    // understand image_url blocks. Vision-LLM serves through llama.cpp do
    // exist (LLaVA, MiniCPM, etc.) but they use non-standard wire formats,
    // not OpenAI-style image_url. Safer default: text-only.
    if (p == API_PROVIDER::Local)    return false;
    return true;
}

nlohmann::json build_openai_messages(const chat_request& req) {
    nlohmann::json messages = nlohmann::json::array();

    // System message.
    const std::string sys = compose_system_prompt(req.mode, req.profile);
    if (!sys.empty()) {
        messages.push_back({{"role", "system"}, {"content", sys}});
    }

    const bool allow_images = provider_supports_images(req.provider);

    auto push_user_with_images = [allow_images](nlohmann::json& msgs,
                                                 const std::string& text,
                                                 const std::vector<image_data>& images) {
        nlohmann::json content = nlohmann::json::array();
        if (!text.empty()) {
            content.push_back({{"type", "text"}, {"text", text}});
        }
        if (allow_images) {
            for (const auto& img : images) {
                if (!img.is_valid()) continue;
                content.push_back({
                    {"type", "image_url"},
                    {"image_url", {
                        {"url", "data:" + img.mime_type + ";base64," + img.image_base64}
                    }}
                });
            }
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
    case API_PROVIDER::DeepSeek:  return DEFAULT_DEEPSEEK_MODEL;
    case API_PROVIDER::Mistral:   return DEFAULT_MISTRAL_MODEL;
    case API_PROVIDER::Local:     return DEFAULT_LOCAL_MODEL;
    default:                       return "";
    }
}

template <std::size_t N>
static std::vector<model_info> materialize(const model_meta (&arr)[N]) {
    std::vector<model_info> out;
    out.reserve(N);
    for (const auto& m : arr) out.push_back({m.id, m.label, m.vision});
    return out;
}

std::vector<model_info> list_models(API_PROVIDER provider) {
    switch (provider) {
    case API_PROVIDER::OpenAI:    return materialize(OPENAI_MODELS);
    case API_PROVIDER::Anthropic: return materialize(ANTHROPIC_MODELS);
    case API_PROVIDER::DeepSeek:  return materialize(DEEPSEEK_MODELS);
    case API_PROVIDER::Mistral:   return materialize(MISTRAL_MODELS);
    case API_PROVIDER::Local:     return materialize(LOCAL_MODELS);
    default:                       return {};
    }
}

// Pull the Local provider URL from (in order of precedence):
//   1. per-request override (chat_request.local_url) — what the Settings UI
//      Local-URL field sends
//   2. LOCAL_LLM_URL env var
//   3. compiled-in default (llama.cpp's :8080)
static std::string resolve_local_url(const chat_request& req) {
    if (!req.local_url.empty()) return req.local_url;
    if (const char* v = std::getenv("LOCAL_LLM_URL")) {
        const std::string s(v);
        if (!s.empty()) return s;
    }
    return DEFAULT_LOCAL_URL;
}

nlohmann::json build_payload(const chat_request& req) {
    nlohmann::json payload;
    const std::string model = req.model.empty() ? default_model(req.provider) : req.model;

    switch (req.provider) {
    case API_PROVIDER::OpenAI:
    case API_PROVIDER::DeepSeek:
    case API_PROVIDER::Mistral:
    case API_PROVIDER::Local: {
        // All four speak the OpenAI Chat Completions wire format.
        payload["model"]    = model;
        payload["messages"] = build_openai_messages(req);
        if (model_supports_temperature(req.provider, model)) {
            payload["temperature"] = req.temperature;
        }
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

// Extracted helper: extracts tool_calls from a parsed `message` object.
// Returns the array of tool_call_log entries (without result_text — that's
// filled in by the calling loop after dispatching to MCP). Cursor is
// consumed; pass the message object AFTER content extraction.
static void extract_tool_calls(simdjson::ondemand::value& message,
                               std::vector<tool_call_log>& out) {
    simdjson::ondemand::array tc_arr;
    if (message["tool_calls"].get_array().get(tc_arr) != simdjson::SUCCESS) return;
    for (auto el : tc_arr) {
        simdjson::ondemand::value v;
        if (el.get(v) != simdjson::SUCCESS) continue;
        tool_call_log log;
        std::string_view id_sv;
        if (v["id"].get(id_sv) == simdjson::SUCCESS) log.id.assign(id_sv);
        simdjson::ondemand::value fn;
        if (v["function"].get(fn) != simdjson::SUCCESS) continue;
        std::string_view name_sv;
        if (fn["name"].get(name_sv) == simdjson::SUCCESS) log.name.assign(name_sv);
        // `arguments` is a JSON STRING (per OpenAI's tool-calling spec)
        // containing JSON. Parse the inner string into our json value.
        std::string_view args_sv;
        if (fn["arguments"].get(args_sv) == simdjson::SUCCESS && !args_sv.empty()) {
            try {
                log.arguments = nlohmann::json::parse(args_sv);
            } catch (...) {
                // Some Qwen versions emit pre-parsed objects; tolerate.
                log.arguments = nlohmann::json::object();
            }
        } else {
            log.arguments = nlohmann::json::object();
        }
        if (!log.name.empty()) out.push_back(std::move(log));
    }
}

static chat_result parse_openai_response(const std::string& body, int http_status) {
    chat_result r;
    r.http_status = http_status;

    // simdjson on-demand: ~2-4 GB/s parsing throughput, zero DOM allocation.
    // Documents must be padded with SIMDJSON_PADDING trailing bytes; the
    // padded_string ctor handles that.
    simdjson::padded_string padded(body);
    simdjson::ondemand::parser parser;
    simdjson::ondemand::document doc;
    if (auto err = parser.iterate(padded).get(doc); err) {
        r.error = std::string("Failed to parse OpenAI response: ") + simdjson::error_message(err);
        return r;
    }

    // Provider error envelope short-circuits before content extraction.
    // The on-demand cursor remains valid for subsequent sibling lookups
    // (parser auto-rewinds for known JSON shapes).
    {
        simdjson::ondemand::value err_val;
        if (doc["error"].get(err_val) == simdjson::SUCCESS) {
            std::string_view msg;
            r.error = (err_val["message"].get(msg) == simdjson::SUCCESS && !msg.empty())
                        ? std::string(msg)
                        : "OpenAI returned an error envelope";
            return r;
        }
    }

    // Usage metrics (optional in successful responses; tolerate absence).
    {
        simdjson::ondemand::value usage;
        if (doc["usage"].get(usage) == simdjson::SUCCESS) {
            int64_t v = 0;
            if (usage["prompt_tokens"].get(v) == simdjson::SUCCESS)     r.prompt_tokens     = static_cast<int>(v);
            if (usage["completion_tokens"].get(v) == simdjson::SUCCESS) r.completion_tokens = static_cast<int>(v);
        }
    }

    // Content: choices[0].message.content may be a plain string OR an array
    // of {type:"text"|"output_text", text:"..."} parts. We concatenate text
    // parts in both shapes.
    simdjson::ondemand::array choices;
    if (doc["choices"].get_array().get(choices) != simdjson::SUCCESS) {
        r.error = "OpenAI response missing 'choices'";
        return r;
    }

    for (auto choice : choices) {
        simdjson::ondemand::value message;
        if (choice["message"].get(message) != simdjson::SUCCESS) continue;

        simdjson::ondemand::value content_val;
        if (message["content"].get(content_val) == simdjson::SUCCESS) {
            if (content_val.type() == simdjson::ondemand::json_type::string) {
                std::string_view s;
                if (content_val.get(s) == simdjson::SUCCESS) r.content.append(s);
            } else if (content_val.type() == simdjson::ondemand::json_type::array) {
                for (auto part : content_val.get_array()) {
                    std::string_view type_sv;
                    if (part["type"].get(type_sv) != simdjson::SUCCESS) continue;
                    if (type_sv != "text" && type_sv != "output_text") continue;
                    std::string_view t;
                    if (part["text"].get(t) == simdjson::SUCCESS) r.content.append(t);
                }
            }
        }

        // Reasoning-model fallback: Qwen3 / DeepSeek-R1 / GPT-5 family put
        // their visible answer in `reasoning_content` (or `reasoning`) and
        // leave `content` empty when the response was cut off by max_tokens
        // mid-thought. Surface that instead of "empty content".
        if (r.content.empty()) {
            std::string_view rc;
            if (message["reasoning_content"].get(rc) == simdjson::SUCCESS && !rc.empty()) {
                r.content.append(rc);
            } else if (message["reasoning"].get(rc) == simdjson::SUCCESS && !rc.empty()) {
                r.content.append(rc);
            }
        }

        // Tool calls (when the model wants to invoke a function). simdjson
        // ondemand requires forward-only reads, so this MUST come after
        // content / reasoning extraction on the same `message` cursor.
        extract_tool_calls(message, r.tool_calls);

        break;  // first choice only — matches existing behaviour
    }

    // Success is content-non-empty OR tool calls were requested (the loop
    // in send_chat continues with the tools).
    r.success = !r.content.empty() || !r.tool_calls.empty();
    if (!r.success && r.error.empty()) {
        r.error = "Response was empty. If using a reasoning model "
                  "(Qwen3 / DeepSeek-R1 / GPT-5), try a larger max_tokens "
                  "so the model has room to finish thinking AND answer.";
    }
    return r;
}

static chat_result parse_anthropic_response(const std::string& body, int http_status) {
    chat_result r;
    r.http_status = http_status;

    simdjson::padded_string padded(body);
    simdjson::ondemand::parser parser;
    simdjson::ondemand::document doc;
    if (auto err = parser.iterate(padded).get(doc); err) {
        r.error = std::string("Failed to parse Anthropic response: ") + simdjson::error_message(err);
        return r;
    }

    {
        simdjson::ondemand::value err_val;
        if (doc["error"].get(err_val) == simdjson::SUCCESS) {
            std::string_view msg;
            r.error = (err_val["message"].get(msg) == simdjson::SUCCESS && !msg.empty())
                        ? std::string(msg)
                        : "Anthropic returned an error envelope";
            return r;
        }
    }

    {
        simdjson::ondemand::value usage;
        if (doc["usage"].get(usage) == simdjson::SUCCESS) {
            int64_t v = 0;
            if (usage["input_tokens"].get(v)  == simdjson::SUCCESS) r.prompt_tokens     = static_cast<int>(v);
            if (usage["output_tokens"].get(v) == simdjson::SUCCESS) r.completion_tokens = static_cast<int>(v);
        }
    }

    simdjson::ondemand::array content_array;
    if (doc["content"].get_array().get(content_array) == simdjson::SUCCESS) {
        for (auto block : content_array) {
            std::string_view type_sv;
            if (block["type"].get(type_sv) != simdjson::SUCCESS) continue;
            if (type_sv != "text") continue;
            std::string_view t;
            if (block["text"].get(t) == simdjson::SUCCESS) r.content.append(t);
        }
    }

    r.success = !r.content.empty();
    if (!r.success && r.error.empty()) r.error = "Anthropic response has empty content";
    return r;
}

// Send a single HTTP POST to the provider. Returns the body + HTTP status
// + curl rc + latency. No parsing. Used by send_chat() once per round of
// the tool-call loop, and by send_chat_stream() at the top of its stream.
namespace {
struct post_outcome {
    std::string  body;
    long         http_status = 0;
    CURLcode     curl_rc     = CURLE_OK;
    long long    latency_ms  = 0;
};

post_outcome post_json(const std::string& url,
                       const std::string& payload_str,
                       const std::string& api_key,
                       API_PROVIDER provider,
                       int timeout_seconds) {
    post_outcome o;
    CURL* curl = curl_easy_init();
    if (!curl) { o.curl_rc = CURLE_FAILED_INIT; return o; }

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    if (provider == API_PROVIDER::Anthropic) {
        headers = curl_slist_append(headers, "anthropic-version: 2023-06-01");
        const std::string h = "x-api-key: " + api_key;
        headers = curl_slist_append(headers, h.c_str());
    } else if (!api_key.empty()) {
        const std::string h = "Authorization: Bearer " + api_key;
        headers = curl_slist_append(headers, h.c_str());
    }

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload_str.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(payload_str.size()));
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &o.body);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, static_cast<long>(timeout_seconds));
    curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2_0);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_TCP_KEEPALIVE, 1L);

    const auto t0 = std::chrono::steady_clock::now();
    o.curl_rc = curl_easy_perform(curl);
    const auto t1 = std::chrono::steady_clock::now();
    o.latency_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &o.http_status);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    return o;
}
} // namespace

chat_result send_chat(const chat_request& req, const std::string& api_key) {
    chat_result final_result;
    if (api_key.empty() && req.provider != API_PROVIDER::Local) {
        final_result.error = "Missing API key for provider " + provider_to_str(req.provider);
        return final_result;
    }

    const std::string url =
        (req.provider == API_PROVIDER::Anthropic) ? std::string(ANTHROPIC_URL) :
        (req.provider == API_PROVIDER::DeepSeek)  ? std::string(DEEPSEEK_URL)  :
        (req.provider == API_PROVIDER::Mistral)   ? std::string(MISTRAL_URL)   :
        (req.provider == API_PROVIDER::Local)     ? resolve_local_url(req)     :
                                                    std::string(OPENAI_URL);

    nlohmann::json payload;
    try { payload = build_payload(req); }
    catch (const std::exception& e) { final_result.error = e.what(); return final_result; }

    // Tools are only injected for OpenAI-compatible providers. Anthropic
    // uses a different tool format which we'll add in a later pass.
    const bool tools_enabled =
        !req.tools.empty() &&
        req.provider != API_PROVIDER::Anthropic;
    if (tools_enabled) {
        payload["tools"]       = req.tools;
        payload["tool_choice"] = "auto";
    }

    long long total_latency = 0;
    int       http_status   = 0;
    const int max_rounds    = std::max(1, req.max_tool_rounds + 1);

    for (int round = 0; round < max_rounds; ++round) {
        const std::string payload_str = payload.dump();
        post_outcome out = post_json(url, payload_str, api_key,
                                     req.provider, req.timeout_seconds);
        total_latency += out.latency_ms;
        http_status    = static_cast<int>(out.http_status);

        if (out.curl_rc != CURLE_OK) {
            final_result.http_status = http_status;
            final_result.latency_ms  = total_latency;
            final_result.error = std::string("HTTP transport error: ") + curl_easy_strerror(out.curl_rc);
            return final_result;
        }

        chat_result step = (req.provider == API_PROVIDER::Anthropic)
            ? parse_anthropic_response(out.body, http_status)
            : parse_openai_response  (out.body, http_status);

        // Carry over already-executed tool calls so the caller sees the
        // full log when the loop finally finishes.
        std::vector<tool_call_log> calls_this_round = std::move(step.tool_calls);
        step.tool_calls.clear();

        // Terminal case 1: no tool calls -> the model produced its final
        // answer.
        if (calls_this_round.empty()) {
            step.latency_ms  = total_latency;
            step.tool_calls  = std::move(final_result.tool_calls);
            return step;
        }

        // Terminal case 2: we've hit the round budget — even though the
        // model wants to keep calling tools, refuse and return what we
        // have. Surface a hint in the error field so the UI can show it.
        if (round + 1 == max_rounds) {
            // Execute one more batch and stop, attaching results so the
            // user can see the model's last attempt. Then return.
            for (auto& call : calls_this_round) final_result.tool_calls.push_back(std::move(call));
            final_result.success      = true;
            final_result.content      = step.content;
            final_result.http_status  = http_status;
            final_result.latency_ms   = total_latency;
            final_result.error        = "tool-call budget exhausted ("
                                        + std::to_string(req.max_tool_rounds)
                                        + " rounds); model may have wanted to keep going";
            return final_result;
        }

        // Append the assistant message with its tool_calls to the running
        // messages array so the next round has context.
        nlohmann::json asst_msg = {
            {"role", "assistant"},
            // Some servers reject `content: null` while requiring it; an
            // empty string is the safest portable form.
            {"content", step.content.empty() ? "" : step.content},
            {"tool_calls", nlohmann::json::array()},
        };
        for (const auto& c : calls_this_round) {
            asst_msg["tool_calls"].push_back({
                {"id",       c.id},
                {"type",     "function"},
                {"function", {
                    {"name",      c.name},
                    {"arguments", c.arguments.dump()},
                }},
            });
        }
        payload["messages"].push_back(asst_msg);

        // Execute each tool call (sequentially — MCP is fast enough).
        for (auto& call : calls_this_round) {
            const auto t0 = std::chrono::steady_clock::now();
            const auto mcp_result = hyni::mcp::registry::call(call.name, call.arguments);
            const auto t1 = std::chrono::steady_clock::now();
            call.latency_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
            call.result_text = mcp_result.content_text;
            call.is_error    = mcp_result.is_error;
            payload["messages"].push_back({
                {"role",         "tool"},
                {"tool_call_id", call.id},
                {"content",      call.result_text.empty()
                                   ? (call.is_error ? mcp_result.error_message : "[no output]")
                                   : call.result_text},
            });
            final_result.tool_calls.push_back(std::move(call));
        }
    }

    // Should be unreachable given the max_rounds guard above.
    final_result.http_status = http_status;
    final_result.latency_ms  = total_latency;
    final_result.error       = "tool-call loop exited without resolution";
    return final_result;
}

// ===========================================================================
// Streaming
// ===========================================================================
//
// Wire format reminders:
//
//   OpenAI / DeepSeek / Mistral (all OpenAI-compatible):
//     data: {"choices":[{"delta":{"content":"Hel"},"index":0,...}]}\n\n
//     data: {"choices":[{"delta":{"content":"lo"},"index":0,...}]}\n\n
//     data: [DONE]\n\n
//
//   Anthropic Messages API:
//     event: message_start
//     data: {"type":"message_start", ...}\n\n
//     event: content_block_delta
//     data: {"type":"content_block_delta","index":0,
//            "delta":{"type":"text_delta","text":"Hel"}}\n\n
//     event: message_delta
//     data: {"type":"message_delta","usage":{"output_tokens":12}, ...}\n\n
//     event: message_stop
//     data: {"type":"message_stop"}\n\n
//
// Both deliver chunks small enough that allocating a fresh
// simdjson::padded_string per frame is cheap.

namespace {

// Streaming-time context shared between the libcurl WRITEFUNCTION and the
// caller's send_chat_stream invocation. Lives on the stack for the duration
// of curl_easy_perform.
struct stream_ctx {
    API_PROVIDER provider;
    const stream_delta_cb*     on_delta;
    const stream_reasoning_cb* on_reasoning;  // may be null
    std::string  sse_buffer;     // accumulates bytes across libcurl chunks
    std::string  full_content;   // assistant reply assembled for final result
    std::string  full_reasoning; // model's chain-of-thought (reasoning_content)
    std::string  error_text;
    int          prompt_tokens     = 0;
    int          completion_tokens = 0;
    bool         cancelled         = false;
    bool         done_seen         = false;   // OpenAI [DONE] / Anthropic message_stop
};

// Parse a single OpenAI/DeepSeek/Mistral SSE `data:` payload and apply its
// delta to the stream_ctx. `payload` is the bytes after "data: " up to (but
// not including) the frame terminator "\n\n". Returns true on success.
bool apply_openai_frame(stream_ctx& ctx, std::string_view payload) {
    // [DONE] sentinel — end of stream.
    if (payload == "[DONE]") {
        ctx.done_seen = true;
        return true;
    }

    simdjson::padded_string padded(payload);
    simdjson::ondemand::parser parser;
    simdjson::ondemand::document doc;
    if (auto e = parser.iterate(padded).get(doc); e) return false;

    // Surface error envelope mid-stream.
    {
        simdjson::ondemand::value err_val;
        if (doc["error"].get(err_val) == simdjson::SUCCESS) {
            std::string_view msg;
            if (err_val["message"].get(msg) == simdjson::SUCCESS) ctx.error_text.assign(msg);
            else ctx.error_text = "OpenAI returned an error envelope";
            return false;
        }
    }

    // Usage may appear in the final chunk (stream_options.include_usage).
    {
        simdjson::ondemand::value usage;
        if (doc["usage"].get(usage) == simdjson::SUCCESS) {
            int64_t v = 0;
            if (usage["prompt_tokens"].get(v)     == simdjson::SUCCESS) ctx.prompt_tokens     = static_cast<int>(v);
            if (usage["completion_tokens"].get(v) == simdjson::SUCCESS) ctx.completion_tokens = static_cast<int>(v);
        }
    }

    simdjson::ondemand::array choices;
    if (doc["choices"].get_array().get(choices) != simdjson::SUCCESS) return true;
    for (auto choice : choices) {
        simdjson::ondemand::value delta;
        if (choice["delta"].get(delta) != simdjson::SUCCESS) continue;

        // simdjson's ondemand `get<string_view>()` on a `null` value returns
        // INCORRECT_TYPE *and* leaves the cursor in an indeterminate state.
        // (llama.cpp's first chunk is {"role":"assistant","content":null}.)
        // Extract each candidate as a raw value, skip if null/non-string.
        auto extract = [](simdjson::ondemand::value& obj, const char* key,
                          std::string_view& out) -> bool {
            simdjson::ondemand::value v;
            if (obj[key].get(v) != simdjson::SUCCESS) return false;
            if (v.is_null()) return false;
            std::string_view sv;
            if (v.get_string().get(sv) != simdjson::SUCCESS) return false;
            if (sv.empty()) return false;
            out = sv;
            return true;
        };

        // Visible answer — `content` is the canonical field across all
        // OpenAI-compatible providers.
        std::string_view content;
        if (extract(delta, "content", content)) {
            ctx.full_content.append(content);
            if (ctx.on_delta && !(*ctx.on_delta)(content)) {
                ctx.cancelled = true;
                return false;
            }
        }

        // Reasoning model's chain-of-thought — kept on its own channel so
        // the frontend can render it in a collapsible "Thinking…" widget
        // rather than mixing it into the visible answer. Both fields may
        // appear (Qwen3 emits `reasoning_content`; some forks use
        // `reasoning`); never both populated in the same chunk, so the
        // `else if` saves one ondemand lookup.
        std::string_view reasoning;
        if (extract(delta, "reasoning_content", reasoning) ||
            extract(delta, "reasoning",         reasoning)) {
            ctx.full_reasoning.append(reasoning);
            if (ctx.on_reasoning && *ctx.on_reasoning &&
                !(*ctx.on_reasoning)(reasoning)) {
                ctx.cancelled = true;
                return false;
            }
        }
        break;  // single choice only
    }
    return true;
}

// Parse a single Anthropic SSE `data:` payload.
bool apply_anthropic_frame(stream_ctx& ctx, std::string_view payload) {
    simdjson::padded_string padded(payload);
    simdjson::ondemand::parser parser;
    simdjson::ondemand::document doc;
    if (auto e = parser.iterate(padded).get(doc); e) return false;

    std::string_view type_sv;
    if (doc["type"].get(type_sv) != simdjson::SUCCESS) return true;

    if (type_sv == "content_block_delta") {
        simdjson::ondemand::value delta;
        if (doc["delta"].get(delta) != simdjson::SUCCESS) return true;
        std::string_view delta_type;
        if (delta["type"].get(delta_type) != simdjson::SUCCESS) return true;
        if (delta_type != "text_delta") return true;
        std::string_view text;
        if (delta["text"].get(text) != simdjson::SUCCESS || text.empty()) return true;
        ctx.full_content.append(text);
        if (ctx.on_delta && !(*ctx.on_delta)(text)) {
            ctx.cancelled = true;
            return false;
        }
    } else if (type_sv == "message_start") {
        simdjson::ondemand::value msg;
        if (doc["message"].get(msg) == simdjson::SUCCESS) {
            simdjson::ondemand::value usage;
            if (msg["usage"].get(usage) == simdjson::SUCCESS) {
                int64_t v = 0;
                if (usage["input_tokens"].get(v) == simdjson::SUCCESS) ctx.prompt_tokens = static_cast<int>(v);
            }
        }
    } else if (type_sv == "message_delta") {
        simdjson::ondemand::value usage;
        if (doc["usage"].get(usage) == simdjson::SUCCESS) {
            int64_t v = 0;
            if (usage["output_tokens"].get(v) == simdjson::SUCCESS) ctx.completion_tokens = static_cast<int>(v);
        }
    } else if (type_sv == "message_stop") {
        ctx.done_seen = true;
    } else if (type_sv == "error") {
        simdjson::ondemand::value err;
        if (doc["error"].get(err) == simdjson::SUCCESS) {
            std::string_view msg;
            if (err["message"].get(msg) == simdjson::SUCCESS) ctx.error_text.assign(msg);
            else ctx.error_text = "Anthropic stream returned error";
        }
        return false;
    }
    return true;
}

// Pull whole SSE frames out of the rolling sse_buffer. Frames are separated
// by a blank line ("\n\n"). For each frame, isolate the `data:` payload
// (Anthropic frames also have `event:` lines we ignore — the event type is
// duplicated inside the JSON's `type` field) and hand it to the per-provider
// applier.
//
// Returns false to request curl to abort the transfer (cancelled or error).
bool drain_frames(stream_ctx& ctx) {
    while (true) {
        const auto delim_pos = ctx.sse_buffer.find("\n\n");
        if (delim_pos == std::string::npos) return true;  // need more bytes
        const std::string frame = ctx.sse_buffer.substr(0, delim_pos);
        ctx.sse_buffer.erase(0, delim_pos + 2);

        // A frame is one or more `field: value` lines. We only care about the
        // (possibly multiple) `data:` lines; concatenate their values.
        std::string data_payload;
        std::size_t line_start = 0;
        while (line_start < frame.size()) {
            std::size_t line_end = frame.find('\n', line_start);
            if (line_end == std::string::npos) line_end = frame.size();
            std::string_view line(frame.data() + line_start, line_end - line_start);
            line_start = line_end + 1;
            if (line.empty() || line[0] == ':') continue;  // blank or comment
            if (line.rfind("data:", 0) == 0) {
                std::string_view val = line.substr(5);
                if (!val.empty() && val.front() == ' ') val.remove_prefix(1);
                if (!data_payload.empty()) data_payload.push_back('\n');
                data_payload.append(val);
            }
            // `event:` and other fields are intentionally ignored — JSON
            // payload carries the type for both providers.
        }
        if (data_payload.empty()) continue;

        const bool keep_going =
            (ctx.provider == API_PROVIDER::Anthropic)
                ? apply_anthropic_frame(ctx, data_payload)
                : apply_openai_frame(ctx, data_payload);
        if (!keep_going) return false;
    }
}

size_t stream_write_cb(void* contents, size_t size, size_t nmemb, void* userp) {
    auto* ctx = static_cast<stream_ctx*>(userp);
    const size_t n = size * nmemb;
    ctx->sse_buffer.append(static_cast<char*>(contents), n);
    if (!drain_frames(*ctx)) return 0;  // returning < n aborts the transfer
    return n;
}

// Mutates payload to set stream-mode flags. Both OpenAI and Anthropic accept
// `stream: true`; OpenAI additionally accepts `stream_options.include_usage`
// which makes the final chunk carry token counts.
void enable_streaming(nlohmann::json& payload, API_PROVIDER p) {
    payload["stream"] = true;
    if (p != API_PROVIDER::Anthropic) {
        payload["stream_options"] = { {"include_usage", true} };
    }
}

} // namespace

void send_chat_stream(const chat_request& req,
                      const std::string& api_key,
                      const stream_delta_cb& on_delta,
                      const stream_reasoning_cb& on_reasoning,
                      const stream_done_cb& on_done) {
    chat_result r;
    if (api_key.empty() && req.provider != API_PROVIDER::Local) {
        r.error = "Missing API key for provider " + provider_to_str(req.provider);
        on_done(r);
        return;
    }

    const std::string url =
        (req.provider == API_PROVIDER::Anthropic) ? std::string(ANTHROPIC_URL) :
        (req.provider == API_PROVIDER::DeepSeek)  ? std::string(DEEPSEEK_URL)  :
        (req.provider == API_PROVIDER::Mistral)   ? std::string(MISTRAL_URL)   :
        (req.provider == API_PROVIDER::Local)     ? resolve_local_url(req)     :
                                                    std::string(OPENAI_URL);

    nlohmann::json payload;
    try {
        payload = build_payload(req);
        enable_streaming(payload, req.provider);
    } catch (const std::exception& e) { r.error = e.what(); on_done(r); return; }

    const std::string payload_str = payload.dump();

    CURL* curl = curl_easy_init();
    if (!curl) { r.error = "curl_easy_init failed"; on_done(r); return; }

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "Accept: text/event-stream");
    if (req.provider == API_PROVIDER::Anthropic) {
        headers = curl_slist_append(headers, "anthropic-version: 2023-06-01");
        const std::string h = "x-api-key: " + api_key;
        headers = curl_slist_append(headers, h.c_str());
    } else if (!api_key.empty()) {
        const std::string h = "Authorization: Bearer " + api_key;
        headers = curl_slist_append(headers, h.c_str());
    }

    stream_ctx ctx;
    ctx.provider     = req.provider;
    ctx.on_delta     = &on_delta;
    ctx.on_reasoning = &on_reasoning;

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload_str.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(payload_str.size()));
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, stream_write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &ctx);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, static_cast<long>(req.timeout_seconds));
    curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2_0);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_TCP_KEEPALIVE, 1L);
    curl_easy_setopt(curl, CURLOPT_BUFFERSIZE, 16384L);

    const auto t0 = std::chrono::steady_clock::now();
    CURLcode rc   = curl_easy_perform(curl);
    const auto t1 = std::chrono::steady_clock::now();
    r.latency_ms  = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    r.http_status       = static_cast<int>(http_code);
    r.content           = std::move(ctx.full_content);
    r.prompt_tokens     = ctx.prompt_tokens;
    r.completion_tokens = ctx.completion_tokens;

    if (ctx.cancelled) {
        r.success = false;
        r.error   = "cancelled by client";
    } else if (!ctx.error_text.empty()) {
        r.success = false;
        r.error   = std::move(ctx.error_text);
    } else if (rc != CURLE_OK) {
        r.success = false;
        r.error   = std::string("HTTP transport error: ") + curl_easy_strerror(rc);
    } else if (!r.content.empty()) {
        r.success = true;
    } else if (!ctx.full_reasoning.empty()) {
        // Reasoning-only output: the model burned every token on its
        // chain-of-thought and never reached a visible answer. Surface the
        // reasoning so the user has SOMETHING to read, and tell them how
        // to fix it.
        r.success = true;
        r.content = "[The model spent all available tokens reasoning and "
                    "didn't reach a final answer. Try a larger max_tokens "
                    "(e.g. 8192+) for reasoning models.]\n\n— Internal "
                    "reasoning that was produced:\n" + ctx.full_reasoning;
    } else {
        r.success = false;
        r.error   = "stream finished with empty content";
    }

    on_done(r);
}

// 4-arg overload: no reasoning channel — reasoning chunks are dropped.
void send_chat_stream(const chat_request& req,
                      const std::string& api_key,
                      const stream_delta_cb& on_delta,
                      const stream_done_cb& on_done) {
    static const stream_reasoning_cb null_cb;
    send_chat_stream(req, api_key, on_delta, null_cb, on_done);
}

} // namespace hyni
