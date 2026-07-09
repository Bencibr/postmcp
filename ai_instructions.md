# AI Agent Guide: How to Use `postmcp`

You are an AI Agent with access to the `postmcp` toolset — a local database-backed API testing MCP server. It enables RESTful API, GraphQL, and WebSocket endpoint testing with persistent storage, variable interpolation, assertion engines, and chained test suites.

**All data** (projects, environments, credentials, test suites, request history) is persisted in `~/.postmcp/postmcp.db`.

---

## 🧭 Quick Start (2-Minute Setup)

```json
// 1. Create a project workspace
project_create { "name": "MyAPI" }

// 2. Configure environment (dev with base URL)
env_configure { "name": "dev", "baseUrl": "https://api.example.com" }

// 3. Send your first request
http_request { "url": "/health", "method": "GET" }

// 4. View the audit log
history_list { "limit": 5 }
```

---

## 🗂️ 1. Core Concepts

### 1.1 Projects & Environments

```
postmcp DB
├── Project (e.g. "E-Commerce API")
│   ├── Environment "dev"  → baseUrl: https://dev.api.com
│   │   ├── variables:  { userId: 42, token: "abc" }
│   │   ├── headers:    { X-Client: "TestApp" }
│   │   ├── cookies:    { session: "xyz" }
│   │   └── auth:       bearer / apiKey / basic / oauth2
│   ├── Environment "prod" → baseUrl: https://api.com
│   └── Environment "staging" → ...
├── Project "Auth Service"
│   └── ...
```

**Workflow**: `project_create` → `env_configure` → `env_switch` → execute requests.

### 1.2 Variable Interpolation

Use `{{variableName}}` in **url**, **headers**, **params**, and **body**. They are replaced at runtime.

```json
// Environment variables: { "userId": 42, "token": "abc-123" }
http_request {
  "url": "/users/{{userId}}",
  "headers": { "Authorization": "Bearer {{token}}" }
}
// → Actual request: GET /users/42  with Authorization: Bearer abc-123
```

### 1.3 Dynamic Variables (Built-in Functions)

Use these anywhere `{{var}}` works — no setup needed:

| Variable | Output Example | Description |
|----------|---------------|-------------|
| `{{$timestamp}}` | `1720512000000` | Current Unix timestamp (ms) |
| `{{$isoTimestamp}}` | `2026-07-09T07:22:00.000Z` | ISO 8601 timestamp |
| `{{$uuid}}` | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` | Random UUID v4 |
| `{{$randomInt}}` | `423871` | Random integer 0-999999 |
| `{{$randomFloat}}` | `374.52` | Random float 0-1000 |
| `{{$randomEmail}}` | `user38472@test.com` | Random email |
| `{{$randomName}}` | `Alice` | Random name from pool |
| `{{$randomCity}}` | `Tokyo` | Random city from pool |
| `{{$currentDate}}` | `2026-07-09` | Today's date |
| `{{$currentTime}}` | `07:22:00` | Current time |

**Example**: Create a user with random data
```json
http_request {
  "url": "/api/users",
  "method": "POST",
  "body": "{\"name\":\"{{$randomName}}\",\"email\":\"{{$randomEmail}}\",\"createdAt\":\"{{$isoTimestamp}}\"}"
}
```

### 1.4 Context Window Protection

- **jsonpathFilter**: Extract only needed fields from response (`$.data.items[0].id`)
- **Response truncation**: Body >15,000 chars is truncated automatically
- **Silent mode**: `returnBody: false` → only status + duration (99% token saving)
- **Custom truncation**: `maxResponseLength: 500` → limit to 500 chars
- **Assertions run on full body** even when response is filtered/truncated

---

## 🛠️ 2. Complete Tool Reference

### 2.1 Help
```
mcp_usage_guide
→ Returns this document dynamically
```

### 2.2 Project Management (`project_*`)

**`project_create`**
- `name` (string, required): Unique project name
- `description` (string, optional)
- → Auto-creates a "default" environment

**`project_switch`**
- `projectId` (number, required): Switch active project

**`project_list`** (no args)
- → Lists all projects with active flags

**`project_rename`**
- `projectId` (number, required)
- `name` (string, required): New name

**`project_delete`**
- `projectId` (number, required): Cascading delete

### 2.3 Environment Management (`env_*`)

**`env_configure`**
- `name` (string, required): e.g. "dev", "prod"
- `baseUrl` (string, optional): Supports `{{var}}` interpolation
- `headers` (object, optional): Default headers for every request
- `cookies` (object, optional): Auto-injected cookies
- `variables` (object, optional): Key-value store for `{{var}}` interpolation
- `authType` (string, optional): `"none"` | `"bearer"` | `"apiKey"` | `"basic"` | `"oauth2"`
- `authToken` (string, optional): Token for bearer/apiKey. For `basic`, use `"username:password"`
- `apiKeyHeaderName` (string, optional): Custom header for apiKey (default: `"x-api-key"`)
- `timeout` (number, optional): Default request timeout in ms (default: 30000)
- `oauth2Config` (object, optional):
  - `grantType`: `"client_credentials"` | `"password"`
  - `tokenUrl` (string): Token endpoint URL
  - `clientId` (string), `clientSecret` (string)
  - `scope` (string, optional)
  - `username`, `password` (for password grant)

**`env_switch`** — `environmentId` (number, required)

**`env_list`** (no args) → Lists environments, secrets masked as `********`

**`env_rename`** — `environmentId`, `name`

**`env_delete`** — `environmentId`

**`env_set_variable`** — `key`, `value`

**`env_get_variable`** — `key` → Returns variable value

**`env_delete_variable`** — `key`

**`env_list_variables`** (no args) → Returns all variables

**`env_set_allowlist`** — `domains` (string[]): Safe domains. `[]` = allow all

**`env_get_allowlist`** (no args) → Returns current allowlist

### 2.4 HTTP Requests (`http_request`)

**Core parameters:**
- `url` (string, required): Absolute URL or relative path (resolved against baseUrl)
- `method` (string, default: `"GET"`): Any HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS, PROPFIND, etc.)
- `headers` (object, optional): Additional headers
- `params` (object, optional): URL query parameters (e.g. `{"page": "1", "limit": "20"}`)
- `body` (string, optional): Request body (raw string or stringified JSON)
- `bodyType` (string, default: `"json"`): `"json"` | `"urlencoded"` | `"form-data"` | `"raw"`

**Token-saving parameters:**
- `jsonpathFilter` (string, optional): Extract specific fields (e.g. `$.data.users[0].id`). Response body is replaced with filtered result
- `maxResponseLength` (number, optional): Truncate response at N chars (default: 15000)
- `returnBody` (boolean, optional): `false` = silent mode — only return status + duration, no body (saves 99% tokens)
- `cacheTtl` (number, optional): Cache GET/HEAD responses for N ms. Same URL within TTL returns cached result
- `assertBefore` (object, optional): Only return full response if condition is met:
  - `type`: `"status"` | `"header"` | `"body"`
  - `property` (string, optional): Header name or JSONPath for body
  - `operator`: `"equals"` | `"notEquals"` | `"contains"` | `"exists"` | `"matches"` | `"greaterThan"` | `"lessThan"`
  - `expected` (any, optional)

**Reliability parameters:**
- `timeout` (number, optional): Overrides environment default timeout
- `retryCount` (number, optional): Auto-retry on 5xx/network errors (default: 0)
- `retryDelay` (number, optional): Delay between retries in ms (default: 1000)

**File upload:**
- `fileFields` (object, optional): `{"fieldName": "/absolute/path/to/file"}` — for `bodyType: "form-data"`

**Assertions:**
- `assertions` (array, optional):
  - `type`: `"status"` | `"header"` | `"body"` | `"responseTime"`
  - `property` (string, optional): Header name or JSONPath for body type
  - `operator`: `"equals"` | `"notEquals"` | `"contains"` | `"notContains"` | `"exists"` | `"notExists"` | `"matches"` | `"greaterThan"` | `"lessThan"` | `"in"` | `"notIn"`
  - `expected` (any, optional)

**Example — Minimal health check (0 tokens for body):**
```json
{ "url": "/health", "method": "GET", "returnBody": false }
```

**Example — Cached, filtered, with retry:**
```json
{
  "url": "/api/users/{{userId}}",
  "method": "GET",
  "jsonpathFilter": "$.name",
  "cacheTtl": 60000,
  "retryCount": 2,
  "assertBefore": { "type": "status", "operator": "equals", "expected": 200 }
}
```

### 2.5 GraphQL Requests (`graphql_request`)

- `url` (string, required): GraphQL endpoint
- `query` (string, required): GraphQL query or mutation
- `variables` (object, optional): Query variables
- `operationName` (string, optional): For multi-operation queries
- `headers` (object, optional): Additional headers
- `timeout` (number, optional)

**Example:**
```json
{
  "url": "/graphql",
  "query": "query GetUser($id: ID!) { user(id: $id) { name email } }",
  "variables": { "id": "123" },
  "operationName": "GetUser"
}
```

### 2.6 WebSocket (`ws_*`)

**`ws_connect`** — Opens a persistent WebSocket connection
- `url` (string, required): `ws://` or `wss://`. Relative paths resolved against baseUrl
- `headers` (object, optional): Custom headers
- `timeout` (number, optional): Connection timeout (default: 10000ms)
- → Returns `connectionId` (string)

**`ws_send`**
- `connectionId` (string, required)
- `message` (string, required): Text or JSON payload

**`ws_read`**
- `connectionId` (string, required)
- `limit` (number, default: 50): Max messages to return
- `waitForPattern` (string, optional): Regex pattern. **Blocks** until a matching message arrives
- `timeout` (number, optional): Max wait time for pattern (default: 5000ms)

**`ws_close`** — `connectionId` (string, required)

**`ws_list`** (no args) — Lists all active connections

**WebSocket patterns:**
```json
// Pattern 1: Subscribe and wait for expected message
ws_connect { "url": "/ws/events" }
→ connectionId: "ws_1"

ws_read { "connectionId": "ws_1", "waitForPattern": "order\\.confirmed", "timeout": 10000 }
→ Blocks until a message matching "order.confirmed" is received

// Pattern 2: Request-response via WS
ws_send { "connectionId": "ws_1", "message": "get-time" }
ws_read { "connectionId": "ws_1", "limit": 5 }
```

### 2.7 Test Suite Execution (`test_run_suite`)

**Parameters:**
- `suiteName` (string, required)
- `dataSource` (object, optional): **Data-Driven Testing** — run suite for each row
  - `type`: `"csv"` | `"json"`
  - `filePath`: Absolute path to data file
  - Use `{{row.columnName}}` in step fields to reference row data
- `steps` (array, required): Array of step objects

**Each step:**
- `stepName` (string, required): Step description
- `url` (string, required), `method` (string, default: "GET")
- `headers`, `params`, `body`, `bodyType`, `jsonpathFilter`: Same as `http_request`
- `extractVariables` (object, optional): `{"varName": "$.json.path"}` — extracted values flow to subsequent steps
- `assertions` (array, optional): Same as `http_request`

**Example with DDT:**
```json
{
  "suiteName": "Bulk User Creation",
  "dataSource": { "type": "csv", "filePath": "/tmp/users.csv" },
  "steps": [{
    "stepName": "Create User",
    "url": "/api/users",
    "method": "POST",
    "body": "{\"name\":\"{{row.name}}\",\"email\":\"{{row.email}}\"}"
  }]
}
```
Data file `users.csv`:
```csv
name,email
Alice,alice@example.com
Bob,bob@example.com
```

### 2.8 Test Suite Persistence (`suite_*`)

**`suite_save`**
- `name` (string, required): Unique name per project
- `steps` (array, required): Step objects (same format as `test_run_suite`)
- `description` (string, optional)

**`suite_load`** — `suiteId` (number, required): Load and execute a saved suite

**`suite_list`** (no args): List saved suites

**`suite_delete`** — `suiteId` (number, required)

### 2.9 History & Audit (`history_*`)

**`history_list`** — Query audit logs
- `limit` (number, default: 20), `offset` (number, default: 0)
- Filters: `environmentId`, `method`, `statusCode`, `urlKeyword`, `dateFrom`, `dateTo`

**`history_get`** — `id` (number, required): Full request/response detail

**`history_compare`** — Compare two executions
- `id1`, `id2` (numbers, required)
- `format` (string, optional): `"table"` (default) — Markdown table | `"unified"` — compact diff

**`history_clear`** — `olderThanSeconds` (number, optional)

**`history_export`** — `projectId` (number, optional): Export as JSON array

### 2.10 Import/Export

**`swagger_import`**
- `url` (string, optional): Remote OpenAPI spec URL
- `filePath` (string, optional): Local file path (JSON/YAML)
- → Renders Markdown API reference with endpoints, parameters, request bodies, **and response schemas**

**`postman_import`**
- `filePath` (string, required): Postman Collection v2 JSON file
- → Renders Markdown with all endpoints, methods, headers, body samples (preserves folder structure)

**`env_export`** — `environmentId` (number, required): Portable JSON

**`env_import`**
- `data` (object, required): Environment JSON (from `env_export`)
- `projectId` (number, optional): Target project

**`project_export`** — `projectId` (number, required): Project + all environments as JSON

**`project_import`** — `data` (object, required): Full project JSON

### 2.11 Database Maintenance (`db_*`)

**`db_status`** (no args) → File path, size, table row counts

**`db_reset`** — **DANGER**: `confirm` (boolean, required): Must be `true`

---

## 🔐 3. Authentication Reference

| Auth Type | `authType` value | Token Format | Example |
|-----------|:----------------:|-------------|---------|
| None | `"none"` | — | — |
| Bearer Token | `"bearer"` | Raw token string | `authToken: "eyJhbGci..."` |
| API Key | `"apiKey"` | Key value | `authToken: "sk-abc123"`, `apiKeyHeaderName: "x-api-key"` |
| Basic Auth | `"basic"` | `"username:password"` | `authToken: "admin:secret123"` |
| OAuth2 Client Credentials | `"oauth2"` | via `oauth2Config` | See below |
| OAuth2 Password | `"oauth2"` | via `oauth2Config` | See below |

**OAuth2 configuration** (for `authType: "oauth2"`):
```json
// Client Credentials
{ "grantType": "client_credentials", "tokenUrl": "https://auth.example.com/token",
  "clientId": "my-client", "clientSecret": "my-secret", "scope": "read write" }

// Password Grant
{ "grantType": "password", "tokenUrl": "https://auth.example.com/token",
  "clientId": "my-client", "clientSecret": "my-secret",
  "username": "admin", "password": "pass123" }
```

**Cookie Jar** — Automatic: When a response includes `Set-Cookie`, the cookie is saved to the active environment and automatically injected in subsequent requests. No manual setup needed.

---

## ⚡ 4. Token-Saving Features

postmcp is designed to minimize AI token consumption:

| Feature | How to Use | Tokens Saved |
|---------|-----------|:-----------:|
| **jsonpathFilter** | Extract only the field you need | 60-95% |
| **returnBody: false** | Silent mode — only status + duration | 99% |
| **maxResponseLength** | Set limit per request (e.g. 500 chars) | Variable |
| **assertBefore** | Only fetch body when condition is met | 95% on failures |
| **cacheTtl** | Cache GET responses, avoid redundant calls | 100% on repeat |
| **history_get** instead of re-requesting | View logged response without calling API | 100% |
| **history_compare** | See only what changed between two runs | 40-60% |
| **assertions** | Structured pass/fail instead of full response | 80% |

**Typical token-efficient workflow:**
```json
// Step 1: Quick health check (status only)
→ http_request { "url": "/health", "returnBody": false }

// Step 2: If healthy, fetch filtered data (with cache)
→ http_request { "url": "/api/users", "jsonpathFilter": "$[0].id", "cacheTtl": 30000 }

// Step 3: Conditional — only get details if user exists
→ http_request { "url": "/api/users/42", "assertBefore": { "type": "status", "operator": "notEquals", "expected": 404 } }
```

---

## 🔄 5. Advanced Usage Patterns

### Workflow: Debug a Failed Request
```
1. history_list { "limit": 10 }
   → Find failed row (❌), note ID (e.g. #5)

2. history_get { "id": 5 }
   → Full request/response details in one call, no re-execution

3. history_compare { "id1": 3, "id2": 5, "format": "unified" }
   → See what changed between success and failure
```

### Workflow: Environment Consistency Check
```
1. env_configure { "name": "dev", "baseUrl": "https://dev.api.com" }
   env_configure { "name": "prod", "baseUrl": "https://api.com" }

2. env_switch { "environmentId": 5 }
   http_request { "url": "/api/users/1" }  → Record #10

3. env_switch { "environmentId": 6 }
   http_request { "url": "/api/users/1" }  → Record #11

4. history_compare { "id1": 10, "id2": 11 }
   → "Response bodies are structurally identical." ✅
```

### Workflow: Data-Driven Bulk Testing
```
// Prepare CSV: /tmp/users.csv
// name,email
// Alice,alice@test.com
// Bob,bob@test.com

test_run_suite {
  "suiteName": "Bulk Create",
  "dataSource": { "type": "csv", "filePath": "/tmp/users.csv" },
  "steps": [{
    "stepName": "Create",
    "url": "/api/users",
    "method": "POST",
    "body": "{\"name\":\"{{row.name}}\",\"email\":\"{{row.email}}\"}"
  }]
}
```

### Workflow: Auto-Retry + Cache for Unstable APIs
```json
http_request {
  "url": "/api/unstable-endpoint",
  "retryCount": 3,
  "retryDelay": 1000,
  "cacheTtl": 60000,
  "assertBefore": { "type": "status", "operator": "lessThan", "expected": 500 }
}
```

---

## 🔒 6. Security & Data Protection

- **Auto-Redaction**: `Authorization`, `Cookie`, `x-api-key` headers and body fields containing `password`, `token`, `secret` are stored as `********` in history
- **Safe Allowlist**: Use `env_set_allowlist` to restrict outgoing requests to specific domains
- **DB Permissions**: SQLite file at `~/.postmcp/postmcp.db` has Unix permission `0600` (user-only)
- **No secrets in stdout**: All MCP communication is JSON-RPC on stdout; logs go to stderr

---

## 🧪 7. Error Recovery

postmcp is resilient:

| Failure | Recovery |
|---------|----------|
| HTTP connection refused | Throws clear error, logs to history with status 0 |
| DNS failure | Throws error, no crash |
| Invalid JSON body | Throws parse error, does not hang |
| OAuth token failure | Logs warning, request continues without auth (you'll get 401) |
| WebSocket disconnect | Connection removed from pool, next operation returns error |
| Request timeout | Throws after configured timeout, does not hang |
| File not found (upload) | Logs error per file, other files still upload |
| Concurrent DB writes | SQLite WAL mode handles concurrency |

---

## 📋 8. Complete Tool List

| Tool | Category | Key Parameters | Since |
|------|----------|---------------|:----:|
| `mcp_usage_guide` | Help | — | v1.0 |
| `project_create` | Project | name, description | v1.0 |
| `project_switch` | Project | projectId | v1.0 |
| `project_list` | Project | — | v1.0 |
| `project_rename` | Project | projectId, name | v1.1 |
| `project_delete` | Project | projectId | v1.0 |
| `env_configure` | Env | name, baseUrl, headers, cookies, variables, authType, authToken, apiKeyHeaderName, timeout, oauth2Config | v1.0 |
| `env_switch` | Env | environmentId | v1.0 |
| `env_list` | Env | — | v1.0 |
| `env_rename` | Env | environmentId, name | v1.1 |
| `env_delete` | Env | environmentId | v1.0 |
| `env_set_variable` | Env | key, value | v1.0 |
| `env_get_variable` | Env | key | v1.1 |
| `env_delete_variable` | Env | key | v1.1 |
| `env_list_variables` | Env | — | v1.1 |
| `env_set_allowlist` | Env | domains | v1.0 |
| `env_get_allowlist` | Env | — | v1.1 |
| `http_request` | HTTP | url, method, headers, params, body, bodyType, timeout, jsonpathFilter, fileFields, maxResponseLength, returnBody, retryCount, retryDelay, cacheTtl, assertBefore, assertions | v1.0 |
| `graphql_request` | HTTP | url, query, variables, operationName, headers, timeout | v1.1 |
| `ws_connect` | WS | url, headers, timeout | v1.0 |
| `ws_send` | WS | connectionId, message | v1.0 |
| `ws_read` | WS | connectionId, limit, waitForPattern, timeout | v1.0 |
| `ws_close` | WS | connectionId | v1.0 |
| `ws_list` | WS | — | v1.0 |
| `test_run_suite` | Suite | suiteName, dataSource, steps | v1.0 |
| `suite_save` | Suite | name, steps, description | v1.1 |
| `suite_load` | Suite | suiteId | v1.1 |
| `suite_list` | Suite | — | v1.1 |
| `suite_delete` | Suite | suiteId | v1.1 |
| `history_list` | History | limit, offset, environmentId, method, statusCode, urlKeyword, dateFrom, dateTo | v1.0 |
| `history_get` | History | id | v1.0 |
| `history_compare` | History | id1, id2, format | v1.0 |
| `history_clear` | History | olderThanSeconds | v1.0 |
| `history_export` | History | projectId | v1.1 |
| `swagger_import` | Import | url, filePath | v1.0 |
| `postman_import` | Import | filePath | v1.1 |
| `env_export` | Import/Export | environmentId | v1.1 |
| `env_import` | Import/Export | data, projectId | v1.1 |
| `project_export` | Import/Export | projectId | v1.1 |
| `project_import` | Import/Export | data | v1.1 |
| `db_status` | Admin | — | v1.0 |
| `db_reset` | Admin | confirm (required: true) | v1.0 |

---

> **Total: 37 MCP tools** covering project management, environment configuration, HTTP/GraphQL/WebSocket testing, assertion engine, chained suites, history audit & diff, import/export ecosystem, and database maintenance.
