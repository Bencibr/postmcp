#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

import { DbManager, EnvironmentRecord, ProjectRecord } from './db/sqlite.js';
import { HttpClient } from './client/http.js';
import { WebSocketManager } from './client/ws.js';
import { AssertionEngine, Assertion } from './utils/assertion.js';
import { TestReporter, TestSuiteResult, TestStepResult } from './utils/reporter.js';
import { DiffEngine } from './utils/diff.js';
import { SwaggerParser } from './utils/swagger.js';
import jp from 'jsonpath';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INSTRUCTIONS_PATH = path.join(__dirname, '..', 'ai_instructions.md');

// 1. Initialize core managers
const dbManager = new DbManager();
const httpClient = new HttpClient(dbManager);
const wsManager = new WebSocketManager(dbManager);
const swaggerParser = new SwaggerParser(dbManager);

// 2. Initialize MCP server
const server = new Server(
  {
    name: 'postmcp',
    version: '1.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper to redact auth values in environment view
function redactEnvironment(env: any) {
  const cloned = JSON.parse(JSON.stringify(env));
  if (cloned.authToken) {
    cloned.authToken = '********';
  }
  if (cloned.oauth2Config) {
    try {
      const parsed = JSON.parse(cloned.oauth2Config);
      if (parsed.clientSecret) {
        parsed.clientSecret = '********';
        cloned.oauth2Config = JSON.stringify(parsed);
      }
    } catch {}
  }
  return cloned;
}

// 3. Register tool list
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'mcp_usage_guide',
        description: 'Read the instructions and workflow guidelines for LLM agents to use this MCP server effectively (explains variables, interpolation, chaining, and websockets).',
        inputSchema: {
          type: 'object'
        }
      },
      // --- PROJECT MANAGEMENT ---
      {
        name: 'project_create',
        description: 'Create a new API testing project workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique name of the project (e.g. PaymentAPI)' },
            description: { type: 'string', description: 'Optional project details' }
          },
          required: ['name']
        }
      },
      {
        name: 'project_switch',
        description: 'Switch active project workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'number', description: 'Database ID of the project to switch to' }
          },
          required: ['projectId']
        }
      },
      {
        name: 'project_list',
        description: 'List all project workspaces in the database.',
        inputSchema: {
          type: 'object'
        }
      },
      {
        name: 'project_delete',
        description: 'Delete a project workspace (cascades and deletes its environments, credentials, and test history).',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'number', description: 'Database ID of the project to delete' }
          },
          required: ['projectId']
        }
      },

      // --- ENVIRONMENT MANAGEMENT ---
      {
        name: 'env_configure',
        description: 'Configure or create an environment profile (e.g. dev, prod) inside the active project. Saves credentials directly into the local SQLite DB.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name of environment (e.g., dev, prod, local)' },
            baseUrl: { type: 'string', description: 'Base URL for API requests (e.g. https://api.dev.example.com)' },
            headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Default headers' },
            cookies: { type: 'object', additionalProperties: { type: 'string' }, description: 'Default cookies' },
            variables: { type: 'object', description: 'Default variables key-value mapping' },
            authType: { type: 'string', enum: ['none', 'bearer', 'apiKey', 'oauth2'], default: 'none' },
            authToken: { type: 'string', description: 'Static token value (Bearer or API Key)' },
            apiKeyHeaderName: { type: 'string', description: 'Custom API Key header name (default: x-api-key)' },
            oauth2Config: {
              type: 'object',
              properties: {
                grantType: { type: 'string', enum: ['client_credentials'] },
                tokenUrl: { type: 'string', description: 'OAuth2 Token url' },
                clientId: { type: 'string' },
                clientSecret: { type: 'string' },
                scope: { type: 'string' }
              },
              required: ['grantType', 'tokenUrl', 'clientId', 'clientSecret']
            }
          },
          required: ['name']
        }
      },
      {
        name: 'env_switch',
        description: 'Switch active environment within the project workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            environmentId: { type: 'number', description: 'Database ID of the environment to switch to' }
          },
          required: ['environmentId']
        }
      },
      {
        name: 'env_list',
        description: 'List all environments configured under the active project.',
        inputSchema: {
          type: 'object'
        }
      },
      {
        name: 'env_delete',
        description: 'Delete an environment profile.',
        inputSchema: {
          type: 'object',
          properties: {
            environmentId: { type: 'number', description: 'Database ID of the environment to delete' }
          },
          required: ['environmentId']
        }
      },
      {
        name: 'env_set_variable',
        description: 'Set a variable key-value pair inside the active environment configuration.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Variable name' },
            value: { type: 'string', description: 'Variable string/number value' }
          },
          required: ['key', 'value']
        }
      },
      {
        name: 'env_set_allowlist',
        description: 'Configure target domains allowed for outgoing HTTP/WebSocket requests (e.g. ["localhost", "*.company.com"]). Set to empty array to allow all.',
        inputSchema: {
          type: 'object',
          properties: {
            domains: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of safe domains'
            }
          },
          required: ['domains']
        }
      },

      // --- HTTP REQUEST ---
      {
        name: 'http_request',
        description: 'Send a RESTful HTTP request. Automatically injects credentials and cookies from the active environment. Evaluates assertions and logs request/response details to history database.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Request path or full URL' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'], default: 'GET' },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            params: { type: 'object', additionalProperties: { type: 'string' } },
            body: { type: 'string', description: 'Request payload (string or stringified JSON)' },
            bodyType: { type: 'string', enum: ['json', 'urlencoded', 'form-data', 'raw'], default: 'json' },
            timeout: { type: 'number' },
            jsonpathFilter: { type: 'string', description: 'Extract specific parts of response payload' },
            assertions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['status', 'header', 'body', 'responseTime'] },
                  property: { type: 'string' },
                  operator: { type: 'string', enum: ['equals', 'notEquals', 'contains', 'notContains', 'exists', 'notExists', 'matches', 'greaterThan', 'lessThan', 'in', 'notIn'] },
                  expected: { type: 'string' }
                },
                required: ['type', 'operator']
              }
            }
          },
          required: ['url']
        }
      },

      // --- WEBSOCKET CLIENT ---
      {
        name: 'ws_connect',
        description: 'Open a persistent WebSocket connection, backed by headers and cookies from active environment. Returns connectionId.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'ws:// or wss:// URL (can be path if base URL matches)' },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            timeout: { type: 'number' }
          },
          required: ['url']
        }
      },
      {
        name: 'ws_send',
        description: 'Send a text or JSON frame down a WebSocket connection.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string', description: 'ID returned by ws_connect' },
            message: { type: 'string', description: 'Message payload' }
          },
          required: ['connectionId', 'message']
        }
      },
      {
        name: 'ws_read',
        description: 'Read the latest buffered messages. Can wait for specific regex pattern to arrive.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' },
            limit: { type: 'number', default: 50 },
            waitForPattern: { type: 'string', description: 'Wait for specific message to be logged' },
            timeout: { type: 'number' }
          },
          required: ['connectionId']
        }
      },
      {
        name: 'ws_close',
        description: 'Close connection.',
        inputSchema: {
          type: 'object',
          properties: {
            connectionId: { type: 'string' }
          },
          required: ['connectionId']
        }
      },
      {
        name: 'ws_list',
        description: 'List active socket connection IDs.',
        inputSchema: {
          type: 'object'
        }
      },

      // --- HISTORY & COMPARISON ---
      {
        name: 'history_list',
        description: 'List previous request-response audit records stored in the SQLite database.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', default: 20 },
            offset: { type: 'number', default: 0 },
            environmentId: { type: 'number', description: 'Filter logs by a specific environment ID' }
          }
        }
      },
      {
        name: 'history_get',
        description: 'Retrieve details of a specific request audit log by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Audit ID' }
          },
          required: ['id']
        }
      },
      {
        name: 'history_compare',
        description: 'Compare two request executions, checking metrics and structural JSON response body differences.',
        inputSchema: {
          type: 'object',
          properties: {
            id1: { type: 'number', description: 'First audit record ID' },
            id2: { type: 'number', description: 'Second audit record ID' }
          },
          required: ['id1', 'id2']
        }
      },
      {
        name: 'history_clear',
        description: 'Delete logs from history table.',
        inputSchema: {
          type: 'object',
          properties: {
            olderThanSeconds: { type: 'number', description: 'Optionally clear logs older than boundary seconds' }
          }
        }
      },

      // --- SEQUENTIAL TESTING FLOW RUNNER ---
      {
        name: 'test_run_suite',
        description: 'Execute multiple sequential REST requests, extract dynamic fields to active environment variables, run assertions, and output a testing Markdown report.',
        inputSchema: {
          type: 'object',
          properties: {
            suiteName: { type: 'string', description: 'Suite label' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  stepName: { type: 'string' },
                  url: { type: 'string' },
                  method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'], default: 'GET' },
                  headers: { type: 'object', additionalProperties: { type: 'string' } },
                  params: { type: 'object', additionalProperties: { type: 'string' } },
                  body: { type: 'string' },
                  bodyType: { type: 'string', enum: ['json', 'urlencoded', 'form-data', 'raw'], default: 'json' },
                  jsonpathFilter: { type: 'string' },
                  extractVariables: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                    description: 'Mapping: {"variableName": "$.json.path"}'
                  },
                  assertions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', enum: ['status', 'header', 'body', 'responseTime'] },
                        property: { type: 'string' },
                        operator: { type: 'string', enum: ['equals', 'notEquals', 'contains', 'notContains', 'exists', 'notExists', 'matches', 'greaterThan', 'lessThan', 'in', 'notIn'] },
                        expected: { type: 'string' }
                      },
                      required: ['type', 'operator']
                    }
                  }
                },
                required: ['stepName', 'url', 'method']
              }
            }
          },
          required: ['suiteName', 'steps']
        }
      },
      // --- DATABASE MAINTENANCE ---
      {
        name: 'db_status',
        description: 'Get statistics about the local SQLite database, including database file path, file size, and row counts of all tables.',
        inputSchema: {
          type: 'object'
        }
      },
      {
        name: 'db_reset',
        description: 'DANGER: Factory reset the SQLite database. Closes database, deletes the database file, and recreates a fresh blank schema with a DefaultProject.',
        inputSchema: {
          type: 'object'
        }
      },
      // --- SWAGGER IMPORT ---
      {
        name: 'swagger_import',
        description: 'Import API routes and schemas from a local Swagger/OpenAPI file or remote URL, outputting a structured Markdown API Reference.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Public URL to download swagger.json or openapi.json/yaml' },
            filePath: { type: 'string', description: 'Absolute path to local JSON/YAML Swagger specification' }
          }
        }
      }
    ]
  };
});

// Mustache variable interpolation helper
function interpolate(target: any, variables: Record<string, any>): any {
  if (typeof target === 'string') {
    return target.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
      const trimmed = key.trim();
      return variables[trimmed] !== undefined ? String(variables[trimmed]) : `{{${trimmed}}}`;
    });
  }
  if (Array.isArray(target)) {
    return target.map(item => interpolate(item, variables));
  }
  if (target !== null && typeof target === 'object') {
    const output: Record<string, any> = {};
    for (const [k, v] of Object.entries(target)) {
      output[k] = interpolate(v, variables);
    }
    return output;
  }
  return target;
}

// 4. Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'mcp_usage_guide': {
        let contentText = '';
        try {
          contentText = await fs.readFile(INSTRUCTIONS_PATH, 'utf8');
        } catch {
          contentText = `# AI Agent Guide: How to Use \`postmcp\`\n\n` +
            `This server is a local database-backed testing client designed for automated RESTful API and WebSocket endpoint verification.\n\n` +
            `- **Projects**: Use \`project_list\`, \`project_create\`, and \`project_switch\` to separate environments.\n` +
            `- **Environments**: Use \`env_configure\` and \`env_switch\` to configure baseUrl and credentials.\n` +
            `- **Variables**: Save variables with \`env_set_variable\`, then interpolate in requests via \`{{var_name}}\`.\n` +
            `- **Chaining tests**: Use \`test_run_suite\` to execute multiple steps sequentially and pass variables (via \`extractVariables\`) to subsequent steps.\n` +
            `- **WebSocket**: Connect with \`ws_connect\`, write messages with \`ws_send\`, and read with \`ws_read\` (pass \`waitForPattern\` regex to block/wait).\n` +
            `- **History**: Use \`history_list\` and \`history_compare\` to see JSON-diff response changes.\n` +
            `- **Swagger Import**: Use \`swagger_import\` to parse YAML/JSON specifications from URLs/paths to Markdown references.\n` +
            `- **Database Maintenance**: Use \`db_status\` to get file metrics, and \`db_reset\` to factory reset DB.`;
        }
        return {
          content: [{ type: 'text', text: contentText }]
        };
      }
      // --- PROJECTS ---
      case 'project_create': {
        const { name, description } = args as any;
        const id = await dbManager.createProject(name, description);
        return {
          content: [{ type: 'text', text: `Project "${name}" created with ID: ${id}. Switched environments defaults.` }]
        };
      }

      case 'project_switch': {
        const { projectId } = args as any;
        await dbManager.switchProject(projectId);
        const state = await dbManager.getActiveProjectAndEnv();
        return {
          content: [{ type: 'text', text: `Switched to project "${state.projectName}". Active Env is "${state.envName}".` }]
        };
      }

      case 'project_list': {
        const list = await dbManager.listProjects();
        return {
          content: [{ type: 'text', text: JSON.stringify(list, null, 2) }]
        };
      }

      case 'project_delete': {
        const { projectId } = args as any;
        await dbManager.deleteProject(projectId);
        return {
          content: [{ type: 'text', text: `Project ID ${projectId} deleted.` }]
        };
      }

      // --- ENVIRONMENTS ---
      case 'env_configure': {
        const { name, baseUrl, headers, cookies, variables, authType, authToken, apiKeyHeaderName, oauth2Config } = args as any;
        const projId = await dbManager.getActiveProjectId();
        
        const envData = {
          ...(baseUrl !== undefined && { baseUrl }),
          headers: headers ? JSON.stringify(headers) : undefined,
          cookies: cookies ? JSON.stringify(cookies) : undefined,
          variables: variables ? JSON.stringify(variables) : undefined,
          authType,
          authToken,
          apiKeyHeaderName,
          oauth2Config: oauth2Config ? JSON.stringify(oauth2Config) : undefined
        };

        const id = await dbManager.configureEnvironment(projId, name, envData);
        return {
          content: [{ type: 'text', text: `Environment "${name}" configured successfully (ID: ${id}) under active project ID: ${projId}.` }]
        };
      }

      case 'env_switch': {
        const { environmentId } = args as any;
        await dbManager.switchEnvironment(environmentId);
        const state = await dbManager.getActiveProjectAndEnv();
        return {
          content: [{ type: 'text', text: `Switched active environment to "${state.envName}" in project "${state.projectName}".` }]
        };
      }

      case 'env_list': {
        const projId = await dbManager.getActiveProjectId();
        const list = await dbManager.listEnvironments(projId);
        const state = await dbManager.getActiveProjectAndEnv();
        
        const redactedList = list.map(env => ({
          ...redactEnvironment(env),
          isActive: env.id === state.envId
        }));

        return {
          content: [{ type: 'text', text: JSON.stringify(redactedList, null, 2) }]
        };
      }

      case 'env_delete': {
        const { environmentId } = args as any;
        await dbManager.deleteEnvironment(environmentId);
        return {
          content: [{ type: 'text', text: `Environment ID ${environmentId} deleted.` }]
        };
      }

      case 'env_set_variable': {
        const { key, value } = args as any;
        const state = await dbManager.getActiveProjectAndEnv();
        await dbManager.setEnvironmentVariable(state.envId, key, value);
        return {
          content: [{ type: 'text', text: `Set variable "${key}" = "${value}" in environment "${state.envName}" (Project: ${state.projectName}).` }]
        };
      }

      case 'env_set_allowlist': {
        const { domains } = args as any;
        await dbManager.setAllowlist(domains);
        return {
          content: [{ type: 'text', text: `URL Allowlist configured: ${JSON.stringify(domains)}` }]
        };
      }

      // --- HTTP REQUEST ---
      case 'http_request': {
        const { url, method, headers, params, body, bodyType, timeout, jsonpathFilter, assertions } = args as any;
        
        const state = await dbManager.getActiveProjectAndEnv();
        const env = await dbManager.getEnvironmentById(state.envId);
        const variables = JSON.parse(env?.variables || '{}');

        // Interpolate templates
        const finalUrl = interpolate(url, variables);
        const finalHeaders = headers ? interpolate(headers, variables) : undefined;
        const finalParams = params ? interpolate(params, variables) : undefined;
        const finalBody = body ? interpolate(body, variables) : undefined;

        const response = await httpClient.send({
          url: finalUrl,
          method: method || 'GET',
          headers: finalHeaders,
          params: finalParams,
          body: finalBody,
          bodyType,
          timeout,
          jsonpathFilter
        });

        let outputText = `### Response Info\n`;
        outputText += `- **Project**: \`${state.projectName}\` | **Environment**: \`${state.envName}\`\n`;
        outputText += `- **URL**: \`${finalUrl}\`\n`;
        outputText += `- **Status**: ${response.status} ${response.statusText}\n`;
        outputText += `- **Duration**: ${response.durationMs}ms\n\n`;

        if (assertions && assertions.length > 0) {
          const report = AssertionEngine.run(response, assertions as Assertion[]);
          outputText += `### Assertions (${report.summary.passed}/${report.summary.total} Passed)\n`;
          for (const res of report.results) {
            outputText += `- [${res.passed ? 'x' : ' '}] \`${res.assertion.type}\` (property: \`${res.assertion.property || ''}\` ${res.assertion.operator} \`${res.assertion.expected || ''}\`): ${res.message}\n`;
          }
          outputText += `\n`;
        }

        outputText += `### Headers\n\`\`\`json\n${JSON.stringify(response.headers, null, 2)}\n\`\`\`\n\n`;
        outputText += `### Body\n`;
        if (typeof response.body === 'object') {
          outputText += `\`\`\`json\n${JSON.stringify(response.body, null, 2)}\n\`\`\``;
        } else {
          outputText += `\`\`\`\n${response.body}\n\`\`\``;
        }

        return {
          content: [{ type: 'text', text: outputText }]
        };
      }

      // --- WEBSOCKET CLIENT ---
      case 'ws_connect': {
        const { url, headers, timeout } = args as any;
        const result = await wsManager.connect(url, headers, timeout);
        return {
          content: [{ type: 'text', text: `WebSocket connected.\n- Connection ID: ${result.connectionId}\n- Status: ${result.status}` }]
        };
      }

      case 'ws_send': {
        const { connectionId, message } = args as any;
        let finalMessage = message;
        try {
          finalMessage = JSON.parse(message);
        } catch {}
        await wsManager.send(connectionId, finalMessage);
        return {
          content: [{ type: 'text', text: `Message sent to WebSocket connection "${connectionId}".` }]
        };
      }

      case 'ws_read': {
        const { connectionId, limit, waitForPattern, timeout } = args as any;
        const messages = await wsManager.read(connectionId, limit, waitForPattern, timeout);
        
        let md = `### Messages for Connection: ${connectionId}\n\n`;
        if (messages.length === 0) {
          md += `No messages buffered.`;
        } else {
          md += `| Timestamp | Direction | Message |\n`;
          md += `| :--- | :--- | :--- |\n`;
          for (const msg of messages) {
            const time = new Date(msg.timestamp).toISOString().split('T')[1].slice(0, -1);
            const dir = msg.direction === 'incoming' ? '📥 IN' : '📤 OUT';
            md += `| \`${time}\` | **${dir}** | \`${msg.data}\` |\n`;
          }
        }

        return {
          content: [{ type: 'text', text: md }]
        };
      }

      case 'ws_close': {
        const { connectionId } = args as any;
        await wsManager.close(connectionId);
        return {
          content: [{ type: 'text', text: `WebSocket connection "${connectionId}" closed.` }]
        };
      }

      case 'ws_list': {
        const conns = wsManager.listConnections();
        if (conns.length === 0) {
          return { content: [{ type: 'text', text: 'No active WebSocket connections.' }] };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(conns, null, 2) }]
        };
      }

      // --- HISTORY & COMPARISON ---
      case 'history_list': {
        const { limit, offset, environmentId } = args as any;
        const activeState = await dbManager.getActiveProjectAndEnv();
        
        // If environmentId is not specified, we pull filters by active projectId
        const list = await dbManager.listHistory({
          limit,
          offset,
          environmentId,
          ...(!environmentId && { projectId: activeState.projectId })
        });

        let md = `## 📖 History Audit Logs (Project: ${activeState.projectName})\n\n`;
        if (list.length === 0) {
          md += `No logs found in DB.`;
        } else {
          md += `| ID | Time | Env | Method | URL | Status | Duration | Success |\n`;
          md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
          for (const row of list) {
            const dateStr = new Date(row.timestamp).toISOString().split('T')[0];
            const timeStr = new Date(row.timestamp).toISOString().split('T')[1].slice(0, 8);
            const status = row.responseStatus === 0 ? 'FAIL' : String(row.responseStatus);
            const passIcon = row.success === 1 ? '✅' : '❌';
            md += `| \`${row.id}\` | \`${dateStr} ${timeStr}\` | \`${row.environmentName}\` | \`${row.method}\` | \`${row.url}\` | \`${status}\` | ${row.durationMs}ms | ${passIcon} |\n`;
          }
        }

        return {
          content: [{ type: 'text', text: md }]
        };
      }

      case 'history_get': {
        const { id } = args as any;
        const row = await dbManager.getHistoryById(id);
        if (!row) {
          return {
            isError: true,
            content: [{ type: 'text', text: `History record ID ${id} not found.` }]
          };
        }
        
        let md = `### Request Record #${row.id} Details\n\n`;
        md += `- **Project**: \`${row.projectName}\` | **Environment**: \`${row.environmentName}\`\n`;
        md += `- **Timestamp**: \`${row.timestamp}\`\n`;
        md += `- **Method**: \`${row.method}\` | **URL**: \`${row.url}\`\n`;
        md += `- **Status**: \`${row.responseStatus}\` | **Duration**: \`${row.durationMs}ms\`\n`;
        md += `- **Outcome**: ${row.success === 1 ? '✅ Success' : '❌ Fail/Exception'}\n\n`;
        
        md += `#### Headers\n\`\`\`json\n${JSON.stringify(JSON.parse(row.requestHeaders || '{}'), null, 2)}\n\`\`\`\n\n`;
        md += `#### Body Sent\n\`\`\`\n${row.requestBody || '*none*'}\n\`\`\`\n\n`;
        md += `#### Response Headers\n\`\`\`json\n${JSON.stringify(JSON.parse(row.responseHeaders || '{}'), null, 2)}\n\`\`\`\n\n`;
        md += `#### Response Body\n\`\`\`json\n${row.responseBody || '*none*'}\n\`\`\``;

        return {
          content: [{ type: 'text', text: md }]
        };
      }

      case 'history_compare': {
        const { id1, id2 } = args as any;
        const record1 = await dbManager.getHistoryById(id1);
        const record2 = await dbManager.getHistoryById(id2);

        if (!record1 || !record2) {
          return {
            isError: true,
            content: [{ type: 'text', text: `One or both comparison record IDs (${id1}, ${id2}) not found.` }]
          };
        }

        const mdDiff = DiffEngine.renderMarkdownDiff(
          record1.id,
          record2.id,
          record1.responseStatus,
          record2.responseStatus,
          record1.durationMs,
          record2.durationMs,
          record1.responseBody || '',
          record2.responseBody || ''
        );

        return {
          content: [{ type: 'text', text: mdDiff }]
        };
      }

      case 'history_clear': {
        const { olderThanSeconds } = args as any;
        const changes = await dbManager.clearHistory(olderThanSeconds);
        return {
          content: [{ type: 'text', text: `Deleted ${changes} records from history database.` }]
        };
      }

      // --- SEQUENTIAL TESTING SUITE RUNNER ---
      case 'test_run_suite': {
        const { suiteName, steps } = args as any;
        const startTime = Date.now();
        const stepResults: TestStepResult[] = [];
        
        const state = await dbManager.getActiveProjectAndEnv();
        const env = await dbManager.getEnvironmentById(state.envId);
        if (!env) throw new Error('Active environment configs not loaded.');

        const variables = JSON.parse(env.variables || '{}');

        for (const step of steps) {
          const { stepName, url, method, headers, params, body, bodyType, jsonpathFilter, extractVariables, assertions } = step;

          const finalUrl = interpolate(url, variables);
          const finalHeaders = headers ? interpolate(headers, variables) : undefined;
          const finalParams = params ? interpolate(params, variables) : undefined;
          const finalBody = body ? interpolate(body, variables) : undefined;

          try {
            const response = await httpClient.send({
              url: finalUrl,
              method: method || 'GET',
              headers: finalHeaders,
              params: finalParams,
              body: finalBody,
              bodyType,
              jsonpathFilter
            });

            let assertionReport = undefined;
            if (assertions && assertions.length > 0) {
              assertionReport = AssertionEngine.run(response, assertions as Assertion[]);
            }

            // Extract variables and update environment database variables record
            if (extractVariables && Object.keys(extractVariables).length > 0) {
              let parsedBody = response.fullBody !== undefined ? response.fullBody : response.body;
              if (typeof parsedBody === 'string') {
                try { parsedBody = JSON.parse(parsedBody); } catch {}
              }

              for (const [varName, pathExpr] of Object.entries(extractVariables)) {
                try {
                  const nodes = jp.query(parsedBody, String(pathExpr));
                  if (nodes.length > 0) {
                    variables[varName] = nodes[0];
                    await dbManager.setEnvironmentVariable(state.envId, varName, nodes[0]);
                  }
                } catch (jpErr: any) {
                  console.error(`Variables extract failed in suite step "${stepName}": ${jpErr.message}`);
                }
              }
            }

            stepResults.push({
              stepName,
              url: finalUrl,
              method: method || 'GET',
              responseStatus: response.status,
              durationMs: response.durationMs,
              assertionReport
            });

          } catch (err: any) {
            stepResults.push({
              stepName,
              url: finalUrl,
              method: method || 'GET',
              error: err.message
            });
          }
        }

        const endTime = Date.now();
        const passed = stepResults.every(s => !s.error && (!s.assertionReport || s.assertionReport.passed));

        const suiteResult: TestSuiteResult = {
          suiteName,
          passed,
          steps: stepResults,
          startTime,
          endTime
        };

        const mdReport = TestReporter.generateMarkdown(suiteResult);
        return {
          content: [{ type: 'text', text: mdReport }]
        };
      }

      case 'db_status': {
        const stats = await dbManager.getDatabaseStats();
        const kbSize = (stats.fileSize / 1024).toFixed(2);
        
        let md = `## 📊 Database Status Statistics\n\n`;
        md += `- **Database Path**: \`${stats.filePath}\`\n`;
        md += `- **File Size**: \`${kbSize} KB\` (\`${stats.fileSize} bytes\`)\n\n`;
        md += `### 📋 Table Record Counts\n\n`;
        md += `| Table | Records Count |\n`;
        md += `| :--- | :--- |\n`;
        md += `| **Projects** | \`${stats.projectsCount}\` |\n`;
        md += `| **Environments** | \`${stats.environmentsCount}\` |\n`;
        md += `| **Request Logs (History)** | \`${stats.historyCount}\` |\n`;
        md += `| **OAuth2 Token Cache** | \`${stats.authCacheCount}\` |\n`;

        return {
          content: [{ type: 'text', text: md }]
        };
      }

      case 'db_reset': {
        await dbManager.resetDatabase();
        return {
          content: [{ type: 'text', text: '✅ Database has been successfully reset. Deleted all data, re-created tables, and initialized default settings.' }]
        };
      }

      case 'swagger_import': {
        const { url, filePath } = args as any;
        const mdDoc = await swaggerParser.importSpec({ url, filePath });
        return {
          content: [{ type: 'text', text: mdDoc }]
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Tool Execution Error: ${err.message}` }]
    };
  }
});

// 5. Connect transport and start server
async function main() {
  await dbManager.initialize();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('postmcp Server running on SQLite unified database stdio transport');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});

// Clean sockets on shutdown
process.on('SIGINT', async () => {
  await wsManager.cleanupAll();
  await dbManager.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await wsManager.cleanupAll();
  await dbManager.close();
  process.exit(0);
});
