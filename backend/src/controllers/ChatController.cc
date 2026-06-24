#include "ChatController.h"
#include "../hyni/web_client.h"
#include "../hyni/mcp_client.h"

#include <cstdlib>
#include <map>
#include <string>
#include <vector>
#include <utility>
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <simdjson.h>

using json = nlohmann::json;
using drogon::HttpResponse;
using drogon::HttpStatusCode;

namespace hyniweb {

namespace {

std::string getenv_str(const char* name) {
    const char* v = std::getenv(name);
    return v ? std::string(v) : std::string();
}

std::string api_key_for(hyni::API_PROVIDER p) {
    switch (p) {
    case hyni::API_PROVIDER::OpenAI:    return getenv_str("OPENAI_API_KEY");
    case hyni::API_PROVIDER::Anthropic: return getenv_str("ANTHROPIC_API_KEY");
    case hyni::API_PROVIDER::DeepSeek:  return getenv_str("DEEPSEEK_API_KEY");
    case hyni::API_PROVIDER::Mistral:   return getenv_str("MISTRAL_API_KEY");
    // Local is auth-less by default; LOCAL_LLM_API_KEY is only needed if the
    // user fronts their llama.cpp / vLLM with an auth proxy.
    case hyni::API_PROVIDER::Local:     return getenv_str("LOCAL_LLM_API_KEY");
    default:                             return "";
    }
}

// Constant-time string comparison so a timing side-channel cannot leak the
// owner token character-by-character. Only relevant if hyni is exposed to
// the public internet (Cloudflare Tunnel), but cheap to do right.
bool ct_equal(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    unsigned int diff = 0;
    for (std::size_t i = 0; i < a.size(); ++i) {
        diff |= static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i]);
    }
    return diff == 0;
}

// Pull the bearer token (if any) out of the Authorization header.
std::string bearer_token(const drogon::HttpRequestPtr& req) {
    const auto& auth = req->getHeader("authorization");
    if (auth.size() < 7) return "";
    if (auth.compare(0, 7, "Bearer ") != 0 && auth.compare(0, 7, "bearer ") != 0) return "";
    return auth.substr(7);
}

bool is_owner(const drogon::HttpRequestPtr& req) {
    const std::string expected = getenv_str("HYNI_OWNER_TOKEN");
    if (expected.empty()) return true;          // open mode → everyone is "owner"
    const std::string supplied = bearer_token(req);
    if (supplied.empty()) return false;
    return ct_equal(expected, supplied);
}

bool owner_mode_enabled() {
    return !getenv_str("HYNI_OWNER_TOKEN").empty();
}

// Pick the API key to use for a single request.
//   1. client_api_key (from request body) is always allowed and wins
//   2. otherwise, server env var IF the request is owner (or open mode)
//   3. otherwise, empty string (caller rejects with 402)
struct key_choice {
    std::string key;
    std::string source;   // "client" | "server" | "" if none
};

key_choice resolve_api_key(const hyni::chat_request& cr,
                           const drogon::HttpRequestPtr& req) {
    if (!cr.client_api_key.empty()) return {cr.client_api_key, "client"};
    // Local provider works without an API key (auth-less by default). Treat
    // it as 'server' so the request flows; if LOCAL_LLM_API_KEY is set we
    // pick that up too.
    if (cr.provider == hyni::API_PROVIDER::Local) {
        return {api_key_for(cr.provider), "server"};   // may be ""
    }
    if (is_owner(req)) {
        const std::string server_key = api_key_for(cr.provider);
        if (!server_key.empty()) return {server_key, "server"};
    }
    return {"", ""};
}

drogon::HttpResponsePtr json_response(const json& body, HttpStatusCode code = drogon::k200OK) {
    auto resp = HttpResponse::newHttpResponse();
    resp->setStatusCode(code);
    resp->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    resp->setBody(body.dump());
    return resp;
}

drogon::HttpResponsePtr error_response(const std::string& msg, HttpStatusCode code) {
    return json_response({{"error", msg}}, code);
}

// --- simdjson on-demand request parsers --------------------------------------
//
// All helpers take a parent simdjson::ondemand::value and extract our typed
// structs out of it. They never throw; missing fields silently default to
// empty / 0 / "" so partial requests are tolerated.

inline std::string sv_to_string(std::string_view sv) { return {sv.data(), sv.size()}; }

inline std::string get_str(simdjson::ondemand::value parent,
                           std::string_view field,
                           std::string_view def = "") {
    std::string_view sv;
    return (parent[field].get(sv) == simdjson::SUCCESS)
               ? sv_to_string(sv)
               : sv_to_string(def);
}

inline double get_double(simdjson::ondemand::value parent,
                         std::string_view field, double def) {
    double v;
    return (parent[field].get(v) == simdjson::SUCCESS) ? v : def;
}

inline int get_int(simdjson::ondemand::value parent,
                   std::string_view field, int def) {
    int64_t v;
    return (parent[field].get(v) == simdjson::SUCCESS) ? static_cast<int>(v) : def;
}

hyni::user_profile parse_profile(simdjson::ondemand::value profile_val) {
    hyni::user_profile p;
    p.resume_text  = get_str(profile_val, "resume_text");
    p.target_role  = get_str(profile_val, "target_role");
    p.extra_notes  = get_str(profile_val, "extra_notes");
    return p;
}

std::vector<hyni::image_data> parse_images(simdjson::ondemand::array images_arr) {
    std::vector<hyni::image_data> out;
    for (auto el : images_arr) {
        simdjson::ondemand::value v;
        if (el.get(v) != simdjson::SUCCESS) continue;
        hyni::image_data img;
        img.image_base64 = get_str(v, "image_base64");
        img.mime_type    = get_str(v, "mime_type", "image/jpeg");
        if (img.is_valid()) out.push_back(std::move(img));
    }
    return out;
}

std::vector<hyni::chat_message> parse_history(simdjson::ondemand::array hist_arr) {
    std::vector<hyni::chat_message> out;
    for (auto el : hist_arr) {
        simdjson::ondemand::value v;
        if (el.get(v) != simdjson::SUCCESS) continue;
        hyni::chat_message m;
        m.role = get_str(v, "role");
        m.text = get_str(v, "text");
        // images on history messages — order matters in on-demand, so we
        // read it last.
        simdjson::ondemand::array imgs;
        if (v["images"].get_array().get(imgs) == simdjson::SUCCESS) {
            m.images = parse_images(imgs);
        }
        if (m.role == "user" || m.role == "assistant") out.push_back(std::move(m));
    }
    return out;
}

// Parses the /api/chat[ /stream ] request body into a chat_request.
// Returns true on success; on failure sets `err` and returns false.
//
// On-demand cursor advances forward only, so we read fields in the canonical
// order the frontend sends them. nlohmann would have been simpler but this
// keeps everything on the simdjson fast path.
bool parse_chat_request(const std::string& body,
                        hyni::chat_request& out,
                        std::string& err) {
    static thread_local simdjson::ondemand::parser parser;  // reused per thread
    simdjson::padded_string padded(body);
    simdjson::ondemand::document doc;
    if (auto e = parser.iterate(padded).get(doc); e) {
        err = std::string("Invalid JSON body: ") + simdjson::error_message(e);
        return false;
    }
    simdjson::ondemand::value root;
    if (auto e = doc.get_value().get(root); e) {
        err = std::string("Invalid JSON body root: ") + simdjson::error_message(e);
        return false;
    }

    out.provider     = hyni::provider_from_str(get_str(root, "provider", "openai"));
    out.model        = get_str(root, "model");
    out.mode         = hyni::mode_from_str(get_str(root, "mode", "general"));
    out.user_message = get_str(root, "message");
    out.temperature  = get_double(root, "temperature", 0.7);
    out.max_tokens   = get_int(root,    "max_tokens", 4096);
    out.client_api_key = get_str(root, "api_key");
    out.local_url      = get_str(root, "local_url");

    simdjson::ondemand::value profile_val;
    if (root["profile"].get(profile_val) == simdjson::SUCCESS) {
        out.profile = parse_profile(profile_val);
    }
    simdjson::ondemand::array history_arr;
    if (root["history"].get_array().get(history_arr) == simdjson::SUCCESS) {
        out.history = parse_history(history_arr);
    }
    simdjson::ondemand::array images_arr;
    if (root["images"].get_array().get(images_arr) == simdjson::SUCCESS) {
        out.images = parse_images(images_arr);
    }
    return true;
}

} // namespace

void ChatController::getConfig(const drogon::HttpRequestPtr& req,
                               std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    const bool owner_mode = owner_mode_enabled();
    const bool owner      = is_owner(req);

    json body;
    body["providers"] = json::array();
    auto add = [&](hyni::API_PROVIDER p) {
        json entry;
        entry["id"]            = hyni::provider_to_str(p);
        entry["default_model"] = hyni::default_model(p);
        // `has_key` reflects the EFFECTIVE availability of a server-side key
        // for THIS request: only true if the request is owner-authorised (or
        // open mode is in effect).
        entry["has_key"]       = owner && !api_key_for(p).empty();
        // Curated model catalogue — frontend renders as a dropdown.
        json models = json::array();
        for (const auto& m : hyni::list_models(p)) {
            models.push_back({
                {"id", m.id},
                {"label", m.label},
                {"vision", m.vision},
            });
        }
        entry["models"] = std::move(models);
        body["providers"].push_back(std::move(entry));
    };
    add(hyni::API_PROVIDER::OpenAI);
    add(hyni::API_PROVIDER::Anthropic);
    add(hyni::API_PROVIDER::DeepSeek);
    add(hyni::API_PROVIDER::Mistral);
    add(hyni::API_PROVIDER::Local);

    body["modes"]              = {"general", "coding", "behavioral"};
    body["owner_mode_enabled"] = owner_mode;
    body["is_owner"]           = owner;

    // MCP tools summary so the frontend can show a "🛠 N tools" pill in
    // the Chat header. We don't expose the full schema here — too verbose
    // for a config probe. Frontend can hit a dedicated endpoint later
    // when we add a Settings panel for it.
    {
        json mcp = json::object();
        json servers = json::array();
        std::size_t total_tools = 0;
        for (const auto& t : hyni::mcp::registry::tools()) {
            total_tools += 1;
            // Group by server name in a tiny aggregation pass.
            (void)t.server_name; // suppress -Wunused if compiled out
        }
        // Per-server view: collapse the tool list to a name + count.
        std::map<std::string, int> per_server;
        for (const auto& t : hyni::mcp::registry::tools()) ++per_server[t.server_name];
        for (const auto& [name, count] : per_server) {
            servers.push_back({{"name", name}, {"tool_count", count}});
        }
        mcp["enabled"]      = hyni::mcp::registry::any_alive();
        mcp["server_count"] = static_cast<int>(per_server.size());
        mcp["tool_count"]   = static_cast<int>(total_tools);
        mcp["servers"]      = std::move(servers);
        body["mcp"]         = std::move(mcp);
    }

    callback(json_response(body));
}

void ChatController::postChat(const drogon::HttpRequestPtr& req,
                              std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    hyni::chat_request cr;
    std::string err;
    if (!parse_chat_request(std::string(req->getBody()), cr, err)) {
        callback(error_response(err, drogon::k400BadRequest));
        return;
    }

    if (cr.provider == hyni::API_PROVIDER::Unknown) {
        callback(error_response("Unknown provider", drogon::k400BadRequest));
        return;
    }
    if (cr.user_message.empty() && cr.images.empty()) {
        callback(error_response("message or images required", drogon::k400BadRequest));
        return;
    }

    const auto key_pick = resolve_api_key(cr, req);
    // Local provider is auth-less by default — an empty key is fine.
    // Owner-mode lockdown does NOT gate Local either, since the upstream
    // server is on localhost and costs nothing.
    if (key_pick.key.empty() && cr.provider != hyni::API_PROVIDER::Local) {
        const std::string msg = owner_mode_enabled()
            ? "This deployment requires you to supply your own API key. Open "
              "Settings, add a key for '" + hyni::provider_to_str(cr.provider) +
              "', and try again. (Or enter the owner token if you have one.)"
            : "No API key configured for provider " + hyni::provider_to_str(cr.provider) +
              ". Set the corresponding *_API_KEY environment variable or send "
              "an `api_key` field in the request body.";
        callback(error_response(msg, drogon::k402PaymentRequired));
        return;
    }
    const std::string api_key = key_pick.key;

    // Attach the MCP tool catalogue when at least one server is alive.
    // Empty array is harmless — send_chat() short-circuits when there are
    // no tools to advertise.
    if (hyni::mcp::registry::any_alive() && cr.tools.empty()) {
        cr.tools = hyni::mcp::registry::tools_openai_schema();
    }

    // Run blocking libcurl call off the event loop thread.
    drogon::app().getIOLoop(0)->queueInLoop([cr, api_key, callback = std::move(callback)]() mutable {
        hyni::chat_result result = hyni::send_chat(cr, api_key);

        json resp;
        resp["success"]    = result.success;
        resp["content"]    = result.content;
        resp["error"]      = result.error;
        resp["latency_ms"] = result.latency_ms;
        resp["usage"]      = {
            {"prompt_tokens",     result.prompt_tokens},
            {"completion_tokens", result.completion_tokens}
        };
        resp["http_status"] = result.http_status;

        // Surface every tool call so the frontend can render a "tool
        // calls" disclosure under the assistant bubble.
        json tcs = json::array();
        for (const auto& c : result.tool_calls) {
            tcs.push_back({
                {"id",         c.id},
                {"name",       c.name},
                {"arguments",  c.arguments},
                {"result",     c.result_text},
                {"is_error",   c.is_error},
                {"latency_ms", c.latency_ms},
            });
        }
        resp["tool_calls"] = std::move(tcs);

        callback(json_response(resp,
                               result.success ? drogon::k200OK : drogon::k502BadGateway));
    });
}

void ChatController::postChatStream(const drogon::HttpRequestPtr& req,
                                    std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    hyni::chat_request cr;
    std::string err;
    if (!parse_chat_request(std::string(req->getBody()), cr, err)) {
        callback(error_response(err, drogon::k400BadRequest));
        return;
    }
    if (cr.provider == hyni::API_PROVIDER::Unknown) {
        callback(error_response("Unknown provider", drogon::k400BadRequest));
        return;
    }
    if (cr.user_message.empty() && cr.images.empty()) {
        callback(error_response("message or images required", drogon::k400BadRequest));
        return;
    }

    const auto key_pick = resolve_api_key(cr, req);
    if (key_pick.key.empty() && cr.provider != hyni::API_PROVIDER::Local) {
        const std::string msg = owner_mode_enabled()
            ? "This deployment requires you to supply your own API key in Settings."
            : "No API key configured for provider " + hyni::provider_to_str(cr.provider);
        callback(error_response(msg, drogon::k402PaymentRequired));
        return;
    }
    const std::string api_key = key_pick.key;

    // Attach the MCP tool catalogue when at least one server is alive,
    // mirroring postChat. Without this, the streaming path would send
    // NO tools and the model has no way to call them.
    if (hyni::mcp::registry::any_alive() && cr.tools.empty()) {
        cr.tools = hyni::mcp::registry::tools_openai_schema();
    }

    // Async streaming response: Drogon sends Transfer-Encoding: chunked and
    // gives us a ResponseStreamPtr (unique_ptr). We need to forward it through
    // queueInLoop which takes std::function<void()> — and std::function
    // requires copyability, so we wrap the move-only stream in a shared_ptr
    // that the lambda captures by value (copyable).
    auto cr_ptr      = std::make_shared<hyni::chat_request>(std::move(cr));
    auto api_key_ptr = std::make_shared<std::string>(api_key);

    auto resp = HttpResponse::newAsyncStreamResponse(
        [cr_ptr, api_key_ptr](drogon::ResponseStreamPtr stream) {
            // Move the unique_ptr into a shared_ptr so the lambda below can
            // be std::function-stored (copy-constructible).
            auto stream_sp = std::make_shared<drogon::ResponseStreamPtr>(std::move(stream));

            // Long-running libcurl work runs on an IO loop thread.
            drogon::app().getIOLoop(0)->queueInLoop(
                [cr_ptr, api_key_ptr, stream_sp]() {
                    auto send_frame = [&stream_sp](const json& body) -> bool {
                        const std::string chunk = "data: " + body.dump() + "\n\n";
                        return (*stream_sp)->send(chunk);
                    };

                    hyni::send_chat_stream(*cr_ptr, *api_key_ptr,
                        // on_delta: visible answer text — forward as SSE frame.
                        // Return value (false = client disconnected) is
                        // honoured by web_client to abort the upstream call.
                        [&](std::string_view delta) {
                            return send_frame({{"delta", std::string(delta)}});
                        },
                        // on_reasoning: chain-of-thought from reasoning models
                        // (Qwen3 / DeepSeek-R1 / GPT-5). Frontend renders this
                        // in a collapsible "Thinking…" widget — keeping it on
                        // a separate channel prevents the monologue from
                        // polluting the visible answer.
                        [&](std::string_view reasoning) {
                            return send_frame({{"reasoning", std::string(reasoning)}});
                        },
                        // on_tool_call: fired after each MCP tool finishes.
                        // Lets the SPA show a live "🛠 calling …" status pill
                        // and replace it with the result inline. The full
                        // tool_calls log is also re-sent in the done frame so
                        // a late-connecting reader still gets it.
                        [&](const hyni::tool_call_log& c) {
                            return send_frame({{"tool_call", {
                                {"id",         c.id},
                                {"name",       c.name},
                                {"arguments",  c.arguments},
                                {"result",     c.result_text},
                                {"is_error",   c.is_error},
                                {"latency_ms", c.latency_ms},
                            }}});
                        },
                        // on_done: emit final frame with usage / status / error
                        // and gracefully close the chunked transfer.
                        [&](const hyni::chat_result& r) {
                            json tcs = json::array();
                            for (const auto& c : r.tool_calls) {
                                tcs.push_back({
                                    {"id",         c.id},
                                    {"name",       c.name},
                                    {"arguments",  c.arguments},
                                    {"result",     c.result_text},
                                    {"is_error",   c.is_error},
                                    {"latency_ms", c.latency_ms},
                                });
                            }
                            send_frame({
                                {"done",         true},
                                {"success",      r.success},
                                {"error",        r.error},
                                {"latency_ms",   r.latency_ms},
                                {"http_status",  r.http_status},
                                {"tool_calls",   std::move(tcs)},
                                {"usage", {
                                    {"prompt_tokens",     r.prompt_tokens},
                                    {"completion_tokens", r.completion_tokens}
                                }}
                            });
                            (*stream_sp)->close();
                        });
                });
        },
        /*disableKickoffTimeout=*/true);

    resp->setContentTypeCodeAndCustomString(drogon::CT_CUSTOM, "Content-Type: text/event-stream\r\n");
    resp->addHeader("Cache-Control",  "no-cache, no-transform");
    resp->addHeader("X-Accel-Buffering", "no");  // disable buffering at reverse proxies (Cloudflare, nginx)
    callback(resp);
}

// ---- Local LLM scan --------------------------------------------------------
//
// Probes the well-known local-LLM ports for an OpenAI-compatible `/v1/models`
// endpoint. Runs server-side because:
//   1) The SPA is often served over HTTPS (Cloudflare Tunnel) and browsers
//      block mixed-content fetches to http://localhost:....
//   2) Browsers also enforce CORS; most local LLM servers don't set
//      Access-Control-Allow-Origin.
//   3) Server-side libcurl parallelism is just simpler.
//
// We never expose this externally — Local provider is treated as auth-less
// localhost-only by design, so there's no key leak risk. We DO time each
// probe out aggressively (1.5s) so a misbehaving service can't stall the
// caller.

namespace {

struct probe_result {
    std::string url;
    std::string runtime;       // best-guess label (llama.cpp / ollama / ...)
    bool        alive   = false;
    int         http_status = 0;
    std::vector<std::string> models;
    std::string error;
};

// Build the libcurl callback that appends to a std::string.
size_t curl_str_append(char* p, size_t s, size_t n, void* ud) {
    static_cast<std::string*>(ud)->append(p, s * n);
    return s * n;
}

probe_result probe_one(const std::string& base_url, const std::string& runtime_hint) {
    probe_result r;
    r.url     = base_url;
    r.runtime = runtime_hint;

    // OpenAI-compatible servers expose GET /v1/models.
    const std::string url = base_url + "/v1/models";
    std::string body;

    CURL* curl = curl_easy_init();
    if (!curl) { r.error = "curl_easy_init failed"; return r; }
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 1500L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 800L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_str_append);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);

    const CURLcode rc = curl_easy_perform(curl);
    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    curl_easy_cleanup(curl);

    r.http_status = static_cast<int>(http_code);
    if (rc != CURLE_OK) {
        r.error = curl_easy_strerror(rc);
        return r;
    }
    if (http_code != 200 || body.empty()) {
        r.error = "HTTP " + std::to_string(http_code);
        return r;
    }

    // Parse {data: [{id: "...", ...}, ...]} (OpenAI-style). Tolerate Ollama's
    // /api/tags shape too if we ever switch; for now /v1/models is universal.
    try {
        simdjson::ondemand::parser parser;
        simdjson::padded_string padded(body);
        simdjson::ondemand::document doc;
        if (parser.iterate(padded).get(doc) != simdjson::SUCCESS) {
            r.error = "parse error";
            return r;
        }
        simdjson::ondemand::array arr;
        if (doc["data"].get_array().get(arr) != simdjson::SUCCESS) {
            r.error = "no .data";
            return r;
        }
        for (auto el : arr) {
            simdjson::ondemand::value v;
            if (el.get(v) != simdjson::SUCCESS) continue;
            std::string_view id;
            if (v["id"].get(id) == simdjson::SUCCESS) {
                r.models.emplace_back(id.data(), id.size());
            }
        }
        r.alive = true;
    } catch (const std::exception& e) {
        r.error = e.what();
    }
    return r;
}

} // namespace

void ChatController::getLocalScan(const drogon::HttpRequestPtr& /*req*/,
                                  std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    // Well-known local LLM ports. Order: most popular first so the UI
    // shows them naturally. Add or override via the `urls` query param
    // (comma-separated) if you want to scan custom endpoints too.
    const std::vector<std::pair<std::string, std::string>> targets = {
        {"http://localhost:8080",  "llama.cpp"},
        {"http://localhost:11434", "ollama"},
        {"http://localhost:8000",  "vllm"},
        {"http://localhost:1234",  "lm-studio"},
        {"http://localhost:5000",  "text-generation-webui"},
        // Override LOCAL_LLM_URL: if it points somewhere we don't already
        // scan, add it. Stripped of any trailing /v1/chat/completions.
    };

    std::vector<std::pair<std::string, std::string>> work = targets;
    {
        std::string env_url = getenv_str("LOCAL_LLM_URL");
        if (!env_url.empty()) {
            // Strip /v1/... suffix to get a base URL.
            auto pos = env_url.find("/v1");
            if (pos != std::string::npos) env_url = env_url.substr(0, pos);
            bool already = false;
            for (const auto& t : targets) if (t.first == env_url) { already = true; break; }
            if (!already) work.emplace_back(env_url, "configured");
        }
    }

    json out = json::array();
    for (const auto& [url, hint] : work) {
        const probe_result r = probe_one(url, hint);
        json entry;
        entry["url"]         = r.url;
        entry["runtime"]     = r.runtime;
        entry["alive"]       = r.alive;
        entry["http_status"] = r.http_status;
        entry["models"]      = r.models;
        if (!r.error.empty()) entry["error"] = r.error;
        // Suggested URL for the Local provider field (the full chat endpoint).
        entry["chat_url"]    = r.url + "/v1/chat/completions";
        out.push_back(std::move(entry));
    }

    auto resp = HttpResponse::newHttpResponse();
    resp->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    resp->setStatusCode(drogon::k200OK);
    resp->setBody(json{{"candidates", out}}.dump());
    callback(resp);
}

} // namespace hyniweb
