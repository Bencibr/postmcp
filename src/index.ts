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
import { logger } from './utils/logger.js';
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
      {
        name: 'project_rename',
        description: 'Rename an existing project workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'number', description: 'Database ID of the project to rename' },
            name: { type: 'string', description: 'New unique name for the project' }
          },
          required: ['projectId', 'name']
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
            baseUrl: { type: 'string', description: 'Base URL for API requests (e.g. https://api.dev.example.com). Supports {{var}} interpolation from environment variables.' },
            headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Default headers' },
            cookies: { type: 'object', additionalProperties: { type: 'string' }, description: 'Default cookies' },
            variables: { type: 'object', description: 'Default variables key-value mapping' },
            authType: { type: 'string', enum: ['none', 'bearer', 'apiKey', 'basic', 'oauth2'], default: 'none' },
            authToken: { type: 'string', description: 'Static token value (Bearer or API Key)' },
            apiKeyHeaderName: { type: 'string', description: 'Custom API Key header name (default: x-api-key)' },
            timeout: { type: 'number', description: 'Default request timeout in milliseconds (default: 30000)' },
            oauth2Config: {
              type: 'object',
              properties: {
                grantType: { type: 'string', enum: ['client_credentials', 'password'] },
                tokenUrl: { type: 'string', description: 'OAuth2 Token url' },
                clientId: { type: 'string' },
                clientSecret: { type: 'string' },
                scope: { type: 'string' },
                username: { type: 'string', description: 'Username for password grant type' },
                password: { type: 'string', description: 'Password for password grant type' }
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
        name: 'env_get_variable',
        description: 'Get the value of a specific variable from the active environment.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Variable name' }
          },
          required: ['key']
        }
      },
      {
        name: 'env_delete_variable',
        description: 'Delete a variable from the active environment configuration.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Variable name to delete' }
          },
          required: ['key']
        }
      },
      {
        name: 'env_list_variables',
        description: 'List all variables defined in the active environment.',
        inputSchema: { type: 'object' }
      },
      {
        name: 'env_rename',
        description: 'Rename an existing environment profile.',
        inputSchema: {
          type: 'object',
          properties: {
            environmentId: { type: 'number', description: 'Database ID of the environment to rename' },
            name: { type: 'string', description: 'New name for the environment' }
          },
          required: ['environmentId', 'name']
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
      {
        name: 'env_get_allowlist',
        description: 'Get the current URL allowlist configuration.',
        inputSchema: { type: 'object' }
      },

      // --- HTTP REQUEST ---
      {
        name: 'http_request',
        description: 'Send a RESTful HTTP request. Automatically injects credentials and cookies from the active environment. Evaluates assertions and logs request/response details to history database.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Request path or full URL' },
            method: { type: 'string', default: 'GET', description: 'HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS, or any custom method)' },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            params: { type: 'object', additionalProperties: { type: 'string' } },
            body: { type: 'string', description: 'Request payload (string or stringified JSON)' },
            bodyType: { type: 'string', enum: ['json', 'urlencoded', 'form-data', 'raw'], default: 'json' },
            timeout: { type: 'number', description: 'Request timeout in ms (overrides environment default)' },
            jsonpathFilter: { type: 'string', description: 'Extract specific parts of response payload' },
            fileFields: { type: 'object', additionalProperties: { type: 'string' }, description: 'File uploads: {"fieldName": "/path/to/file"} for form-data body type' },
            maxResponseLength: { type: 'number', description: 'Max response body length in chars (default: 15000). Set higher for full responses, lower to save tokens.' },
            returnBody: { type: 'boolean', description: 'Set false to skip response body (silent mode). Returns only status + duration. Saves tokens.' },
            retryCount: { type: 'number', description: 'Auto-retry count on network errors or 5xx (default: 0)' },
            retryDelay: { type: 'number', description: 'Delay between retries in ms (default: 1000)' },
            cacheTtl: { type: 'number', description: 'Cache TTL in ms for GET/HEAD requests. Same URL within TTL returns cached response. Saves network calls.' },
            assertBefore: {
              type: 'object',
              description: 'Conditional request: only return full response if condition is met (saves tokens on failures)',
              properties: {
                type: { type: 'string', enum: ['status', 'header', 'body'] },
                property: { type: 'string', description: 'JSONPath for body type, header name for header type' },
                operator: { type: 'string', enum: ['equals', 'notEquals', 'contains', 'exists', 'matches', 'greaterThan', 'lessThan'] },
                expected: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] }
              },
              required: ['type', 'operator']
            },
            assertions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['status', 'header', 'body', 'responseTime'] },
                  property: { type: 'string' },
                  operator: { type: 'string', enum: ['equals', 'notEquals', 'contains', 'notContains', 'exists', 'notExists', 'matches', 'greaterThan', 'lessThan', 'in', 'notIn'] },
                  expected: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] }
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
            environmentId: { type: 'number', description: 'Filter logs by a specific environment ID' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'], description: 'Filter by HTTP method' },
            statusCode: { type: 'number', description: 'Filter by response status code' },
            urlKeyword: { type: 'string', description: 'Filter by URL keyword' },
            dateFrom: { type: 'string', description: 'Filter records from this ISO date/time (inclusive)' },
            dateTo: { type: 'string', description: 'Filter records up to this ISO date/time (inclusive)' }
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
            id2: { type: 'number', description: 'Second audit record ID' },
            format: { type: 'string', enum: ['table', 'unified'], default: 'table', description: 'Diff output format: table (default) or unified (compact diff style)' }
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
            dataSource: {
              type: 'object',
              description: 'Data-Driven Testing: load test data from CSV/JSON file and run suite for each row. Use {{row.columnName}} in step fields.',
              properties: {
                type: { type: 'string', enum: ['csv', 'json'], description: 'Data file format' },
                filePath: { type: 'string', description: 'Absolute path to CSV or JSON data file' }
              },
              required: ['type', 'filePath']
            },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  stepName: { type: 'string' },
                  url: { type: 'string' },
                  method: { type: 'string', default: 'GET', description: 'HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS, or custom)' },
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
                        expected: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] }
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
          type: 'object',
          properties: {
            confirm: { type: 'boolean', description: 'Must be true to confirm the destructive reset operation' }
          },
          required: ['confirm']
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
      },
      // --- GRAPHQL ---
      {
        name: 'graphql_request',
        description: 'Send a GraphQL query/mutation to a GraphQL endpoint. Automatically injects credentials and variables.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'GraphQL endpoint URL (absolute or relative path)' },
            query: { type: 'string', description: 'GraphQL query or mutation string' },
            variables: { type: 'object', description: 'GraphQL variables object (optional)' },
            operationName: { type: 'string', description: 'GraphQL operation name (optional)' },
            headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Additional request headers' },
            timeout: { type: 'number' }
          },
          required: ['url', 'query']
        }
      },
      // --- TEST SUITE PERSISTENCE ---
      {
        name: 'suite_save',
        description: 'Save or update a named test suite in the database under the active project.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Suite name (unique per project)' },
            steps: { type: 'array', items: { type: 'object' }, description: 'Array of step objects (same format as test_run_suite steps)' },
            description: { type: 'string', description: 'Optional suite description' }
          },
          required: ['name', 'steps']
        }
      },
      {
        name: 'suite_load',
        description: 'Load a saved test suite by ID and execute it immediately.',
        inputSchema: {
          type: 'object',
          properties: {
            suiteId: { type: 'number', description: 'Database ID of the saved suite' }
          },
          required: ['suiteId']
        }
      },
      {
        name: 'suite_list',
        description: 'List all saved test suites under the active project.',
        inputSchema: { type: 'object' }
      },
      {
        name: 'suite_delete',
        description: 'Delete a saved test suite.',
        inputSchema: {
          type: 'object',
          properties: {
            suiteId: { type: 'number', description: 'Database ID of the suite to delete' }
          },
          required: ['suiteId']
        }
      },
      // --- HISTORY EXPORT ---
      {
        name: 'history_export',
        description: 'Export request history as a JSON array.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'number', description: 'Optional: export only for a specific project' }
          }
        }
      },
      // --- ENVIRONMENT EXPORT/IMPORT ---
      {
        name: 'env_export',
        description: 'Export an environment configuration as a portable JSON object.',
        inputSchema: {
          type: 'object',
          properties: {
            environmentId: { type: 'number', description: 'ID of the environment to export' }
          },
          required: ['environmentId']
        }
      },
      {
        name: 'env_import',
        description: 'Import an environment configuration from a portable JSON object.',
        inputSchema: {
          type: 'object',
          properties: {
            data: { type: 'object', description: 'Exported environment JSON object (from env_export)' },
            projectId: { type: 'number', description: 'Optional: target project ID (default: active project)' }
          },
          required: ['data']
        }
      },
      // --- PROJECT EXPORT/IMPORT ---
      {
        name: 'project_export',
        description: 'Export a project (including all its environments) as a portable JSON object.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'number', description: 'ID of the project to export' }
          },
          required: ['projectId']
        }
      },
      {
        name: 'project_import',
        description: 'Import a project (including all its environments) from a portable JSON object.',
        inputSchema: {
          type: 'object',
          properties: {
            data: { type: 'object', description: 'Exported project JSON object (from project_export)' }
          },
          required: ['data']
        }
      },
      // --- POSTMAN COLLECTION IMPORT ---
      {
        name: 'postman_import',
        description: 'Import a Postman Collection v2 JSON file, generating a structured Markdown API reference.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute path to the Postman Collection JSON file' }
          },
          required: ['filePath']
        }
      }
    ]
  };
});

// Mustache variable interpolation helper with built-in dynamic variables
const BUILTIN_VARIABLES: Record<string, () => string> = {
  '$timestamp': () => String(Date.now()),
  '$isoTimestamp': () => new Date().toISOString(),
  '$uuid': () => crypto.randomUUID(),
  '$randomInt': () => String(Math.floor(Math.random() * 1000000)),
  '$randomFloat': () => (Math.random() * 1000).toFixed(2),
  '$randomEmail': () => `user${Math.floor(Math.random() * 100000)}@test.com`,
  '$randomName': () => {
    const names = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank'];
    return names[Math.floor(Math.random() * names.length)];
  },
  '$randomCity': () => {
    const cities = ['Beijing', 'Shanghai', 'Tokyo', 'New York', 'London', 'Paris', 'Berlin'];
    return cities[Math.floor(Math.random() * cities.length)];
  },
  '$currentDate': () => new Date().toISOString().split('T')[0],
  '$currentTime': () => new Date().toTimeString().split(' ')[0],
};

function interpolate(target: any, variables: Record<string, any>): any {
  if (typeof target === 'string') {
    return target.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
      const trimmed = key.trim();
      // Built-in dynamic variables take precedence
      if (BUILTIN_VARIABLES[trimmed]) return BUILTIN_VARIABLES[trimmed]();
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

/**
 * Shared step execution engine used by both test_run_suite and suite_load.
 * Executes steps sequentially, interpolating variables, running assertions,
 * extracting variables, and collecting results.
 */
async function executeSuiteSteps(
  steps: any[],
  variables: Record<string, any>,
  state: { projectId: number; projectName: string; envId: number; envName: string }
): Promise<TestStepResult[]> {
  const stepResults: TestStepResult[] = [];
  for (const step of steps) {
    const { stepName, url, method, headers, params, body, bodyType, jsonpathFilter, extractVariables, assertions } = step;
    const finalUrl = interpolate(url, variables);
    const finalHeaders = headers ? interpolate(headers, variables) : undefined;
    const finalParams = params ? interpolate(params, variables) : undefined;
    const finalBody = body ? interpolate(body, variables) : undefined;

    try {
      const response = await httpClient.send({
        url: finalUrl, method: method || 'GET',
        headers: finalHeaders, params: finalParams, body: finalBody,
        bodyType, jsonpathFilter
      });

      const assertionReport = (assertions?.length > 0) ? AssertionEngine.run(response, assertions as Assertion[]) : undefined;
      const extractionErrors: string[] = [];

      if (extractVariables && Object.keys(extractVariables).length > 0) {
        let parsedBody = response.fullBody !== undefined ? response.fullBody : response.body;
        if (typeof parsedBody === 'string') try { parsedBody = JSON.parse(parsedBody); } catch {}

        for (const [varName, pathExpr] of Object.entries(extractVariables)) {
          try {
            const nodes = jp.query(parsedBody, String(pathExpr));
            if (nodes.length > 0) {
              variables[varName] = nodes[0];
              await dbManager.setEnvironmentVariable(state.envId, varName, nodes[0]);
            } else {
              extractionErrors.push(`Variable "${varName}" extraction failed: JSONPath "${pathExpr}" returned no results`);
            }
          } catch (jpErr: any) {
            extractionErrors.push(`Variable "${varName}" extraction failed: ${jpErr.message}`);
          }
        }
      }

      stepResults.push({
        stepName, url: finalUrl, method: method || 'GET',
        responseStatus: response.status, durationMs: response.durationMs,
        assertionReport,
        extractionErrors: extractionErrors.length > 0 ? extractionErrors : undefined
      });
    } catch (err: any) {
      stepResults.push({ stepName, url: finalUrl, method: method || 'GET', error: err.message });
    }
  }
  return stepResults;
}

// 4. Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const toolStart = Date.now();

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

      case 'project_rename': {
        const { projectId, name } = args as any;
        await dbManager.renameProject(projectId, name);
        return {
          content: [{ type: 'text', text: `Project ID ${projectId} renamed to "${name}".` }]
        };
      }

      // --- ENVIRONMENTS ---
      case 'env_configure': {
        const { name, baseUrl, headers, cookies, variables, authType, authToken, apiKeyHeaderName, timeout, oauth2Config } = args as any;
        const projId = await dbManager.getActiveProjectId();
        
        const envData = {
          ...(baseUrl !== undefined && { baseUrl }),
          headers: headers ? JSON.stringify(headers) : undefined,
          cookies: cookies ? JSON.stringify(cookies) : undefined,
          variables: variables ? JSON.stringify(variables) : undefined,
          authType,
          authToken,
          apiKeyHeaderName,
          timeout,
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

      case 'env_get_variable': {
        const { key } = args as any;
        const state = await dbManager.getActiveProjectAndEnv();
        const value = await dbManager.getEnvironmentVariable(state.envId, key);
        if (value === undefined) {
          return { content: [{ type: 'text', text: `Variable "${key}" not found in environment "${state.envName}".` }] };
        }
        return { content: [{ type: 'text', text: `Variable "${key}" = ${JSON.stringify(value)}` }] };
      }

      case 'env_delete_variable': {
        const { key } = args as any;
        const state = await dbManager.getActiveProjectAndEnv();
        const deleted = await dbManager.deleteEnvironmentVariable(state.envId, key);
        if (!deleted) {
          return { content: [{ type: 'text', text: `Variable "${key}" not found in environment "${state.envName}". Nothing deleted.` }] };
        }
        return { content: [{ type: 'text', text: `Deleted variable "${key}" from environment "${state.envName}".` }] };
      }

      case 'env_list_variables': {
        const state = await dbManager.getActiveProjectAndEnv();
        const vars = await dbManager.listEnvironmentVariables(state.envId);
        if (Object.keys(vars).length === 0) {
          return { content: [{ type: 'text', text: `No variables defined in environment "${state.envName}".` }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(vars, null, 2) }] };
      }

      case 'env_rename': {
        const { environmentId, name } = args as any;
        await dbManager.renameEnvironment(environmentId, name);
        return { content: [{ type: 'text', text: `Environment ID ${environmentId} renamed to "${name}".` }] };
      }

      case 'env_set_allowlist': {
        const { domains } = args as any;
        await dbManager.setAllowlist(domains);
        return {
          content: [{ type: 'text', text: `URL Allowlist configured: ${JSON.stringify(domains)}` }]
        };
      }

      case 'env_get_allowlist': {
        const allowlist = await dbManager.getAllowlist();
        return {
          content: [{ type: 'text', text: `Current URL Allowlist: ${JSON.stringify(allowlist)}` }]
        };
      }

      // --- HTTP REQUEST ---
      case 'http_request': {
        const { url, method, headers, params, body, bodyType, timeout, jsonpathFilter, fileFields, maxResponseLength, returnBody, retryCount, retryDelay, cacheTtl, assertBefore, assertions } = args as any;
        
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
          jsonpathFilter,
          fileFields,
          maxResponseLength,
          returnBody,
          retryCount,
          retryDelay,
          cacheTtl,
          assertBefore
        });

        let outputText = `### Response Info\n`;
        outputText += `- **Project**: \`${state.projectName}\` | **Environment**: \`${state.envName}\`\n`;
        outputText += `- **URL**: \`${finalUrl}\`\n`;
        outputText += `- **Status**: ${response.status} ${response.statusText}\n`;
        outputText += `- **Duration**: ${response.durationMs}ms\n`;
        if (response.cached) outputText += `- **Cache**: ✅ Served from cache (cacheTtl active)\n`;
        outputText += `\n`;

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
        const { limit, offset, environmentId, method, statusCode, urlKeyword, dateFrom, dateTo } = args as any;
        const activeState = await dbManager.getActiveProjectAndEnv();
        
        // If environmentId is not specified, we pull filters by active projectId
        const list = await dbManager.listHistory({
          limit,
          offset,
          environmentId,
          method,
          statusCode,
          urlKeyword,
          dateFrom,
          dateTo,
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
        const { id1, id2, format } = args as any;
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
          record2.responseBody || '',
          format || 'table'
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
        const { suiteName, steps, dataSource } = args as any;
        const startTime = Date.now();
        
        const state = await dbManager.getActiveProjectAndEnv();
        const env = await dbManager.getEnvironmentById(state.envId);
        if (!env) throw new Error('Active environment configs not loaded.');

        let variables = JSON.parse(env.variables || '{}');

        // Data-Driven Testing: load rows from CSV/JSON file and run suite for each row
        if (dataSource) {
          const rawContent = await fs.readFile(dataSource.filePath, 'utf8');
          let rows: Record<string, any>[] = [];
          if (dataSource.type === 'csv') {
            const lines = rawContent.trim().split('\n');
            const headers = lines[0].split(',').map(h => h.trim());
            for (let i = 1; i < lines.length; i++) {
              const vals = lines[i].split(',').map(v => v.trim());
              const row: Record<string, any> = {};
              headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
              rows.push(row);
            }
          } else { // JSON
            rows = JSON.parse(rawContent);
            if (!Array.isArray(rows)) rows = [rows];
          }

          const allResults: TestStepResult[] = [];
          let allPassed = true;
          for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
            const row = rows[rowIdx];
            // Inject row data as {{row.columnName}} variables
            const rowVars = { ...variables };
            for (const [k, v] of Object.entries(row)) {
              rowVars[`row.${k}`] = v;
            }
            const rowResults = await executeSuiteSteps(steps, rowVars, state);
            // Mark step names with row index
            rowResults.forEach(s => { s.stepName = `[Row ${rowIdx + 1}] ${s.stepName}`; });
            allResults.push(...rowResults);
            if (!rowResults.every(s => !s.error && (!s.assertionReport || s.assertionReport.passed))) {
              allPassed = false;
            }
          }

          const endTime = Date.now();
          const suiteResult: TestSuiteResult = {
            suiteName: `${suiteName} (DDT: ${rows.length} rows)`, passed: allPassed,
            steps: allResults, startTime, endTime
          };
          return { content: [{ type: 'text', text: TestReporter.generateMarkdown(suiteResult) }] };
        }

        // Normal mode: single run
        const stepResults = await executeSuiteSteps(steps, variables, state);
        const endTime = Date.now();
        const passed = stepResults.every(s => !s.error && (!s.assertionReport || s.assertionReport.passed));

        const suiteResult: TestSuiteResult = {
          suiteName, passed, steps: stepResults, startTime, endTime
        };

        const mdReport = TestReporter.generateMarkdown(suiteResult);
        return { content: [{ type: 'text', text: mdReport }] };
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
        const { confirm } = args as any;
        if (confirm !== true) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'DANGER: db_reset requires `confirm: true` to proceed. This will delete all data permanently.' }]
          };
        }
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

      case 'graphql_request': {
        const { url, query, variables: gqlVars, operationName, headers: gqlHeaders, timeout: gqlTimeout } = args as any;
        const gqlBody: any = { query };
        if (gqlVars) gqlBody.variables = gqlVars;
        if (operationName) gqlBody.operationName = operationName;
        const gqlResult = await httpClient.send({
          url,
          method: 'POST',
          headers: { ...(gqlHeaders || {}), 'Content-Type': 'application/json' },
          body: JSON.stringify(gqlBody),
          bodyType: 'json',
          timeout: gqlTimeout
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(gqlResult.body, null, 2) }]
        };
      }

      case 'suite_save': {
        const { name: suiteName, steps: suiteSteps, description: suiteDesc } = args as any;
        const projId = await dbManager.getActiveProjectId();
        const suiteId = await dbManager.saveTestSuite(projId, suiteName, suiteSteps, suiteDesc);
        return { content: [{ type: 'text', text: `Test suite "${suiteName}" saved with ID: ${suiteId}.` }] };
      }

      case 'suite_load': {
        const { suiteId } = args as any;
        const suite = await dbManager.loadTestSuite(suiteId);
        if (!suite) {
          return { isError: true, content: [{ type: 'text', text: `Suite ID ${suiteId} not found.` }] };
        }
        const startTime = Date.now();
        const state = await dbManager.getActiveProjectAndEnv();
        const env = await dbManager.getEnvironmentById(state.envId);
        if (!env) throw new Error('Active environment configs not loaded.');
        const variables = JSON.parse(env.variables || '{}');
        const stepResults = await executeSuiteSteps(suite.steps, variables, state);
        const endTime = Date.now();
        const passed = stepResults.every(s => !s.error && (!s.assertionReport || s.assertionReport.passed));
        const suiteResult: TestSuiteResult = { suiteName: suite.name, passed, steps: stepResults, startTime, endTime };
        const mdReport = TestReporter.generateMarkdown(suiteResult);
        return { content: [{ type: 'text', text: mdReport }] };
      }

      case 'suite_list': {
        const projId = await dbManager.getActiveProjectId();
        const suites = await dbManager.listTestSuites(projId);
        if (suites.length === 0) {
          return { content: [{ type: 'text', text: 'No saved test suites found in active project.' }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(suites, null, 2) }] };
      }

      case 'suite_delete': {
        const { suiteId } = args as any;
        await dbManager.deleteTestSuite(suiteId);
        return { content: [{ type: 'text', text: `Test suite ID ${suiteId} deleted.` }] };
      }

      case 'history_export': {
        const { projectId } = args as any;
        const exportData = await dbManager.exportHistory(projectId);
        return { content: [{ type: 'text', text: JSON.stringify(exportData, null, 2) }] };
      }

      case 'env_export': {
        const { environmentId } = args as any;
        const envData = await dbManager.exportEnvironment(environmentId);
        return { content: [{ type: 'text', text: JSON.stringify(envData, null, 2) }] };
      }

      case 'env_import': {
        const { data, projectId } = args as any;
        const targetProjId = projectId || await dbManager.getActiveProjectId();
        const newEnvId = await dbManager.importEnvironment(targetProjId, data);
        return { content: [{ type: 'text', text: `Environment "${data.name}" imported with ID: ${newEnvId} under project ID: ${targetProjId}.` }] };
      }

      case 'project_export': {
        const { projectId } = args as any;
        const projData = await dbManager.exportProject(projectId);
        return { content: [{ type: 'text', text: JSON.stringify(projData, null, 2) }] };
      }

      case 'project_import': {
        const { data } = args as any;
        const newProjId = await dbManager.importProject(data);
        return { content: [{ type: 'text', text: `Project "${data.name}" imported with ID: ${newProjId} including ${data.environments?.length || 0} environments.` }] };
      }

      case 'postman_import': {
        const { filePath: pmPath } = args as any;
        const pmContent = await fs.readFile(pmPath, 'utf8');
        const pmJson = JSON.parse(pmContent);
        if (pmJson.info?.schema && !pmJson.info.schema.includes('collection')) {
          throw new Error('Unsupported Postman format. Only Collection v2 is supported.');
        }
        let md = `# 📬 Postman Collection: ${pmJson.info?.name || 'Untitled'}\n\n`;
        md += `> **Description:** ${pmJson.info?.description || 'N/A'}\n\n`;
        const items = pmJson.item || [];
        for (const item of items) {
          if (item.request) {
            const req = item.request;
            const method = (req.method || 'GET').toUpperCase();
            const urlObj = req.url;
            const fullUrl = typeof urlObj === 'string' ? urlObj : (urlObj?.raw || (urlObj?.path?.join('/') || ''));
            md += `### ${item.name}\n`;
            md += `- **Method:** \`${method}\` | **URL:** \`${fullUrl}\`\n`;
            if (req.header && req.header.length > 0) {
              const headers = req.header.filter((h: any) => h.key).map((h: any) => `${h.key}: ${h.value}`).join(', ');
              md += `- **Headers:** ${headers}\n`;
            }
            if (req.body?.raw) md += `- **Body:**\n\`\`\`\n${req.body.raw}\n\`\`\`\n`;
            md += `\n`;
          } else if (item.item) {
            // Folder with sub-items
            md += `### 📂 ${item.name}\n\n`;
            for (const subItem of item.item) {
              if (subItem.request) {
                const req = subItem.request;
                const method = (req.method || 'GET').toUpperCase();
                const urlObj = req.url;
                const fullUrl = typeof urlObj === 'string' ? urlObj : (urlObj?.raw || '');
                md += `- **${subItem.name}:** \`${method}\` \`${fullUrl}\`\n`;
              }
            }
            md += `\n`;
          }
        }
        return { content: [{ type: 'text', text: md }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err: any) {
    logger.toolCall(name, Date.now() - toolStart, false);
    logger.error('Server', `Tool "${name}" failed: ${err.message}`);
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
  logger.info('Server', `postmcp v1.1.0 started`);
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
