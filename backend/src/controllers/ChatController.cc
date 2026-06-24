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
    p.strengths    = get_str(profile_val, "strengths");
    p.weaknesses   = get_str(profile_val, "weaknesses");
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

void ChatController::getConfig(const drogon::HttpRequestPtr& /*req*/,
                               std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    json body;
    body["providers"] = json::array();

    auto add = [&](hyni::API_PROVIDER p) {
        json entry;
        entry["id"]            = hyni::provider_to_str(p);
        entry["default_model"] = hyni::default_model(p);
        entry["has_key"]       = !api_key_for(p).empty();
        body["providers"].push_back(std::move(entry));
    };
    add(hyni::API_PROVIDER::OpenAI);
    add(hyni::API_PROVIDER::Anthropic);
    add(hyni::API_PROVIDER::DeepSeek);
    add(hyni::API_PROVIDER::Mistral);

    body["modes"] = {"general", "coding", "behavioral"};
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

    const std::string api_key = api_key_for(cr.provider);
    if (api_key.empty()) {
        callback(error_response(
            "No API key configured for provider " + hyni::provider_to_str(cr.provider) +
                ". Set the corresponding *_API_KEY environment variable.",
            drogon::k400BadRequest));
        return;
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
    const std::string api_key = api_key_for(cr.provider);
    if (api_key.empty()) {
        callback(error_response(
            "No API key configured for provider " + hyni::provider_to_str(cr.provider),
            drogon::k400BadRequest));
        return;
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
