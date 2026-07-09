import axios from 'axios';
import fs from 'fs/promises';
import yaml from 'js-yaml';
import { DbManager } from '../db/sqlite.js';

export interface SwaggerImportOptions {
  url?: string;
  filePath?: string;
}

export class SwaggerParser {
  private dbManager: DbManager;

  constructor(dbManager: DbManager) {
    this.dbManager = dbManager;
  }

  /**
   * Fetches/Reads and parses the Swagger/OpenAPI spec, returning a Markdown document.
   */
  async importSpec(options: SwaggerImportOptions): Promise<string> {
    let rawContent = '';
    let parsedSpec: any = null;

    if (options.url) {
      // 1. Verify Allowlist for URL fetch
      if (!(await this.dbManager.isUrlAllowed(options.url))) {
        throw new Error(`Access Denied: The URL "${options.url}" is not allowed under the current security policy/allowlist.`);
      }

      try {
        const response = await axios.get(options.url, { responseType: 'text', timeout: 15000 });
        rawContent = response.data;
      } catch (err: any) {
        throw new Error(`Failed to download Swagger spec from "${options.url}": ${err.message}`);
      }
    } else if (options.filePath) {
      try {
        rawContent = await fs.readFile(options.filePath, 'utf8');
      } catch (err: any) {
        throw new Error(`Failed to read Swagger file from "${options.filePath}": ${err.message}`);
      }
    } else {
      throw new Error('Either "url" or "filePath" must be provided to import Swagger spec.');
    }

    // Parse JSON or YAML
    try {
      parsedSpec = JSON.parse(rawContent);
    } catch {
      try {
        parsedSpec = yaml.load(rawContent);
      } catch (yamlErr: any) {
        throw new Error(`Failed to parse specification. It is neither valid JSON nor valid YAML. YAML Error: ${yamlErr.message}`);
      }
    }

    if (!parsedSpec || (typeof parsedSpec !== 'object')) {
      throw new Error('Parsed specification is empty or not a valid object.');
    }

    return this.generateMarkdownDoc(parsedSpec);
  }

  /**
   * Parses the spec object and compiles it into a clean, structured Markdown reference.
   */
  private generateMarkdownDoc(spec: any): string {
    const isOas3 = typeof spec.openapi === 'string';
    const isSwagger2 = typeof spec.swagger === 'string' && spec.swagger === '2.0';

    if (!isOas3 && !isSwagger2) {
      throw new Error('Unsupported specification format. Must be Swagger 2.0 or OpenAPI 3.x.');
    }

    const info = spec.info || {};
    const title = info.title || 'API Reference';
    const version = info.version || '1.0.0';
    const description = info.description || '';

    // Resolve Base URL
    let baseUrl = 'N/A';
    if (isOas3 && spec.servers && spec.servers.length > 0) {
      baseUrl = spec.servers[0].url;
    } else if (isSwagger2) {
      const host = spec.host || '';
      const basePath = spec.basePath || '';
      const schemes = spec.schemes && spec.schemes.length > 0 ? spec.schemes[0] : 'http';
      if (host) {
        baseUrl = `${schemes}://${host}${basePath}`;
      } else if (basePath) {
        baseUrl = basePath;
      }
    }

    let md = `# 📖 API Documentation: ${title}\n\n`;
    md += `> [!NOTE]\n> **Spec Version:** ${isOas3 ? 'OpenAPI ' + spec.openapi : 'Swagger 2.0'} | **API Version:** ${version}\n`;
    if (baseUrl !== 'N/A') {
      md += `> **Base URL:** \`${baseUrl}\`\n`;
    }
    md += `\n`;

    if (description) {
      md += `${description}\n\n`;
    }

    const paths = spec.paths || {};
    const pathKeys = Object.keys(paths);

    if (pathKeys.length === 0) {
      md += `No routes/endpoints defined in this specification.\n`;
      return md;
    }

    md += `## 📋 Endpoints Overview\n\n`;
    md += `| Method | Route Path | Summary |\n`;
    md += `| :--- | :--- | :--- |\n`;

    for (const pathKey of pathKeys) {
      const pathMethods = paths[pathKey];
      for (const methodKey of Object.keys(pathMethods)) {
        if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(methodKey.toLowerCase())) {
          const details = pathMethods[methodKey];
          const summary = details.summary || details.description || '';
          md += `| \`${methodKey.toUpperCase()}\` | \`${pathKey}\` | ${summary} |\n`;
        }
      }
    }

    md += `\n---\n\n## 🔍 Endpoint Details\n\n`;

    for (const pathKey of pathKeys) {
      const pathMethods = paths[pathKey];
      for (const methodKey of Object.keys(pathMethods)) {
        const method = methodKey.toLowerCase();
        if (!['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method)) {
          continue;
        }

        const details = pathMethods[method];
        const summary = details.summary || '';
        const desc = details.description || '';

        md += `### ➡️ \`${methodKey.toUpperCase()}\` ${pathKey}\n`;
        if (summary) md += `**Summary:** ${summary}\n\n`;
        if (desc && desc !== summary) md += `**Description:** ${desc}\n\n`;

        // Parameters (Query/Path/Header)
        const parameters: any[] = [];
        // Combine path-level parameters and operation-level parameters
        if (Array.isArray(paths[pathKey].parameters)) {
          parameters.push(...paths[pathKey].parameters);
        }
        if (Array.isArray(details.parameters)) {
          parameters.push(...details.parameters);
        }

        if (parameters.length > 0) {
          md += `**Parameters:**\n\n`;
          md += `| Name | Position | Type | Required | Description |\n`;
          md += `| :--- | :--- | :--- | :--- | :--- |\n`;

          for (const param of parameters) {
            const name = param.name || '';
            const location = param.in || 'query'; // query, path, header, body
            const required = param.required ? 'Yes' : 'No';
            const paramDesc = param.description || '-';
            
            let type = 'string';
            if (param.type) {
              type = param.type;
            } else if (param.schema && param.schema.type) {
              type = param.schema.type;
            }

            md += `| \`${name}\` | \`${location}\` | \`${type}\` | ${required} | ${paramDesc} |\n`;
          }
          md += `\n`;
        }

        // Request Body (OAS 3)
        if (details.requestBody) {
          md += `**Request Body:**\n\n`;
          const bodyContent = details.requestBody.content || {};
          const jsonBody = bodyContent['application/json'] || bodyContent['application/x-www-form-urlencoded'] || bodyContent['multipart/form-data'] || {};
          
          if (jsonBody.schema) {
            md += `\`\`\`json\n`;
            md += this.renderSchemaMock(jsonBody.schema, spec.components?.schemas || spec.definitions || {});
            md += `\n\`\`\`\n\n`;
          } else {
            md += `*Supported content types:* ${Object.keys(bodyContent).join(', ')}\n\n`;
          }
        }

        // Request Body (Swagger 2.0)
        const bodyParam = parameters.find(p => p.in === 'body');
        if (bodyParam && bodyParam.schema) {
          md += `**Request Body:**\n\n`;
          md += `\`\`\`json\n`;
          md += this.renderSchemaMock(bodyParam.schema, spec.definitions || {});
          md += `\n\`\`\`\n\n`;
        }

        // Responses (both OAS 3 and Swagger 2.0)
        const responses = details.responses;
        if (responses && Object.keys(responses).length > 0) {
          md += `**Responses:**\n\n`;
          md += `| Status Code | Description | Response Schema |\n`;
          md += `| :--- | :--- | :--- |\n`;

          for (const [statusCode, responseObj] of Object.entries(responses)) {
            const resp = responseObj as any;
            const respDesc = resp.description || '';
            let schemaMd = '*No body defined*';

            if (isOas3 && resp.content) {
              const jsonContent = resp.content['application/json'] || resp.content['*/*'] || {};
              if (jsonContent.schema) {
                const schemas = spec.components?.schemas || {};
                schemaMd = `\`\`\`json\n${this.renderSchemaMock(jsonContent.schema, schemas)}\n\`\`\``;
              } else {
                schemaMd = `*Content types:* ${Object.keys(resp.content).join(', ')}`;
              }
            } else if (resp.schema) {
              // Swagger 2.0 — schema directly on response
              const definitions = spec.definitions || {};
              schemaMd = `\`\`\`json\n${this.renderSchemaMock(resp.schema, definitions)}\n\`\`\``;
            }

            md += `| \`${statusCode}\` | ${respDesc} | ${schemaMd.replace(/\n/g, '<br/>')} |\n`;
          }
          md += `\n`;
        }

        md += `\n`;
      }
    }

    return md;
  }

  /**
   * Helper to format a simple mock JSON representation of an OpenAPI schema object
   */
  private renderSchemaMock(schema: any, definitions: Record<string, any>, depth = 0): string {
    if (depth > 5) return '"..."'; // Prevent infinite recursion

    if (schema.$ref) {
      // Resolve reference e.g., "#/components/schemas/User" or "#/definitions/User"
      const refName = schema.$ref.split('/').pop();
      const refSchema = definitions[refName];
      if (refSchema) {
        return this.renderSchemaMock(refSchema, definitions, depth + 1);
      }
      return `"${refName}"`;
    }

    const type = schema.type || 'object';

    if (type === 'object') {
      const properties = schema.properties || {};
      const required = schema.required || [];
      const keys = Object.keys(properties);
      if (keys.length === 0) return '{}';

      let output = '{\n';
      const indent = '  '.repeat(depth + 1);
      const closeIndent = '  '.repeat(depth);

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const propSchema = properties[key];
        const isRequired = required.includes(key) ? ' (required)' : '';
        const desc = propSchema.description ? ` // ${propSchema.description}${isRequired}` : isRequired ? ` //${isRequired}` : '';
        
        output += `${indent}"${key}": ${this.renderSchemaMock(propSchema, definitions, depth + 1).trim()}`;
        if (i < keys.length - 1) output += ',';
        if (desc) output += desc;
        output += '\n';
      }
      output += `${closeIndent}}`;
      return output;
    }

    if (type === 'array') {
      const items = schema.items || {};
      return `[ ${this.renderSchemaMock(items, definitions, depth + 1)} ]`;
    }

    if (type === 'string') {
      if (schema.example) return `"${schema.example}"`;
      if (schema.format === 'date-time') return '"2026-06-17T08:00:00.000Z"';
      return '"string"';
    }

    if (type === 'integer' || type === 'number') {
      if (schema.example !== undefined) return String(schema.example);
      return '0';
    }

    if (type === 'boolean') {
      if (schema.example !== undefined) return String(schema.example);
      return 'true';
    }

    return '"any"';
  }
}
