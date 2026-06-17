# postmcp 🚀

A high-performance Model Context Protocol (MCP) server written in Node.js (TypeScript) designed for API request automation and automated testing. It features a unified local SQLite database storage allowing LLM agents to manage projects, configure environment variables and credential tokens, run REST and WebSocket requests, evaluate assertions, and audit execution histories.

---

## ✨ Features

- **🗄️ SQLite Unified Storage**: Consolidates projects, profiles, variables, cache tokens, and history logs into `~/.postmcp/postmcp.db` under user-only file permissions (`0600`).
- **📁 Multi-Project Workspaces**: Easily partition different API workspaces (e.g. e-commerce-api, auth-service).
- **⚙️ Environment Profiles**: Configure separate environments (e.g. `dev`, `prod`, `local`) with specific base URLs, headers, cookies, and authentication methods.
- **🔐 Automatic OAuth2 Flow & Token Injection**: Full Support for Bearer Tokens, API Keys, and automated Client Credentials flow for OAuth2 token exchanges with expiration caching.
- **📥 WebSocket persistent connection pool**: Persistent socket clients with message buffering, and regex patterns wait features (block and wait for expected responses).
- **⏱️ Assertion Engine & Diff Engine**: Evaluates request status codes, times, response headers, and JSONPath body expressions. Easily generates Markdown structural differences comparing two requests.
- **📊 Chaining Test Suite Runner**: Executes multi-step API scenarios, automatically extracting dynamic variables (e.g. dynamic IDs, authorization tokens) and injecting them into subsequent steps.

---

## 🛠️ Setup & Build

1. Clone or copy the workspace directory.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Compile TypeScript:
   ```bash
   npm run build
   ```

---

## ⚙️ Integrate with Claude Desktop

Add this configuration to your Claude Desktop config (usually at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "postmcp": {
      "command": "node",
      "args": [
        "/Volumes/Mac/Workspace/postmcp/dist/index.js"
      ]
    }
  }
}
```

---

## 📖 MCP Tool Guide

### 1. Projects
- `project_create`: Setup a new project workspace.
- `project_switch`: Toggle active project workspace.
- `project_list`: List project workspaces.
- `project_delete`: Delete a project and its cascades.

### 2. Environments
- `env_configure`: Configure settings inside active project (base URL, default headers, cookies, auth config).
- `env_switch`: Toggle active environment profile.
- `env_list`: List environments of the active project.
- `env_delete`: Delete environment profile.
- `env_set_variable`: Save environment variable (`{{variableName}}` formatting support).
- `env_set_allowlist`: Define host allowlists.

### 3. HTTP Request & Suite Runner
- `http_request`: Executes REST requests, assertions, and logs metrics.
- `test_run_suite`: Sequential request engine with variables chaining.

### 4. WebSocket Client
- `ws_connect`, `ws_send`, `ws_read`, `ws_close`, `ws_list`.

### 5. Request History
- `history_list`: Query previous execution audits.
- `history_get`: Retrieve request execution details.
- `history_compare`: Structure structural diff comparison between two request logs.
- `history_clear`: Clear logs.

---

## 🧪 Integration Tests

We provide a mock API and WebSocket server in `src/test/` to run integration checks locally.

```bash
npx tsx src/test/runTests.ts
```
