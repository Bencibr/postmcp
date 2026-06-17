# AI Agent Guide: How to Use `postmcp`

You are an AI Agent with access to the `postmcp` toolset. This server is a local database-backed testing client designed for automated RESTful API and WebSocket endpoint verification. All project workspaces, environment variables, credentials, test histories, and connection states are persisted in a local SQLite database located at `~/.postmcp/postmcp.db`.

Read these instructions carefully to interact with the tools efficiently, handle auth flows, structure assertions, run sequential test suites, and manage persistence.

---

## 🧭 Workflow & Core Concepts

### 1. Project Workspaces and Environment Profiles
The server maintains state for the active project and environment. All configurations, variables, and history records are scoped to an **Environment Profile**, which belongs to a **Project Workspace**.
- **Workflow**:
  1. Use `project_list` to view existing workspaces, or `project_create` to start a new one.
  2. Switch projects via `project_switch`.
  3. Configure environment credentials (e.g., `dev`, `prod`) using `env_configure`.
  4. Activate an environment using `env_switch`.
  5. Check active status using `env_list` (which returns environment records with active flags).

### 2. Variable Interpolation
Environment variables are stored inside the database per environment. You can dynamically insert variables into request URLs, params, headers, or body using mustache-like syntax: `{{variable_name}}`.
- **Example**:
  - Environment variables: `{"userId": 42, "token": "abc-123"}`
  - Request URL: `/users/{{userId}}`
  - Request Headers: `{"Authorization": "Bearer {{token}}"}`
  - During execution, these are automatically replaced with their literal values.

### 3. Context Window Protection (Response Selection)
LLM context windows are valuable. Large JSON responses can bloat your memory.
- **Best Practice**: If you only need a specific field, use the `jsonpathFilter` parameter (e.g. `$.data.items[0].id`). The HTTP tool will filter the response using JSONPath before returning it to you.
- Large responses are truncated automatically at 15,000 characters by default. Note that this truncation only applies to the text body returned to you in your chat window; internal **variable extraction** (via `extractVariables` in `test_run_suite`) and the **assertion engine** will automatically evaluate against the full, un-truncated response payload.

### 4. Safe Domain Allowlists
Outgoing requests are constrained by a safe host allowlist to prevent SSRF or unauthorized external calls.
- By default, the allowlist is empty, meaning all domains are permitted.
- If domains are configured via `env_set_allowlist` (e.g. `["localhost", "*.company.internal"]`), any request to an unlisted domain will be rejected with an "Access Denied" error.
- Pass `[]` to `env_set_allowlist` to disable restriction.

---

## 🛠️ Complete Tool API Reference

### 1. Help Guide
* **`mcp_usage_guide`**
  * **Description**: Read the dynamically loaded guide (this document).
  * **Input**: None

### 2. Project Workspaces (`project_*`)
* **`project_create`**
  * **Arguments**:
    * `name` (string, required): Unique name of the workspace.
    * `description` (string, optional): Details about the workspace.
* **`project_switch`**
  * **Arguments**:
    * `projectId` (number, required): ID of the project to activate.
* **`project_list`**
  * **Arguments**: None (returns all projects, identifying the active one).
* **`project_delete`**
  * **Arguments**:
    * `projectId` (number, required): ID of the project to delete. Cascades and deletes environments, auth cache, and history.

### 3. Environment Profiles & Credentials (`env_*`)
* **`env_configure`**
  * **Description**: Set base URLs, default headers, cookies, variables, and authentication schemes for the active project.
  * **Arguments**:
    * `name` (string, required): Environment name (e.g. `dev`, `prod`).
    * `baseUrl` (string, optional): Base URL prefixed to relative request paths (e.g. `http://localhost:8080`).
    * `headers` (object, optional): Default HTTP headers to inject.
    * `cookies` (object, optional): Default HTTP cookies to inject.
    * `variables` (object, optional): Variables dictionary.
    * `authType` (string, optional): `"none"`, `"bearer"`, `"apiKey"`, `"oauth2"`.
    * `authToken` (string, optional): Raw token value for `bearer` or `apiKey`.
    * `apiKeyHeaderName` (string, optional): Custom header key for `apiKey` (default: `"x-api-key"`).
    * `oauth2Config` (object, optional): Configuration for `"oauth2"` Client Credentials grant. Required if `authType` is `"oauth2"`.
      * `grantType` (string, enum: `["client_credentials"]`): The grant type.
      * `tokenUrl` (string): OAuth2 token endpoint URL.
      * `clientId` (string): OAuth2 Client ID.
      * `clientSecret` (string): OAuth2 Client Secret.
      * `scope` (string, optional): Optional scope parameter.
  * **Example OAuth2 Configuration**:
    ```json
    {
      "name": "dev",
      "baseUrl": "https://api.dev.example.com",
      "authType": "oauth2",
      "oauth2Config": {
        "grantType": "client_credentials",
        "tokenUrl": "https://auth.example.com/oauth/token",
        "clientId": "client-id-123",
        "clientSecret": "super-secret-key",
        "scope": "read:items write:items"
      }
    }
    ```
* **`env_switch`**
  * **Arguments**:
    * `environmentId` (number, required): ID of the environment to activate.
* **`env_list`**
  * **Arguments**: None (Lists environments in active project; sensitive tokens are automatically masked as `********`).
* **`env_delete`**
  * **Arguments**:
    * `environmentId` (number, required): ID of the environment to delete.
* **`env_set_variable`**
  * **Arguments**:
    * `key` (string, required): Variable key.
    * `value` (string, required): Variable value.
* **`env_set_allowlist`**
  * **Arguments**:
    * `domains` (array of strings, required): Safe domains (e.g., `["localhost", "*.api.com"]`). Pass `[]` to allow all.

### 4. HTTP Request Testing (`http_request`)
* **Description**: Send a RESTful HTTP request. Automatically injects credentials and cookies from the active environment, interpolates variables, evaluates assertions, and audits records to history.
* **Arguments**:
  * `url` (string, required): Target URL path (e.g. `/api/v1/users` or `https://external.com/api`).
  * `method` (string, default: `GET`): `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`.
  * `headers` (object, optional): Custom request headers.
  * `params` (object, optional): URL query parameters.
  * `body` (string, optional): Request payload (raw string or stringified JSON).
  * `bodyType` (string, default: `json`): `json`, `urlencoded`, `form-data`, `raw`.
  * `timeout` (number, optional): Request timeout in milliseconds.
  * `jsonpathFilter` (string, optional): Filter response body before returning to AI (e.g. `$.data.id`).
  * `assertions` (array of objects, optional): Validation checks.
    * Each assertion contains:
      * `type` (string, required): `status`, `header`, `body`, `responseTime`.
      * `property` (string, optional): Header key (for `header`) or JSONPath expression (for `body`).
      * `operator` (string, required): `equals`, `notEquals`, `contains`, `notContains`, `exists`, `notExists`, `matches`, `greaterThan`, `lessThan`, `in`, `notIn`.
      * `expected` (any, optional): Expected value to check against.
* **Example HTTP Request with Assertions**:
  ```json
  {
    "url": "/api/users/{{userId}}",
    "method": "GET",
    "jsonpathFilter": "$.user",
    "assertions": [
      { "type": "status", "operator": "equals", "expected": 200 },
      { "type": "responseTime", "operator": "lessThan", "expected": 500 },
      { "type": "body", "property": "$.user.email", "operator": "contains", "expected": "@example.com" }
    ]
  }
  ```

### 5. Multi-Step Test Suites (`test_run_suite`)
* **Description**: Execute multiple sequential REST requests, extract variables from responses, evaluate assertions, and generate a structured Markdown testing report. Perfect for complex multi-step workflows.
* **Arguments**:
  * `suiteName` (string, required): Name of the test suite.
  * `steps` (array of step objects, required):
    * Each step contains:
      * `stepName` (string, required): Name/Description of the step.
      * `url`, `method`, `headers`, `params`, `body`, `bodyType`, `jsonpathFilter`, `assertions`: Same as `http_request`.
      * `extractVariables` (object, optional): Key-value map representing `{"variableName": "$.json.path"}` to extract from the response and save to the active environment for subsequent steps.
* **Example Chaining Suite**:
  ```json
  {
    "suiteName": "User Creation Workflow",
    "steps": [
      {
        "stepName": "Generate Auth Token",
        "url": "/oauth/token",
        "method": "POST",
        "body": "{\"username\":\"admin\",\"password\":\"secret\"}",
        "extractVariables": {
          "sessionToken": "$.access_token"
        },
        "assertions": [
          { "type": "status", "operator": "equals", "expected": 200 }
        ]
      },
      {
        "stepName": "Create User Account",
        "url": "/api/users",
        "method": "POST",
        "headers": {
          "Authorization": "Bearer {{sessionToken}}"
        },
        "body": "{\"name\":\"Alice\",\"email\":\"alice@example.com\"}",
        "extractVariables": {
          "newUserId": "$.id"
        },
        "assertions": [
          { "type": "status", "operator": "equals", "expected": 201 }
        ]
      },
      {
        "stepName": "Verify User Exists",
        "url": "/api/users/{{newUserId}}",
        "method": "GET",
        "headers": {
          "Authorization": "Bearer {{sessionToken}}"
        },
        "assertions": [
          { "type": "status", "operator": "equals", "expected": 200 },
          { "type": "body", "property": "$.name", "operator": "equals", "expected": "Alice" }
        ]
      }
    ]
  }
  ```

### 6. Persistent WebSocket Testing (`ws_*`)
WebSocket communication is asynchronous. Maintain connections via connection pools:
* **`ws_connect`**
  * **Arguments**:
    * `url` (string, required): WebSocket endpoint URL (`ws://` or `wss://`). If relative path is provided, it resolves against active environment's `baseUrl` host.
    * `headers` (object, optional): Headers to inject on connection handshake.
* **`ws_send`**
  * **Arguments**:
    * `connectionId` (string, required): Connection ID returned by `ws_connect`.
    * `message` (string, required): Raw text or stringified JSON payload to transmit.
* **`ws_read`**
  * **Description**: Read incoming buffered socket frames.
  * **Arguments**:
    * `connectionId` (string, required): Connection ID.
    * `limit` (number, default: 50): Max messages to retrieve.
    * `waitForPattern` (string, optional): Regular expression. If provided, the tool blocks synchronously to listen for a incoming message matching the regex, preventing timing race conditions.
    * `timeout` (number, optional): Milliseconds to wait before returning if `waitForPattern` is used.
* **`ws_close`**
  * **Arguments**:
    * `connectionId` (string, required): Connection ID.
* **`ws_list`**
  * **Arguments**: None (returns all active socket connections).

### 7. Request History & Comparison (`history_*`)
* **`history_list`**
  * **Arguments**:
    * `limit` (number, default: 20): Logs to return.
    * `offset` (number, default: 0): Paging offset.
    * `environmentId` (number, optional): Filter by environment ID.
* **`history_get`**
  * **Arguments**:
    * `id` (number, required): Specific log record ID to inspect.
* **`history_compare`**
  * **Description**: Generates a timing and structural JSON delta diff comparing response body changes between two request executions (e.g. before/after updates or environment checks).
  * **Arguments**:
    * `id1` (number, required): ID of first request execution.
    * `id2` (number, required): ID of second request execution.
* **`history_clear`**
  * **Arguments**:
    * `olderThanSeconds` (number, optional): Optional expiration threshold in seconds.

### 8. Swagger / OpenAPI Spec Import (`swagger_import`)
* **Description**: Fetch and parse OpenAPI v2.0 / v3.x YAML or JSON specifications. Automatically outputs a complete Markdown API Reference documenting host parameters, paths, requests, schemas, and queries.
* **Arguments**:
  * `url` (string, optional): Remote spec URL (e.g., `https://petstore.swagger.io/v2/swagger.json`).
  * `filePath` (string, optional): Absolute local filepath to the spec file.

### 9. Database Maintenance (`db_*`)
* **`db_status`**
  * **Description**: Return absolute SQLite database filepath, file size in KB, and table row counts.
  * **Arguments**: None
* **`db_reset`**
  * **Description**: **DANGER**: Perform a factory reset. Closes active databases, deletes the file, and re-initializes a fresh SQLite database schema with `DefaultProject`.
  * **Arguments**: None

---

## 🔒 Security & Secrets Redaction

1. **Auto-Redaction**: Headers containing credentials (`Authorization`, `Cookie`, `x-api-key`) and body payload properties containing sensitive strings (`password`, `client_secret`, `token`, `access_token`) are automatically scrubbed and logged as `********` inside the history database records.
2. **Access Security**: The SQLite database file enforces standard UNIX user-restricted permissions (`0600`) to guarantee that local users cannot inspect cached secrets.
