# AI Agent Guide: How to Use `postmcp`

You are an AI Agent with access to the `postmcp` toolset. This server is a local database-backed testing client designed for automated RESTful API and WebSocket endpoint verification.

Read these instructions carefully to interact with the tools efficiently and securely.

---

## 🧭 Workflow & Core Concepts

### 1. Project and Environment Context
The server maintains state for the active project and environment. All request configurations, credentials, and variables are scoped to an **Environment Profile**, which belongs to a **Project Workspace**.

- **Workflow**:
  1. Use `project_list` to see workspaces, or `project_create` to start a new one.
  2. Switch projects via `project_switch`.
  3. Configure environment credentials (e.g. `dev`, `prod`) using `env_configure`.
  4. Activate an environment using `env_switch`.
  5. Check active status using `env_list` (which returns environment records with active flags).

### 2. Variable Interpolation
Environment variables are stored inside the database per environment. You can dynamically insert variables into request URLs, parameters, headers, or body using mustache-like syntax: `{{variable_name}}`.

- **Example**:
  - Environment variables: `{"userId": 42, "token": "xyz"}`
  - Request URL: `/users/{{userId}}`
  - Request Headers: `{"Authorization": "Bearer {{token}}"}`
  - During execution, these are automatically replaced with their literal values.

### 3. Context Window Protection (Response Selection)
LLM context windows are valuable. Large JSON responses can bloat your memory.
- **Best Practice**: If you only need a specific field, use the `jsonpathFilter` parameter (e.g. `$.data.items[0].id`). The HTTP tool will filter the response before returning it to you.
- Large responses are truncated automatically at 15,000 characters by default.

---

## 🛠️ Detailed Tool Instructions

### A. HTTP Requests (`http_request`)
Use `http_request` to send REST requests.
- **Assertions**: You can run assertions directly during request execution. This is faster and logs results to history.
  ```json
  "assertions": [
    { "type": "status", "operator": "equals", "expected": 200 },
    { "type": "body", "property": "$.data.username", "operator": "equals", "expected": "admin" },
    { "type": "responseTime", "operator": "lessThan", "expected": 500 }
  ]
  ```

### B. Request Chaining & Test Suites (`test_run_suite`)
When testing multi-step workflows (e.g., login -> save token -> query profile), **do not run multiple individual tool calls**. Instead, use `test_run_suite` to execute the steps in a single tool call.

- **Variables Chaining**: Use `extractVariables` in a step to pull data from a response and save it to environment variables, making it available for subsequent steps.
  - **Step 1 (Login)**:
    - `"url"`: `/login`
    - `"method"`: `"POST"`
    - `"extractVariables"`: `{"sessionToken": "$.token"}`
  - **Step 2 (Get Info)**:
    - `"url"`: `/secure/info`
    - `"method"`: `"GET"`
    - `"headers"`: `{"Authorization": "Bearer {{sessionToken}}"}`

### C. WebSocket Testing (`ws_*`)
WebSocket communication is asynchronous. You must handle connections via connection pools:
1. Connect using `ws_connect` and record the `connectionId`.
2. Send messages using `ws_send`.
3. To read incoming responses, use `ws_read`.
   - **Important**: WebSockets are asynchronous. If you expect a response frame, pass a `waitForPattern` (regex string) to `ws_read`. The tool will block and listen until a matching message arrives or it times out, instead of returning an empty queue.
4. Always close the connection using `ws_close` when done.

### D. History Audits & Diff Comparisons (`history_*`)
All HTTP requests are logged automatically.
- **Compare Responses**: To check if an API's behavior changed (e.g., comparing a dev environment run against a prod run, or before/after code changes):
  1. Retrieve log IDs using `history_list`.
  2. Call `history_compare` with `id1` and `id2`.
  3. The tool generates a structural JSON delta report showing added/deleted/changed fields and metric changes.

---

## 🔒 Security & Secrets Redaction

- Sensitive headers (`Authorization`, `Cookie`, `x-api-key`) and request bodies containing passwords or secrets are **automatically redacted** inside the SQLite history logs. You do not need to mask them manually.
- All requests check a global host allowlist. If you encounter an "Access Denied" error, adjust allowlists using `env_set_allowlist`.

### E. Database Maintenance (`db_*`)
- **`db_status`**: Get database stats, file size (in KB), database absolute path, and row counts of all tables.
- **`db_reset`**: **DANGER**: Perform a factory reset. This closes the database connection, deletes the database file, and re-initializes a fresh schema with a `DefaultProject` and `default` environment.
