#pragma once

#include <drogon/HttpController.h>

namespace hyniweb {

// REST endpoints:
//   GET  /api/config        -> which providers have keys, defaults
//   POST /api/chat          -> stateless chat completion
class ChatController : public drogon::HttpController<ChatController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(ChatController::getConfig, "/api/config",        drogon::Get,     drogon::Options);
    ADD_METHOD_TO(ChatController::postChat,  "/api/chat",          drogon::Post,    drogon::Options);
    METHOD_LIST_END

    void getConfig(const drogon::HttpRequestPtr& req,
                   std::function<void(const drogon::HttpResponsePtr&)>&& callback);

    void postChat(const drogon::HttpRequestPtr& req,
                  std::function<void(const drogon::HttpResponsePtr&)>&& callback);
};

} // namespace hyniweb
