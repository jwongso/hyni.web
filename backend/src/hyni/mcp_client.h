#pragma once

// MCP (Model Context Protocol) stdio client.
//
// Spawns one or more MCP servers as child processes and talks JSON-RPC 2.0
// over their stdin/stdout, framed as newline-delimited JSON (per the MCP
// spec for stdio transport). Each server is identified by a short name
// (e.g. "nz-legal"); tools are exposed under "<name>__<tool>" so multiple
// servers can be merged into one flat tool list for the LLM without
// collisions.
//
// Lifecycle:
//   1.  hyni::mcp::registry::startup(parse_env_var())   // at boot
//   2.  registry::tools()                               // list for LLM
//   3.  registry::call(qualified_tool, args)            // during chat
//   4.  registry::shutdown()                            // at exit
//
// Threading model:
//   - Each server has a reader thread that pulls JSON objects off stdout
//     and matches them to pending requests by `id`.
//   - call() blocks the caller until the matching response arrives OR
//     the per-call timeout fires.
//   - All public registry methods are thread-safe.

#include <cstdint>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>
#include <nlohmann/json.hpp>

namespace hyni::mcp {

// A single tool advertised by a server.
struct tool_info {
    std::string server_name;          // e.g. "nz-legal"
    std::string raw_name;             // e.g. "legal_search"
    std::string qualified_name;       // "<server>__<tool>" for unambiguous LLM dispatch
    std::string description;
    nlohmann::json input_schema;      // JSON Schema for the tool's arguments
};

// Result of one tool call. `is_error` mirrors the MCP `isError` flag;
// `content_text` is the concatenation of all text content items returned
// (MCP supports multi-part content; we flatten to a single string for the
// LLM, which is sufficient for every legal-search workflow).
struct call_result {
    bool        is_error = false;
    std::string content_text;
    nlohmann::json raw_content;       // full content array, in case the UI wants images / structured payloads
    std::string error_message;        // populated when is_error or transport failed
};

enum class transport_kind {
    Stdio,       // child process over stdin/stdout, newline-delimited JSON-RPC
    Http,        // POST {url} with JSON-RPC body, response is the result JSON
};

// Spec for a single server to spawn.
struct server_spec {
    std::string name;                 // short id (must be unique, alphanumeric + _-)
    transport_kind transport = transport_kind::Stdio;

    // Stdio transport: child process to spawn.
    std::string command;              // e.g. "python3"
    std::vector<std::string> args;    // e.g. ["-m", "jurisdictions.nz_legal.mcp_server"]
    std::string cwd;                  // working directory; empty = inherit
    std::vector<std::pair<std::string, std::string>> extra_env;  // appended to inherited env

    // HTTP transport: endpoint URL (POSTed with each JSON-RPC frame).
    // Example: "http://localhost:8001/mcp".
    std::string http_url;
    std::string api_key;                // X-API-Key header value (optional)
    int connect_timeout_ms    = 1500;
    int read_timeout_ms       = 30000;

    int initialize_timeout_ms = 8000; // handshake + tools/list (stdio only)
    int call_timeout_ms       = 30000;
};

// Parse the HYNI_MCP_SERVERS environment variable into a list of server
// specs. Format (one server per ';'-separated entry, fields by '|'):
//
//   STDIO:  name|command|arg1 arg2 ...|cwd
//   HTTP:   name|http://host:port/mcp[|api_key]
//
// HTTP transport is auto-detected when the second field starts with
// `http://` or `https://`. The optional third field is sent as
// X-API-Key on every request.
//
// Examples (in .env):
//   HYNI_MCP_SERVERS=nz-legal|python3|-m jurisdictions.nz_legal.mcp_server|/home/wdha/proj/priv/astraea
//   HYNI_MCP_SERVERS=astraea|http://localhost:8001/mcp|mytoken
//   HYNI_MCP_SERVERS=astraea|http://localhost:8001/mcp|mytoken;stub|python3|backend/tests/fixtures/mcp_stub.py
std::vector<server_spec> parse_servers_env(const std::string& env_value);

// ---- Single-server client --------------------------------------------------

class client {
public:
    explicit client(server_spec spec);
    ~client();
    client(const client&) = delete;
    client& operator=(const client&) = delete;

    /// Spawns the child process, performs the MCP handshake (initialize +
    /// notifications/initialized), and caches the tools/list. Returns true
    /// on success, false on any failure (sets last_error()).
    bool start();

    /// Sends SIGTERM to the child, joins the reader thread, closes pipes.
    /// Idempotent.
    void stop();

    /// The qualified-name list (name__tool) for advertisement to the LLM.
    const std::vector<tool_info>& tools() const { return tools_; }

    /// Invoke a tool by RAW name (not qualified). Blocks for at most
    /// spec.call_timeout_ms.
    call_result call(const std::string& raw_name, const nlohmann::json& args);

    const std::string& name() const       { return spec_.name; }
    const std::string& last_error() const { return last_error_; }
    bool alive() const                    { return running_.load(); }

private:
    // Wire format: newline-delimited JSON. Writes one full JSON object
    // plus a trailing '\n'. Thread-safe (mutex-protected fd).
    bool write_message(const nlohmann::json& obj);

    // Reader thread: pulls lines off the child's stdout, parses each as
    // a JSON-RPC message, and either fulfils a pending promise (response)
    // or logs a notification.
    void reader_loop();

    // Issues a request, waits for the matching response.
    nlohmann::json rpc(const std::string& method,
                       const nlohmann::json& params,
                       int timeout_ms);

    server_spec  spec_;
    int          stdin_fd_  = -1;
    int          stdout_fd_ = -1;
    int          stderr_fd_ = -1;
    pid_t        child_pid_ = -1;
    std::thread  reader_;
    std::atomic<bool> running_{false};
    std::mutex   write_mtx_;
    std::mutex   pending_mtx_;
    std::map<int64_t, std::promise<nlohmann::json>> pending_;
    std::atomic<int64_t> next_id_{1};
    std::vector<tool_info> tools_;
    std::string  last_error_;
};

// ---- Singleton registry across all configured servers ----------------------
//
// In hyni's process model there's exactly one set of MCP servers active for
// the lifetime of the binary, so a singleton is simpler than threading the
// registry through every call site. All methods are thread-safe.

class registry {
public:
    /// Spawn every server in `specs`. Servers that fail to start are
    /// skipped (their `last_error` is logged). Returns the count of
    /// servers that came up healthy.
    static std::size_t startup(const std::vector<server_spec>& specs);

    /// Kill all spawned servers. Safe to call from atexit handlers.
    static void shutdown();

    /// Flattened list of every tool advertised by every alive server.
    /// Order is stable (insertion order of startup()).
    static std::vector<tool_info> tools();

    /// Render the tools array in OpenAI Chat Completions format
    /// ([{type:"function", function:{name, description, parameters}}, ...]).
    /// Returns an empty array when no MCP servers are configured.
    static nlohmann::json tools_openai_schema();

    /// Dispatch a qualified tool call ("<server>__<tool>"). Returns an
    /// error result if the qualified name is unknown.
    static call_result call(const std::string& qualified_name,
                            const nlohmann::json& args);

    /// True when at least one server is alive.
    static bool any_alive();
};

} // namespace hyni::mcp
