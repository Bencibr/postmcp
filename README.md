# postmcp 🚀 - API Request & Automation Testing MCP Server

[English](#english) | [中文说明](#中文说明)

---

## English

A high-performance Model Context Protocol (MCP) server written in Node.js (TypeScript) designed for API request automation and automated testing. It features a unified local SQLite database storage allowing LLM agents to manage projects, configure environment variables and credential tokens, run REST and WebSocket requests, evaluate assertions, and audit execution histories.

### ✨ Features

- **🗄️ SQLite Unified Storage**: Consolidates projects, profiles, variables, cache tokens, history logs, and test suites into `~/.postmcp/postmcp.db` under user-only file permissions (`0600`).
- **📁 Multi-Project Workspaces**: Easily partition different API workspaces (e.g. e-commerce-api, auth-service).
- **⚙️ Environment Profiles**: Configure separate environments (e.g. `dev`, `prod`, `local`) with specific base URLs (supports `{{var}}` interpolation), headers, cookies, authentication methods, and default timeout.
- **🔐 Automatic OAuth2 Flow & Token Injection**: Full Support for Bearer Tokens, API Keys, and automated OAuth2 **Client Credentials** and **Password** grants with expiration caching.
- **📥 WebSocket persistent connection pool**: Persistent socket clients with message buffering, and regex patterns wait features (block and wait for expected responses).
- **⏱️ Assertion Engine & Diff Engine**: Evaluates request status codes, times, response headers, and JSONPath body expressions. Easily generates Markdown structural differences comparing two requests (supports `table` and `unified` diff formats).
- **📊 Chaining Test Suite Runner**: Executes multi-step API scenarios, automatically extracting dynamic variables (e.g. dynamic IDs, authorization tokens) and injecting them into subsequent steps.
- **🧪 GraphQL Support**: Dedicated `graphql_request` tool for sending GraphQL queries/mutations with variable injection.
- **📁 File Upload Support**: Upload files via `form-data` body type using `fileFields` parameter.
- **💾 Test Suite Persistence**: Save, load, list, and delete test suites in the database for reuse.
- **📤 Import/Export Ecosystem**: Import Postman Collections, export/import environments and projects as portable JSON.
- **📖 Swagger/OpenAPI Import (Enhanced)**: Now includes response status codes and response body schemas in generated Markdown.
- **🔍 Advanced History Filtering**: Filter audit logs by method, status code, URL keyword, and date range.
- **📋 History Export**: Export audit logs as JSON for external analysis.

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

1. **Guide & Instructions**: `mcp_usage_guide` (dynamically returns workflow guidelines on variables, chaining, and socket testing).
2. **Projects (`project_*`)**: `project_create`, `project_switch`, `project_list`, `project_delete`, `project_rename`.
3. **Environments (`env_*`)**: `env_configure` (with `timeout`, `oauth2Config` password grant), `env_switch`, `env_list`, `env_delete`, `env_rename`, `env_set_variable`, `env_get_variable`, `env_delete_variable`, `env_list_variables`, `env_set_allowlist`, `env_get_allowlist`.
4. **HTTP Requests**: `http_request` (REST requests with file upload via `fileFields` and any HTTP method), `graphql_request` (dedicated GraphQL query tool), `test_run_suite` (sequential scenario runner).
5. **WebSocket Client (`ws_*`)**: `ws_connect`, `ws_send`, `ws_read` (regex waiting support), `ws_close`, `ws_list`.
6. **Test Suite Persistence (`suite_*`)**: `suite_save`, `suite_load`, `suite_list`, `suite_delete`.
7. **Request History (`history_*`)**: `history_list` (with advanced filters: method, statusCode, urlKeyword, dateFrom, dateTo), `history_get` (detail log), `history_compare` (diff logs, supports `table` and `unified` format), `history_clear`, `history_export`.
8. **Database Maintenance (`db_*`)**: `db_status` (returns database file path, file size in KB, and table row counts), `db_reset` (factory reset DB, requires `confirm: true`).
9. **Swagger Import (`swagger_import`)**: `swagger_import` (imports routes and schemas from JSON/YAML files or URLs into Markdown references; now includes response status codes and schemas).
10. **Import/Export**: `postman_import` (Postman Collection v2), `env_export`, `env_import`, `project_export`, `project_import`.

### 🧪 Integration Tests

```bash
npx tsx src/test/runTests.ts
```

---

## 中文说明

**postmcp** 是使用 Node.js (TypeScript) 编写的高性能 Model Context Protocol (MCP) 服务，专为 API 接口自动化请求与集成测试设计。采用统一的本地 SQLite 数据库作为存储，支持多项目切换、多环境配置（如 dev, prod）、OAuth2 认证缓存，以及详尽的请求历史审计与响应对比（Diff）功能。

### ✨ 功能特性

- **🗄️ SQLite 统一存储**：将项目、环境、变量、缓存 token、请求日志和测试套件集中持久化到 `~/.postmcp/postmcp.db`，使用 Unix 用户独占权限 (`0600`) 保护。
- **📁 多项目工作区**：支持创建和隔离多个独立的 API 测试项目（例如 `PaymentGateway`、`UserAuth`）。
- **⚙️ 环境配置文件**：每个项目下可配置多个环境（如 `dev`、`prod`、`local`），每个环境可包含不同的 Base URL（支持 `{{var}}` 插值）、变量池、默认 Headers、Cookies、鉴权配置及默认超时时间。
- **🔐 OAuth2 自动换单与 Token 注入**：支持 Bearer Token、API Key，以及 OAuth2 **Client Credentials** 和 **Password** 模式的自动获取、过期校验与缓存。
- **📥 WebSocket 状态连接池**：维护持久化的 socket 连接，支持发送/接收消息，并支持基于正则的 `waitForPattern` 异步阻塞监听。
- **⏱️ 断言与差异对比引擎**：提供多类型断言验证（状态码、响应时间、Header、JSONPath 表达式），并能对比两个请求记录的响应差异（支持 `table` 和 `unified` 两种 diff 格式）。
- **📊 串联测试用例运行器 (Test Suite)**：按顺序执行多步 API 请求，支持通过 JSONPath 提取响应参数，并自动注入到后续请求中。
- **🧪 GraphQL 支持**：专用 `graphql_request` 工具发送 GraphQL 查询/变更，自动拼接 body。
- **📁 文件上传支持**：通过 `fileFields` 参数在 form-data 中上传本地文件。
- **💾 测试套件持久化**：在数据库中保存、加载、列举和删除测试套件。
- **📤 导入导出生态**：导入 Postman Collection，导出/导入环境和项目的可移植 JSON。
- **📖 Swagger/OpenAPI 导入（增强）**：现在包含响应状态码和响应体 Schema。
- **🔍 高级历史过滤**：按请求方法、状态码、URL 关键词、时间范围过滤审计日志。
- **📋 历史导出**：将审计日志导出为 JSON 用于外部分析。

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

1. **帮助与指南 (`mcp_usage_guide`)**：
   - `mcp_usage_guide`：让 AI 助手直接获取关于变量插值、串联测试、WebSocket 异步监听等的高级使用说明。
2. **项目管理 (`project_*`)**：
   - `project_create`：创建一个新的项目测试空间。
   - `project_switch`：切换当前活动的项目空间。
   - `project_list`：列出所有项目。
   - `project_delete`：删除指定项目（级联删除关联的环境及历史记录）。
   - `project_rename`：重命名项目。
3. **环境配置 (`env_*`)**：
   - `env_configure`：在活动项目下创建或修改环境（支持 timeout、oauth2Config password grant）。
   - `env_switch`：切换活动环境。
   - `env_list`：列出当前项目下的环境列表（敏感 Token 会自动脱敏遮蔽）。
   - `env_delete`：删除环境配置文件。
   - `env_rename`：重命名环境。
   - `env_set_variable`：往当前活动环境写入自定义变量，在请求中通过 `{{variableName}}` 引用。
   - `env_get_variable`：查询指定变量的值。
   - `env_delete_variable`：删除指定变量。
   - `env_list_variables`：列出所有环境变量。
   - `env_set_allowlist`：设置安全出站域名白名单。
   - `env_get_allowlist`：查询当前白名单配置。
4. **HTTP 接口请求**：
   - `http_request`：发送单次 API 请求，支持文件上传 (`fileFields`) 和任意 HTTP 方法。
   - `graphql_request`：发送 GraphQL 查询/变更。
   - `test_run_suite`：执行串联式多步 API 测试场景，支持变量提取与传递。
5. **WebSocket 客户端 (`ws_*`)**：
   - `ws_connect`：发起 WebSocket 连接，维持长连接状态。
   - `ws_send`：发送文本或 JSON 数据帧。
   - `ws_read`：读取已收到的消息缓存，支持传入 `waitForPattern` 正则阻塞等待响应。
   - `ws_close`：关闭 WebSocket 连接。
   - `ws_list`：列出当前所有活跃的 socket 连接 ID。
6. **测试套件持久化 (`suite_*`)**：
   - `suite_save`：保存测试套件到数据库。
   - `suite_load`：加载并运行已保存的测试套件。
   - `suite_list`：列出已保存的测试套件。
   - `suite_delete`：删除已保存的测试套件。
7. **历史日志与响应对比 (`history_*`)**：
   - `history_list`：分页查询历史记录（支持 method、statusCode、urlKeyword、dateFrom、dateTo 高级过滤）。
   - `history_get`：根据 ID 检索单次请求响应的详细报文。
   - `history_compare`：对两个历史请求进行多维度比对（支持 `table` 和 `unified` 两种格式）。
   - `history_clear`：清理历史审计记录。
   - `history_export`：导出历史记录为 JSON。
8. **数据库维护 (`db_*`)**：
   - `db_status`：查询本地 SQLite 数据库的文件路径、大小（KB）及各个表的数据量。
   - `db_reset`：**危险操作**：重置数据库（需要 `confirm: true` 确认）。
9. **Swagger 导入 (`swagger_import`)**：
   - `swagger_import`：读取本地或远程 Swagger/OpenAPI 文件，生成结构化 Markdown 文档（含响应状态码和 Schema）。
10. **导入/导出**：
    - `postman_import`：导入 Postman Collection v2 文件。
    - `env_export` / `env_import`：导出/导入环境配置 JSON。
    - `project_export` / `project_import`：导出/导入项目（含所有环境）JSON。

### 🧪 本地集成测试

您可以启动内置的 Mock 服务器并对所有功能模块进行全自动回归测试：

```bash
npx tsx src/test/runTests.ts
```
