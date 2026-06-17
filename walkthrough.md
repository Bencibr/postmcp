# Walkthrough: API Request and Testing MCP Server (postmcp)

We have successfully migrated the **postmcp** backend from standard JSON files to a unified local **SQLite database** stored at `~/.postmcp/postmcp.db`. This database serves as the centralized store for project workspaces, environment credentials, dynamic variables, OAuth2 cache tokens, and request logs history.

---

## 🚀 Key Achievements

1. **Unified SQLite Store**: All configuration data, project directories, environment credentials, and request logs are stored inside a single relational database file, set to safe Unix file permissions (`0600`).
2. **Multi-Project Management**: Support for creating, switching, listing, and deleting distinct project workspaces (e.g. `PaymentGateway`, `UserAuth`).
3. **Multi-Environment Profiles**: Each project can define multiple environments (`dev`, `prod`, `staging`), each with specific base URLs, variable pools, headers, cookies, and auth configurations.
4. **Secrets and Credentials Redaction**: Accounts, Bearer tokens, API Keys, and cookies are logged securely. Sensitive values are redacted (`********`) automatically before being written to the database request history.
5. **JSON-diff Response Comparison**: Compares two request executions by ID, analyzing status codes, duration, and computing structural JSON differences (added, changed, and removed keys) or raw text diffs.

---

## 🗄️ SQLite Database Schema

The database uses 5 interconnected tables:
- `projects`: Configures separate workspace boundaries.
- `environments`: Holds variables, cookies, headers, endpoints, and credentials per environment (owned by a project).
- `auth_cache`: Handles OAuth2 Client Credentials dynamic token cache and expiration dates.
- `history`: Sequential audit logs of all executed HTTP requests and responses.
- `app_state`: Persists active states, such as active project ID, active environment ID, and outgoing domain allowlists.

---

## 📖 MCP Tool API Guide

### 1. Help Guide
- **`mcp_usage_guide`**: Retrieve workflow guidelines on variables, chaining, and socket testing dynamically.

### 2. Project Management (`project_*`)
- **`project_create`**: Initialize a new project. Automatically creates a default environment for it.
  - Parameters: `name` (required), `description`
- **`project_switch`**: Switch active workspace.
  - Parameters: `projectId`
- **`project_list`**: Lists all projects.
- **`project_delete`**: Delete a project (cascades and deletes its environments, credentials, and test history).
  - Parameters: `projectId`

### 3. Environment Profile Management (`env_*`)
- **`env_configure`**: Configure settings inside the active project.
  - Parameters: `name` (dev/prod), `baseUrl`, `headers`, `cookies`, `variables`, `authType` (none/bearer/apiKey/oauth2), `authToken`, `apiKeyHeaderName`, `oauth2Config`.
- **`env_switch`**: Switch active environment.
  - Parameters: `environmentId`
- **`env_list`**: Lists environments belonging to active project (identifies active env and redacts secrets).
- **`env_delete`**: Delete environment profile.
  - Parameters: `environmentId`
- **`env_set_variable`**: Store variable key-value inside the active environment configuration (resolvable in requests via `{{variableName}}` syntax).
  - Parameters: `key`, `value`

### 4. HTTP Request (`http_request`)
Sends a request, evaluates assertions, filters outputs, and audits details into `history`.
```json
{
  "url": "/api/users/1",
  "method": "GET",
  "assertions": [
    { "type": "status", "operator": "equals", "expected": 200 }
  ]
}
```

### 5. WebSocket Testing (`ws_*`)
Initiates websocket connects, sends raw text/JSON messages, and polls buffered queues.
- `ws_connect`, `ws_send`, `ws_read` (supports wait regex), `ws_close`, `ws_list`.

### 6. History and Comparison (`history_*`)
- **`history_list`**: Lists request execution logs.
  - Parameters: `limit`, `offset`, `environmentId` (optional)
- **`history_get`**: Fetch details of a specific request audit log by ID (shows headers, body sent, response body).
  - Parameters: `id`
- **`history_compare`**: Computes diffs between two requests.
  - Parameters: `id1`, `id2`

#### Example Comparison Diff Output
```markdown
## 🔍 Request History Comparison (ID: 1 vs ID: 2)

### ⏱️ Metrics

| Metric | Record #1 | Record #2 | Comparison |
| :--- | :--- | :--- | :--- |
| **Status Code** | `200` | `200` | ✅ Match |
| **Response Time** | `45 ms` | `32 ms` | 🔹 Faster by -13ms |

### 📦 Response Body Diff

| Path | Type | Value in #1 (Old) | Value in #2 (New) |
| :--- | :--- | :--- | :--- |
| `$.data.id` | 🟡 Changed | `1` | `2` |
| `$.data.role` | 🔴 Removed | `"admin"` | *none* |
| `$.data.status` | 🟢 Added | *none* | `"active"` |
```

---

## 🧪 Local Verification

Run the integration test suite:
```bash
npx tsx src/test/runTests.ts
```

All 22 integration checks verify project operations, configuration states, history logging, credentials redaction, response filters, and JSON comparisons.
