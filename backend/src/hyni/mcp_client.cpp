#include "mcp_client.h"

#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <iostream>
#include <poll.h>
#include <signal.h>
#include <sstream>
#include <string_view>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <curl/curl.h>

extern char **environ;

namespace hyni::mcp {

namespace {

// Split a whitespace-separated args string into argv tokens. Quoting is
// NOT supported (env-var format is deliberately simple — if you need
// quoting, write your own wrapper script).
std::vector<std::string> split_ws(const std::string& s) {
    std::vector<std::string> out;
    std::istringstream is(s);
    std::string tok;
    while (is >> tok) out.push_back(std::move(tok));
    return out;
}

// Split `s` on `delim`, NOT collapsing empty tokens (so "a||b" -> ["a","","b"]).
std::vector<std::string> split(const std::string& s, char delim) {
    std::vector<std::string> out;
    std::size_t start = 0;
    for (std::size_t i = 0; i <= s.size(); ++i) {
        if (i == s.size() || s[i] == delim) {
            out.emplace_back(s.substr(start, i - start));
            start = i + 1;
        }
    }
    return out;
}

bool set_cloexec(int fd) {
    int flags = fcntl(fd, F_GETFD);
    if (flags == -1) return false;
    return fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0;
}

// Read up to `max` bytes into `buf` starting at `*pos`; returns bytes read,
// 0 on EOF, -1 on error.
ssize_t read_some(int fd, char* buf, std::size_t max) {
    while (true) {
        ssize_t n = ::read(fd, buf, max);
        if (n >= 0) return n;
        if (errno == EINTR) continue;
        return -1;
    }
}

// Wait up to `timeout_ms` for `fut` to be ready. Returns true if ready.
template <typename T>
bool wait_for_ms(std::future<T>& fut, int timeout_ms) {
    return fut.wait_for(std::chrono::milliseconds(timeout_ms)) ==
           std::future_status::ready;
}

void log_warn(const std::string& msg) {
    std::cerr << "[hyni.mcp] " << msg << std::endl;
}

} // namespace

// ---------------------------------------------------------------------------
// parse_servers_env
// ---------------------------------------------------------------------------

std::vector<server_spec> parse_servers_env(const std::string& env_value) {
    std::vector<server_spec> out;
    if (env_value.empty()) return out;

    for (const auto& entry : split(env_value, ';')) {
        if (entry.empty()) continue;
        const auto fields = split(entry, '|');
        if (fields.size() < 2) {
            log_warn("ignoring malformed HYNI_MCP_SERVERS entry: " + entry);
            continue;
        }
        server_spec spec;
        spec.name = fields[0];
        const std::string& second = fields[1];
        const bool is_http = (second.rfind("http://", 0) == 0) ||
                             (second.rfind("https://", 0) == 0);
        if (is_http) {
            spec.transport = transport_kind::Http;
            spec.http_url  = second;
            if (fields.size() >= 3) spec.api_key = fields[2];
        } else {
            spec.transport = transport_kind::Stdio;
            spec.command   = second;
            if (fields.size() >= 3) spec.args = split_ws(fields[2]);
            if (fields.size() >= 4) spec.cwd  = fields[3];
        }
        if (spec.name.empty() ||
            (spec.transport == transport_kind::Stdio && spec.command.empty()) ||
            (spec.transport == transport_kind::Http  && spec.http_url.empty())) {
            log_warn("ignoring HYNI_MCP_SERVERS entry with empty name/cmd/url");
            continue;
        }
        out.push_back(std::move(spec));
    }
    return out;
}

namespace {

// libcurl write callback for HTTP transport.
size_t http_curl_write(char* p, size_t s, size_t n, void* ud) {
    static_cast<std::string*>(ud)->append(p, s * n);
    return s * n;
}

// Send one JSON-RPC frame to an HTTP MCP endpoint and return the response
// body. Caller parses (since this helper is used by client::rpc() before
// promise machinery exists for HTTP transport).
struct http_outcome {
    std::string body;
    long        http_status = 0;
    CURLcode    rc          = CURLE_OK;
    std::string error;
};

http_outcome http_post_jsonrpc(const std::string& url,
                               const std::string& payload,
                               int connect_timeout_ms,
                               int read_timeout_ms,
                               const std::string& api_key = {}) {
    http_outcome o;
    CURL* curl = curl_easy_init();
    if (!curl) { o.rc = CURLE_FAILED_INIT; o.error = "curl_easy_init failed"; return o; }
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "Accept: application/json");
    if (!api_key.empty()) {
        const std::string hdr = "X-API-Key: " + api_key;
        headers = curl_slist_append(headers, hdr.c_str());
    }

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(payload.size()));
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, static_cast<long>(connect_timeout_ms));
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS,        static_cast<long>(read_timeout_ms));
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_TCP_KEEPALIVE, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, http_curl_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &o.body);

    o.rc = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &o.http_status);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    if (o.rc != CURLE_OK) o.error = curl_easy_strerror(o.rc);
    return o;
}

} // namespace

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

client::client(server_spec spec) : spec_(std::move(spec)) {}

client::~client() { stop(); }

bool client::start() {
    if (spec_.transport == transport_kind::Http) {
        // No spawn, no reader thread. Just verify the endpoint is reachable
        // by performing the handshake and tools/list synchronously.
        running_.store(true);
        try {
            nlohmann::json init_params = {
                {"protocolVersion", "2024-11-05"},
                {"capabilities",    nlohmann::json::object()},
                {"clientInfo",      {{"name", "hyni.web"}, {"version", "0.1"}}},
            };
            (void)rpc("initialize", init_params, spec_.initialize_timeout_ms);
        } catch (const std::exception& e) {
            last_error_ = std::string("initialize failed: ") + e.what();
            running_.store(false);
            return false;
        }
        // The MCP spec wants an `initialized` notification after `initialize`.
        // For HTTP transport we fire-and-forget (no `id` -> server discards
        // the response).
        try {
            nlohmann::json notif = {
                {"jsonrpc", "2.0"},
                {"method",  "notifications/initialized"},
                {"params",  nlohmann::json::object()},
            };
            http_post_jsonrpc(spec_.http_url, notif.dump(),
                              spec_.connect_timeout_ms,
                              spec_.read_timeout_ms,
                              spec_.api_key);
        } catch (...) { /* ignore — some servers don't require this */ }

        nlohmann::json tools_resp;
        try {
            tools_resp = rpc("tools/list", nlohmann::json::object(),
                             spec_.initialize_timeout_ms);
        } catch (const std::exception& e) {
            last_error_ = std::string("tools/list failed: ") + e.what();
            running_.store(false);
            return false;
        }
        if (!tools_resp.is_object() || !tools_resp.contains("tools") ||
            !tools_resp["tools"].is_array()) {
            last_error_ = "tools/list response shape invalid";
            running_.store(false);
            return false;
        }
        for (const auto& t : tools_resp["tools"]) {
            if (!t.is_object()) continue;
            tool_info ti;
            ti.server_name    = spec_.name;
            ti.raw_name       = t.value("name", "");
            ti.qualified_name = spec_.name + "__" + ti.raw_name;
            ti.description    = t.value("description", "");
            if (t.contains("inputSchema")) ti.input_schema = t["inputSchema"];
            else                            ti.input_schema = nlohmann::json::object();
            if (!ti.raw_name.empty()) tools_.push_back(std::move(ti));
        }
        return true;
    }

    // ---- Stdio transport: original fork/exec path ----------------------
    // Pipes: parent->child stdin, child->parent stdout, child->parent stderr.
    int in_pipe[2]  = {-1, -1};
    int out_pipe[2] = {-1, -1};
    int err_pipe[2] = {-1, -1};
    auto close_all = [&]() {
        for (int* p : {in_pipe, out_pipe, err_pipe}) {
            if (p[0] != -1) ::close(p[0]);
            if (p[1] != -1) ::close(p[1]);
        }
    };
    if (::pipe(in_pipe) || ::pipe(out_pipe) || ::pipe(err_pipe)) {
        last_error_ = std::string("pipe() failed: ") + std::strerror(errno);
        close_all();
        return false;
    }

    pid_t pid = ::fork();
    if (pid < 0) {
        last_error_ = std::string("fork() failed: ") + std::strerror(errno);
        close_all();
        return false;
    }
    if (pid == 0) {
        // Child.
        ::dup2(in_pipe[0],  STDIN_FILENO);
        ::dup2(out_pipe[1], STDOUT_FILENO);
        ::dup2(err_pipe[1], STDERR_FILENO);
        ::close(in_pipe[0]);  ::close(in_pipe[1]);
        ::close(out_pipe[0]); ::close(out_pipe[1]);
        ::close(err_pipe[0]); ::close(err_pipe[1]);

        if (!spec_.cwd.empty()) {
            if (::chdir(spec_.cwd.c_str()) != 0) {
                std::cerr << "[mcp child] chdir(" << spec_.cwd
                          << ") failed: " << std::strerror(errno) << '\n';
                ::_exit(127);
            }
        }
        for (const auto& [k, v] : spec_.extra_env) {
            ::setenv(k.c_str(), v.c_str(), 1);
        }

        std::vector<char*> argv;
        argv.reserve(spec_.args.size() + 2);
        argv.push_back(const_cast<char*>(spec_.command.c_str()));
        for (const auto& a : spec_.args) argv.push_back(const_cast<char*>(a.c_str()));
        argv.push_back(nullptr);

        ::execvp(spec_.command.c_str(), argv.data());
        std::cerr << "[mcp child] execvp(" << spec_.command
                  << ") failed: " << std::strerror(errno) << '\n';
        ::_exit(127);
    }

    // Parent: keep our ends, close the child's ends.
    ::close(in_pipe[0]);
    ::close(out_pipe[1]);
    ::close(err_pipe[1]);
    stdin_fd_  = in_pipe[1];
    stdout_fd_ = out_pipe[0];
    stderr_fd_ = err_pipe[0];
    child_pid_ = pid;
    set_cloexec(stdin_fd_);
    set_cloexec(stdout_fd_);
    set_cloexec(stderr_fd_);

    running_.store(true);
    reader_ = std::thread([this]() { reader_loop(); });

    // Handshake (initialize + initialized + tools/list).
    nlohmann::json init_params = {
        {"protocolVersion", "2024-11-05"},
        {"capabilities",    nlohmann::json::object()},
        {"clientInfo",      {{"name", "hyni.web"}, {"version", "0.1"}}},
    };
    try {
        (void)rpc("initialize", init_params, spec_.initialize_timeout_ms);
    } catch (const std::exception& e) {
        last_error_ = std::string("initialize failed: ") + e.what();
        stop();
        return false;
    }

    nlohmann::json notif = {
        {"jsonrpc", "2.0"},
        {"method",  "notifications/initialized"},
        {"params",  nlohmann::json::object()},
    };
    write_message(notif);

    nlohmann::json tools_resp;
    try {
        tools_resp = rpc("tools/list", nlohmann::json::object(),
                         spec_.initialize_timeout_ms);
    } catch (const std::exception& e) {
        last_error_ = std::string("tools/list failed: ") + e.what();
        stop();
        return false;
    }
    if (!tools_resp.is_object() || !tools_resp.contains("tools") ||
        !tools_resp["tools"].is_array()) {
        last_error_ = "tools/list response shape invalid";
        stop();
        return false;
    }
    for (const auto& t : tools_resp["tools"]) {
        if (!t.is_object()) continue;
        tool_info ti;
        ti.server_name    = spec_.name;
        ti.raw_name       = t.value("name", "");
        ti.qualified_name = spec_.name + "__" + ti.raw_name;
        ti.description    = t.value("description", "");
        if (t.contains("inputSchema")) ti.input_schema = t["inputSchema"];
        else                            ti.input_schema = nlohmann::json::object();
        if (!ti.raw_name.empty()) tools_.push_back(std::move(ti));
    }

    return true;
}

void client::stop() {
    if (spec_.transport == transport_kind::Http) {
        // HTTP transport has no child process or reader thread to tear
        // down. Just flip the flag so subsequent rpc() calls fail fast.
        running_.store(false);
        return;
    }

    const bool was_running = running_.exchange(false);

    // Close pipes (idempotent). Closing the stdout fd causes the reader's
    // blocked read() to return -1, which unblocks the join() below.
    if (stdin_fd_  != -1) { ::close(stdin_fd_);  stdin_fd_  = -1; }
    if (stdout_fd_ != -1) { ::close(stdout_fd_); stdout_fd_ = -1; }
    if (stderr_fd_ != -1) { ::close(stderr_fd_); stderr_fd_ = -1; }

    // Fail every pending promise (no-op on a second stop() call — the
    // map is empty).
    if (was_running) {
        std::lock_guard<std::mutex> g(pending_mtx_);
        for (auto& [_id, prom] : pending_) {
            try { prom.set_exception(std::make_exception_ptr(
                std::runtime_error("client stopped"))); } catch (...) {}
        }
        pending_.clear();
    }

    if (child_pid_ > 0) {
        ::kill(child_pid_, SIGTERM);
        for (int i = 0; i < 20; ++i) {
            int status = 0;
            const pid_t r = ::waitpid(child_pid_, &status, WNOHANG);
            if (r == child_pid_) break;
            if (r < 0)            break;
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            if (i == 19) ::kill(child_pid_, SIGKILL);
        }
        child_pid_ = -1;
    }

    // CRITICAL: always join if joinable, regardless of whether running_
    // was already false. If the child failed to start, the reader_loop
    // hit EOF and exited on its own — running_ is already false but the
    // thread is still joinable. ~std::thread() on a joinable thread
    // calls std::terminate. So join here unconditionally.
    if (reader_.joinable()) reader_.join();
}

bool client::write_message(const nlohmann::json& obj) {
    if (stdin_fd_ < 0) return false;
    std::lock_guard<std::mutex> g(write_mtx_);
    const std::string line = obj.dump() + "\n";
    std::size_t written = 0;
    while (written < line.size()) {
        const ssize_t n = ::write(stdin_fd_, line.data() + written,
                                  line.size() - written);
        if (n < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        if (n == 0) return false;
        written += static_cast<std::size_t>(n);
    }
    return true;
}

void client::reader_loop() {
    constexpr std::size_t BUF = 8192;
    std::vector<char> buf(BUF);
    std::string acc;

    while (running_.load() && stdout_fd_ >= 0) {
        const ssize_t n = read_some(stdout_fd_, buf.data(), BUF);
        if (n < 0) break;        // error
        if (n == 0) break;       // EOF — child exited
        acc.append(buf.data(), static_cast<std::size_t>(n));

        // Split on newlines and process each complete line.
        std::size_t start = 0;
        while (true) {
            const auto nl = acc.find('\n', start);
            if (nl == std::string::npos) break;
            const std::string_view line(acc.data() + start, nl - start);
            start = nl + 1;
            if (line.empty()) continue;

            nlohmann::json msg;
            try { msg = nlohmann::json::parse(line); }
            catch (const std::exception& e) {
                log_warn(std::string("bad JSON from ") + spec_.name + ": " + e.what());
                continue;
            }
            // Responses carry an `id`. Notifications don't — ignore for now.
            if (!msg.contains("id") || msg["id"].is_null()) continue;
            int64_t id = 0;
            try { id = msg["id"].get<int64_t>(); } catch (...) { continue; }

            std::promise<nlohmann::json> p;
            bool found = false;
            {
                std::lock_guard<std::mutex> g(pending_mtx_);
                auto it = pending_.find(id);
                if (it != pending_.end()) {
                    p = std::move(it->second);
                    pending_.erase(it);
                    found = true;
                }
            }
            if (!found) continue;

            if (msg.contains("error") && !msg["error"].is_null()) {
                const auto& e = msg["error"];
                const std::string m = e.contains("message") && e["message"].is_string()
                    ? e["message"].get<std::string>() : "rpc error";
                try { p.set_exception(std::make_exception_ptr(std::runtime_error(m))); } catch (...) {}
            } else {
                nlohmann::json res = msg.contains("result") ? msg["result"]
                                                            : nlohmann::json::object();
                try { p.set_value(std::move(res)); } catch (...) {}
            }
        }
        acc.erase(0, start);
        if (acc.size() > (1u << 20)) {
            log_warn("dropping oversized accumulator for " + spec_.name);
            acc.clear();
        }
    }

    // Reader exit -> mark as not running and fail pending.
    running_.store(false);
    std::lock_guard<std::mutex> g(pending_mtx_);
    for (auto& [_id, prom] : pending_) {
        try { prom.set_exception(std::make_exception_ptr(
            std::runtime_error("child stdout closed"))); } catch (...) {}
    }
    pending_.clear();
}

nlohmann::json client::rpc(const std::string& method,
                           const nlohmann::json& params,
                           int timeout_ms) {
    if (!running_.load()) throw std::runtime_error("client not running");
    const int64_t id = next_id_.fetch_add(1);

    nlohmann::json req = {
        {"jsonrpc", "2.0"},
        {"id",      id},
        {"method",  method},
        {"params",  params},
    };

    // HTTP transport: one synchronous POST per RPC. No promise/future
    // machinery needed; the server's response IS the response. Read
    // timeout is taken from the spec, not the per-call argument (which
    // is the handshake timeout — irrelevant here).
    if (spec_.transport == transport_kind::Http) {
        const int read_to = std::max(timeout_ms, spec_.read_timeout_ms);
        const auto out = http_post_jsonrpc(spec_.http_url, req.dump(),
                                          spec_.connect_timeout_ms,
                                          read_to,
                                          spec_.api_key);
        if (out.rc != CURLE_OK) {
            throw std::runtime_error(std::string("HTTP transport error: ") + out.error);
        }
        if (out.http_status < 200 || out.http_status >= 300) {
            throw std::runtime_error("HTTP " + std::to_string(out.http_status) +
                                     " from " + spec_.http_url);
        }
        if (out.body.empty()) throw std::runtime_error("empty response");
        nlohmann::json resp;
        try { resp = nlohmann::json::parse(out.body); }
        catch (const std::exception& e) {
            throw std::runtime_error(std::string("invalid JSON response: ") + e.what());
        }
        if (resp.contains("error") && !resp["error"].is_null()) {
            const std::string m = resp["error"].value("message", "rpc error");
            throw std::runtime_error(m);
        }
        return resp.contains("result") ? resp["result"] : nlohmann::json::object();
    }

    // Stdio transport: write the frame, wait for the reader thread to
    // fulfil the matching promise.
    std::promise<nlohmann::json> prom;
    std::future<nlohmann::json>  fut = prom.get_future();
    {
        std::lock_guard<std::mutex> g(pending_mtx_);
        pending_.emplace(id, std::move(prom));
    }
    if (!write_message(req)) {
        std::lock_guard<std::mutex> g(pending_mtx_);
        pending_.erase(id);
        throw std::runtime_error("write_message failed");
    }
    if (!wait_for_ms(fut, timeout_ms)) {
        std::lock_guard<std::mutex> g(pending_mtx_);
        pending_.erase(id);
        throw std::runtime_error("rpc timeout: " + method);
    }
    return fut.get();
}

call_result client::call(const std::string& raw_name, const nlohmann::json& args) {
    call_result r;
    nlohmann::json params = {
        {"name",      raw_name},
        {"arguments", args.is_null() ? nlohmann::json::object() : args},
    };
    try {
        nlohmann::json res = rpc("tools/call", params, spec_.call_timeout_ms);
        r.raw_content = res.contains("content") ? res["content"] : nlohmann::json::array();
        r.is_error    = res.value("isError", false);

        // Flatten text content items.
        std::ostringstream os;
        if (r.raw_content.is_array()) {
            bool first = true;
            for (const auto& c : r.raw_content) {
                if (!c.is_object()) continue;
                const std::string type = c.value("type", "");
                if (type == "text") {
                    if (!first) os << "\n";
                    os << c.value("text", "");
                    first = false;
                }
                // image / resource types: leave them in raw_content for the UI.
            }
        }
        r.content_text = os.str();
        if (r.is_error && r.content_text.empty()) r.content_text = "(tool reported an error)";
        if (r.is_error) r.error_message = r.content_text;
    } catch (const std::exception& e) {
        r.is_error      = true;
        r.error_message = e.what();
        r.content_text  = std::string("[tool error] ") + e.what();
    }
    return r;
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

namespace {

std::mutex& reg_mtx() {
    static std::mutex m;
    return m;
}

std::vector<std::unique_ptr<client>>& reg_clients() {
    static std::vector<std::unique_ptr<client>> v;
    return v;
}

} // namespace

std::size_t registry::startup(const std::vector<server_spec>& specs) {
    std::lock_guard<std::mutex> g(reg_mtx());
    auto& clients = reg_clients();
    std::size_t up = 0;
    for (const auto& s : specs) {
        auto c = std::make_unique<client>(s);
        if (!c->start()) {
            log_warn("MCP server '" + s.name + "' failed: " + c->last_error());
            continue;
        }
        log_warn("MCP server '" + s.name + "' up with " +
                 std::to_string(c->tools().size()) + " tool(s)");
        clients.push_back(std::move(c));
        ++up;
    }
    return up;
}

void registry::shutdown() {
    std::lock_guard<std::mutex> g(reg_mtx());
    for (auto& c : reg_clients()) c->stop();
    reg_clients().clear();
}

std::vector<tool_info> registry::tools() {
    std::lock_guard<std::mutex> g(reg_mtx());
    std::vector<tool_info> out;
    for (const auto& c : reg_clients()) {
        if (!c->alive()) continue;
        for (const auto& t : c->tools()) out.push_back(t);
    }
    return out;
}

nlohmann::json registry::tools_openai_schema() {
    auto ts = tools();
    nlohmann::json out = nlohmann::json::array();
    for (const auto& t : ts) {
        out.push_back({
            {"type", "function"},
            {"function", {
                {"name",        t.qualified_name},
                {"description", t.description},
                {"parameters",  t.input_schema.is_null()
                                  ? nlohmann::json::object()
                                  : t.input_schema},
            }},
        });
    }
    return out;
}

call_result registry::call(const std::string& qualified_name,
                           const nlohmann::json& args) {
    // Split "<server>__<tool>". MCP tool names can themselves contain
    // underscores, so we split on the FIRST "__".
    const auto sep = qualified_name.find("__");
    if (sep == std::string::npos) {
        call_result r;
        r.is_error = true;
        r.error_message = "qualified tool name missing '__' separator: " + qualified_name;
        r.content_text  = r.error_message;
        return r;
    }
    const std::string server = qualified_name.substr(0, sep);
    const std::string raw    = qualified_name.substr(sep + 2);

    client* target = nullptr;
    {
        std::lock_guard<std::mutex> g(reg_mtx());
        for (auto& c : reg_clients()) {
            if (c->name() == server && c->alive()) { target = c.get(); break; }
        }
    }
    if (!target) {
        call_result r;
        r.is_error = true;
        r.error_message = "unknown MCP server: " + server;
        r.content_text  = r.error_message;
        return r;
    }
    return target->call(raw, args);
}

bool registry::any_alive() {
    std::lock_guard<std::mutex> g(reg_mtx());
    for (auto& c : reg_clients()) if (c->alive()) return true;
    return false;
}

} // namespace hyni::mcp
