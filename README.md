# postmcp 🚀

[English](#english) | [中文说明](#中文说明)

---

## English

A high-performance Model Context Protocol (MCP) server written in Node.js (TypeScript) designed for API request automation and automated testing. It features a unified local SQLite database storage allowing LLM agents to manage projects, configure environment variables and credential tokens, run REST and WebSocket requests, evaluate assertions, and audit execution histories.

### ✨ Features

- **🗄️ SQLite Unified Storage**: Consolidates projects, profiles, variables, cache tokens, and history logs into `~/.postmcp/postmcp.db` under user-only file permissions (`0600`).
- **📁 Multi-Project Workspaces**: Easily partition different API workspaces (e.g. e-commerce-api, auth-service).
- **⚙️ Environment Profiles**: Configure separate environments (e.g. `dev`, `prod`, `local`) with specific base URLs, headers, cookies, and authentication methods.
- **🔐 Automatic OAuth2 Flow & Token Injection**: Full Support for Bearer Tokens, API Keys, and automated Client Credentials flow for OAuth2 token exchanges with expiration caching.
- **📥 WebSocket persistent connection pool**: Persistent socket clients with message buffering, and regex patterns wait features (block and wait for expected responses).
- **⏱️ Assertion Engine & Diff Engine**: Evaluates request status codes, times, response headers, and JSONPath body expressions. Easily generates Markdown structural differences comparing two requests.
- **📊 Chaining Test Suite Runner**: Executes multi-step API scenarios, automatically extracting dynamic variables (e.g. dynamic IDs, authorization tokens) and injecting them into subsequent steps.

### 🛠️ Setup & Build

1. Install dependencies:
   ```bash
   npm install
   ```
2. Compile TypeScript:
   ```bash
   npm run build
   ```

### ⚙️ Integrate with Claude Desktop

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

### 📖 MCP Tool Guide

1. **Projects (`project_*`)**: `project_create`, `project_switch`, `project_list`, `project_delete`.
2. **Environments (`env_*`)**: `env_configure`, `env_switch`, `env_list`, `env_delete`, `env_set_variable`, `env_set_allowlist`.
3. **HTTP Requests**: `http_request` (REST requests with assertions), `test_run_suite` (sequential scenario runner).
4. **WebSocket Client (`ws_*`)**: `ws_connect`, `ws_send`, `ws_read` (regex waiting support), `ws_close`, `ws_list`.
5. **Request History (`history_*`)**: `history_list` (query audits), `history_get` (detail log), `history_compare` (diff logs), `history_clear`.

### 🧪 Integration Tests

```bash
npx tsx src/test/runTests.ts
```

---

## 中文说明

**postmcp** 是使用 Node.js (TypeScript) 编写的高性能 Model Context Protocol (MCP) 服务，专为 API 接口自动化请求与集成测试设计。采用统一的本地 SQLite 数据库作为存储，支持多项目切换、多环境配置（如 dev, prod）、OAuth2 认证缓存，以及详尽的请求历史审计与响应对比（Diff）功能。

### ✨ 功能特性

- **🗄️ SQLite 统一存储**：将项目、环境、变量、缓存 token 和请求日志集中持久化到 `~/.postmcp/postmcp.db`，使用 Unix 用户独占权限 (`0600`) 保护。
- **📁 多项目工作区**：支持创建和隔离多个独立的 API 测试项目（例如 `PaymentGateway`、`UserAuth`）。
- **⚙️ 环境配置文件**：每个项目下可配置多个环境（如 `dev`、`prod`、`local`），每个环境可包含不同的 Base URL、变量池、默认 Headers、Cookies 及鉴权配置。
- **🔐 OAuth2 自动换单与 Token 注入**：支持 Bearer Token、API Key，以及 OAuth2 **Client Credentials 客户端凭证模式**的自动获取、过期校验与缓存。
- **📥 WebSocket 状态连接池**：维护持久化的 socket 连接，支持发送/接收消息，并支持基于正则的 `waitForPattern` 异步阻塞监听。
- **⏱️ 断言与差异对比引擎**：提供多类型断言验证（状态码、响应时间、Header、JSONPath 表达式），并能对比两个请求记录的响应差异（包含 JSON 字段的新增、删除、变更）。
- **📊 串联测试用例运行器 (Test Suite)**：按顺序执行多步 API 请求，支持通过 JSONPath 提取响应参数，并自动注入到后续请求中。

### 🛠️ 安装与编译

1. 安装依赖包：
   ```bash
   npm install
   ```
2. 编译 TypeScript：
   ```bash
   npm run build
   ```

### ⚙️ 对接 Claude 桌面客户端

在您的 Claude Desktop 配置文件中（通常位于 macOS 的 `~/Library/Application Support/Claude/claude_desktop_config.json`），添加以下配置：

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

### 📖 MCP 工具接口使用指南

1. **项目管理 (`project_*`)**：
   - `project_create`：创建一个新的项目测试空间。
   - `project_switch`：切换当前活动的项目空间。
   - `project_list`：列出所有项目。
   - `project_delete`：删除指定项目（级联删除关联的环境及历史记录）。
2. **环境配置 (`env_*`)**：
   - `env_configure`：在活动项目下创建或修改环境（如 dev 或 prod，可配置 Base URL、账号凭证等）。
   - `env_switch`：切换活动环境。
   - `env_list`：列出当前项目下的环境列表（敏感 Token 会自动脱敏遮蔽）。
   - `env_delete`：删除环境配置文件。
   - `env_set_variable`：往当前活动环境写入自定义变量，在请求中通过 `{{variableName}}` 引用。
   - `env_set_allowlist`：设置安全出站域名白名单。
3. **HTTP 接口请求**：
   - `http_request`：发送单次 API 请求，包含 Headers 自动构建、断言以及数据库审计。
   - `test_run_suite`：执行串联式多步 API 测试场景，支持变量提取与传递。
4. **WebSocket 客户端 (`ws_*`)**：
   - `ws_connect`：发起 WebSocket 连接，维持长连接状态。
   - `ws_send`：发送文本或 JSON 数据帧。
   - `ws_read`：读取已收到的消息缓存，支持传入 `waitForPattern` 正则阻塞等待响应。
   - `ws_close`：关闭 WebSocket 连接。
   - `ws_list`：列出当前所有活跃的 socket 连接 ID。
5. **历史日志与响应对比 (`history_*`)**：
   - `history_list`：分页查询存储在 SQLite 中的历史发包审计记录。
   - `history_get`：根据 ID 检索单次请求响应的详细报文。
   - `history_compare`：对两个历史请求进行多维度比对，生成包含状态码、响应时间以及 JSON 结构体变化（新增、变更、删除）的 Markdown 差异表格。
   - `history_clear`：清理历史审计记录。

### 🧪 本地集成测试

您可以启动内置的 Mock 服务器并对所有功能模块进行全自动回归测试：

```bash
npx tsx src/test/runTests.ts
```
