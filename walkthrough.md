# Walkthrough: API Request and Testing MCP Server (postmcp)

We have successfully migrated the **postmcp** backend from standard JSON files to a unified local **SQLite database** stored at `~/.postmcp/postmcp.db`. This database serves as the centralized store for project workspaces, environment credentials, dynamic variables, OAuth2 cache tokens, and request logs history.

---

## 🚀 Key Achievements

1. **Unified SQLite Store**: All configuration data, project directories, environment credentials, and request logs are stored inside a single relational database file, set to safe Unix file permissions (`0600`).
2. **Multi-Project Management**: Support for creating, switching, listing, and deleting distinct project workspaces (e.g. `PaymentGateway`, `UserAuth`).
3. **Multi-Environment Profiles**: Each project can define multiple environments (`dev`, `prod`, `staging`), each with specific base URLs, variable pools, headers, cookies, and auth configurations.
4. **Secrets and Credentials Redaction**: Accounts, Bearer tokens, API Keys, and cookies are logged securely. Sensitive values are redacted (`********`) automatically before being written to the database request history.
5. **JSON-diff Response Comparison**: Compares two request executions by ID, analyzing status codes, duration, and computing structural JSON differences (added, changed, and removed keys) or raw text diffs.
6. **Outbound and File Safety**: Network destinations require an explicit allowlist and DNS/IP validation. Local file reads require confirmation, stay inside configured roots, reject protected credential paths, and enforce a size limit.
7. **Destructive-Action and Secret Gates**: Destructive tools require confirmation and exact-name checks where applicable. Variables and exports mask secrets by default, with separate confirmation required to reveal them.

---

## 🗄️ SQLite Database Schema

The database uses 6 interconnected tables:
- `projects`: Configures separate workspace boundaries.
- `environments`: Holds variables, cookies, headers, endpoints, credentials, and default timeout per environment (owned by a project).
- `auth_cache`: Handles OAuth2 token cache (supports client_credentials and password grants) and expiration dates.
- `history`: Sequential audit logs of all executed HTTP requests and responses.
- `test_suites`: Persisted test suites for reuse across sessions.
- `app_state`: Persists active states, such as active project ID, active environment ID, and outgoing domain allowlists.

### Security defaults

- Configure outbound targets with `env_set_allowlist`; `[]` denies all requests. Use `private:localhost` only for a trusted internal service.
- HTTP, WebSocket, OAuth2, and Swagger requests re-check redirects and DNS results. Private/reserved addresses are denied unless explicitly marked with `private:`.
- Set `POSTMCP_FILE_ROOTS` to one or more allowed directories for local file tools. The default root is the project directory. The default file limit is 10 MiB and can be raised to 100 MiB with `POSTMCP_MAX_FILE_BYTES`.
- `confirmFileAccess: true` is required for `fileFields`, data-driven suite files, `swagger_import.filePath`, and `postman_import`.
- Sensitive variables are masked by default. Use `includeSecret`/`confirmSecret` or `includeSecrets`/`confirmSecrets` only when the original value is required.

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
- **`project_rename`**: Rename a project.
  - Parameters: `projectId`, `name`
- **`project_delete`**: Delete a project (cascades and deletes its environments, credentials, and test history).
  - Parameters: `projectId`, `expectedProjectName`, `confirm: true`

### 3. Environment Profile Management (`env_*`)
- **`env_configure`**: Configure settings inside the active project.
  - Parameters: `name` (dev/prod), `baseUrl`, `headers`, `cookies`, `variables`, `authType` (none/bearer/apiKey/oauth2), `authToken`, `apiKeyHeaderName`, `timeout`, `oauth2Config` (client_credentials or password grant).
- **`env_switch`**: Switch active environment.
  - Parameters: `environmentId`
- **`env_list`**: Lists environments belonging to active project (identifies active env and redacts secrets).
- **`env_rename`**: Rename an environment.
  - Parameters: `environmentId`, `name`
- **`env_delete`**: Delete environment profile.
  - Parameters: `environmentId`, `expectedEnvironmentName`, `confirm: true`
- **`env_set_variable`**: Store variable key-value inside the active environment configuration (resolvable in requests via `{{variableName}}` syntax).
  - Parameters: `key`, `value`
- **`env_get_variable`**: Get a specific variable value; sensitive values are masked unless `includeSecret: true` and `confirmSecret: true` are provided.
  - Parameters: `key`
- **`env_delete_variable`**: Delete a variable.
  - Parameters: `key`
- **`env_list_variables`**: List all variables in the active environment; sensitive values are masked unless `includeSecrets: true` and `confirmSecrets: true` are provided.
- **`env_set_allowlist`**: Set the explicit outbound domain allowlist. An empty list denies all; use `private:host` for trusted internal hosts.
  - Parameters: `domains`
- **`env_get_allowlist`**: Get current allowlist configuration.

### 4. HTTP Request (`http_request`)
Sends a request, evaluates assertions, filters outputs, and audits details into `history`. Supports any HTTP method and file uploads. `fileFields` requires `confirmFileAccess: true` and a path inside `POSTMCP_FILE_ROOTS`.
```json
{
  "url": "/api/users/1",
  "method": "GET",
  "assertions": [
    { "type": "status", "operator": "equals", "expected": 200 }
  ]
}
```

### 5. GraphQL Request (`graphql_request`)
Sends a GraphQL query/mutation with variables and operation name support.
```json
{
  "url": "/graphql",
  "query": "query { users { id name } }"
}
```

### 6. WebSocket Testing (`ws_*`)
Initiates websocket connects, sends raw text/JSON messages, and polls buffered queues.
- `ws_connect`, `ws_send`, `ws_read` (supports wait regex), `ws_close`, `ws_list`.

### 7. Test Suite Persistence (`suite_*`)
- **`suite_save`**: Save a test suite to the database for reuse.
- **`suite_load`**: Load and execute a saved test suite.
- **`suite_list`**: List saved test suites.
- **`suite_delete`**: Delete a saved test suite. Requires `suiteId`, an exact `expectedSuiteName`, and `confirm: true`; suites are scoped to the active project.

### 8. History and Comparison (`history_*`)
- **`history_list`**: Lists request execution logs.
  - Parameters: `limit`, `offset`, `environmentId`, `method`, `statusCode`, `urlKeyword`, `dateFrom`, `dateTo`
- **`history_get`**: Fetch details of a specific request audit log by ID (shows headers, body sent, response body).
  - Parameters: `id`
- **`history_compare`**: Computes diffs between two requests (supports `table` and `unified` format).
  - Parameters: `id1`, `id2`, `format`
- **`history_clear`**: Clear history logs. Requires `confirm: true`.
- **`history_export`**: Export history as JSON.

### 9. Database Maintenance (`db_*`)
- **`db_status`**: Get database file path, file size in KB, and table counts.
- **`db_reset`**: **DANGER**: Perform a factory reset (requires `confirm: true`).

### 10. Swagger/OpenAPI Import (`swagger_import`)
- **`swagger_import`**: Read local JSON/YAML file configurations or fetch specs from a URL. Now includes response status codes and response body schemas in the generated Markdown.
  - Parameters: `url`, `filePath`, `confirmFileAccess: true` when using `filePath`

### 11. Postman Collection Import (`postman_import`)
- **`postman_import`**: Import a Postman Collection v2 JSON file and generate a Markdown API reference.
  - Parameters: `filePath`, `confirmFileAccess: true`

### 12. Environment & Project Export/Import
- **`env_export`** / **`env_import`**: Export/import environment configurations as portable JSON. Exports mask secrets by default; include them only with `includeSecrets: true` and `confirmSecrets: true`.
- **`project_export`** / **`project_import`**: Export/import projects (including all environments) as portable JSON. Exports mask secrets by default; include them only with `includeSecrets: true` and `confirmSecrets: true`.

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
npm run test:negative
npm run test:stress
```

The integration suite verifies project operations, configuration states, history logging, credentials redaction, response filters, JSON comparisons, WebSocket persistence, database maintenance, and Swagger imports. The negative suite covers denied network/file access and failure recovery; the stress suite covers concurrency, latency, and resource usage.
