#include "ChatController.h"
#include "../hyni/web_client.h"

#include <cstdlib>
#include <string>
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

    body["modes"]              = {"general", "coding", "behavioral"};
    body["owner_mode_enabled"] = owner_mode;
    body["is_owner"]           = owner;
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
    if (key_pick.key.empty()) {
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
    if (key_pick.key.empty()) {
        const std::string msg = owner_mode_enabled()
            ? "This deployment requires you to supply your own API key in Settings."
            : "No API key configured for provider " + hyni::provider_to_str(cr.provider);
        callback(error_response(msg, drogon::k402PaymentRequired));
        return;
    }
    const std::string api_key = key_pick.key;

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
                        // on_delta: forward each text chunk as an SSE frame.
                        // Return value (false = client disconnected) is
                        // honoured by web_client to abort the upstream call.
                        [&](std::string_view delta) {
                            return send_frame({{"delta", std::string(delta)}});
                        },
                        // on_done: emit final frame with usage / status / error
                        // and gracefully close the chunked transfer.
                        [&](const hyni::chat_result& r) {
                            send_frame({
                                {"done",         true},
                                {"success",      r.success},
                                {"error",        r.error},
                                {"latency_ms",   r.latency_ms},
                                {"http_status",  r.http_status},
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

} // namespace hyniweb
