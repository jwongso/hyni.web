#include "ChatController.h"
#include "../hyni/web_client.h"

#include <cstdlib>
#include <string>
#include <nlohmann/json.hpp>

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

hyni::user_profile parse_profile(const json& j) {
    hyni::user_profile p;
    if (!j.is_object()) return p;
    p.resume_text  = j.value("resume_text",  "");
    p.target_role  = j.value("target_role",  "");
    p.strengths    = j.value("strengths",    "");
    p.weaknesses   = j.value("weaknesses",   "");
    p.extra_notes  = j.value("extra_notes",  "");
    return p;
}

std::vector<hyni::image_data> parse_images(const json& j) {
    std::vector<hyni::image_data> out;
    if (!j.is_array()) return out;
    out.reserve(j.size());
    for (const auto& it : j) {
        hyni::image_data img;
        img.image_base64 = it.value("image_base64", "");
        img.mime_type    = it.value("mime_type",    "image/jpeg");
        if (img.is_valid()) out.push_back(std::move(img));
    }
    return out;
}

std::vector<hyni::chat_message> parse_history(const json& j) {
    std::vector<hyni::chat_message> out;
    if (!j.is_array()) return out;
    out.reserve(j.size());
    for (const auto& it : j) {
        hyni::chat_message m;
        m.role   = it.value("role", "");
        m.text   = it.value("text", "");
        if (it.contains("images")) m.images = parse_images(it["images"]);
        if (m.role == "user" || m.role == "assistant") out.push_back(std::move(m));
    }
    return out;
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

    body["modes"] = {"general", "coding", "behavioral"};
    callback(json_response(body));
}

void ChatController::postChat(const drogon::HttpRequestPtr& req,
                              std::function<void(const drogon::HttpResponsePtr&)>&& callback) {
    json body;
    try {
        body = json::parse(req->getBody());
    } catch (const std::exception& e) {
        callback(error_response(std::string("Invalid JSON body: ") + e.what(),
                                drogon::k400BadRequest));
        return;
    }

    hyni::chat_request cr;
    cr.provider     = hyni::provider_from_str(body.value("provider", "openai"));
    cr.model        = body.value("model", "");
    cr.mode         = hyni::mode_from_str(body.value("mode", "general"));
    cr.user_message = body.value("message", "");
    cr.temperature  = body.value("temperature", 0.7);
    cr.max_tokens   = body.value("max_tokens", 4096);

    if (body.contains("profile"))  cr.profile = parse_profile(body["profile"]);
    if (body.contains("history"))  cr.history = parse_history(body["history"]);
    if (body.contains("images"))   cr.images  = parse_images(body["images"]);

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

} // namespace hyniweb
