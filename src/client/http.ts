import axios, { AxiosRequestConfig, Method } from 'axios';
import jp from 'jsonpath';
import fs from 'fs/promises';
import path from 'path';
import { DbManager, EnvironmentRecord } from '../db/sqlite.js';
import { OAuth2Authenticator } from './oauth.js';
import { logger } from '../utils/logger.js';

export interface HttpRequestOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body?: any;
  bodyType?: 'json' | 'urlencoded' | 'form-data' | 'raw';
  timeout?: number;
  jsonpathFilter?: string;
  maxResponseLength?: number;
  fileFields?: Record<string, string>; // Map of field name to local file path for form-data uploads
  returnBody?: boolean; // If false, return only status/duration without body (silent mode, saves tokens)
  retryCount?: number; // Auto retry count on 5xx/network errors (default: 0)
  retryDelay?: number; // Delay between retries in ms (default: 1000)
  cacheTtl?: number; // Response cache TTL in ms (default: 0 = no cache). Set >0 to reuse cached responses.
  assertBefore?: { // Conditional request: only return full response if condition matches
    type: 'status' | 'header' | 'body';
    property?: string;
    operator: 'equals' | 'notEquals' | 'contains' | 'exists' | 'matches' | 'greaterThan' | 'lessThan';
    expected?: any;
  };
}

export interface HttpResponseData {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
  fullBody?: any;
  durationMs: number;
  isTruncated: boolean;
  originalSize: number;
  cached?: boolean; // Whether response was served from cache
}

// Helper to redact sensitive keys in headers
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  const sensitiveKeys = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'client-secret'];
  
  for (const [key, val] of Object.entries(headers)) {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      redacted[key] = '********';
    } else {
      redacted[key] = val;
    }
  }
  return redacted;
}

// Helper to redact body secrets (if it is a JSON object or urlencoded string containing keys)
function redactBody(body: any): string {
  if (!body) return '';
  if (typeof body === 'string') {
    // Check urlencoded body
    const sensitiveRegex = /(password|client_secret|token|secret)=([^&]+)/gi;
    if (sensitiveRegex.test(body)) {
      return body.replace(sensitiveRegex, '$1=********');
    }
    return body;
  }
  if (typeof body === 'object') {
    try {
      const cloned = JSON.parse(JSON.stringify(body));
      const sensitiveKeys = ['password', 'client_secret', 'token', 'secret'];
      
      const mask = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        for (const key of Object.keys(obj)) {
          if (sensitiveKeys.includes(key.toLowerCase())) {
            obj[key] = '********';
          } else if (typeof obj[key] === 'object') {
            mask(obj[key]);
          }
        }
      };
      
      mask(cloned);
      return JSON.stringify(cloned, null, 2);
    } catch {
      return String(body);
    }
  }
  return String(body);
}

export class HttpClient {
  private dbManager: DbManager;
  private oauthAuthenticator: OAuth2Authenticator;
  private responseCache: Map<string, { data: HttpResponseData; expiry: number }> = new Map();
  private readonly MAX_CACHE_SIZE = 50;

  constructor(dbManager: DbManager) {
    this.dbManager = dbManager;
    this.oauthAuthenticator = new OAuth2Authenticator(dbManager);
  }

  /**
   * Generates a deterministic cache key from request options (excludes timestamp-sensitive fields).
   */
  private getCacheKey(options: HttpRequestOptions): string {
    // Only cache GET/HEAD requests, skip when body/auth-sensitive
    const method = (options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) return '';
    // Build key from URL + headers + params (sorted for consistency)
    const headerStr = options.headers ? JSON.stringify(options.headers, Object.keys(options.headers).sort()) : '';
    const paramsStr = options.params ? JSON.stringify(options.params, Object.keys(options.params).sort()) : '';
    return `${method}:${options.url}|${headerStr}|${paramsStr}|${options.body || ''}`;
  }

  /**
   * Evaluates a conditional assertion (assertBefore) against a response.
   * Returns true if the condition is met (response should be returned).
   */
  private evaluateAssertBefore(response: any, assertBefore: NonNullable<HttpRequestOptions['assertBefore']>): boolean {
    const { type, property, operator, expected } = assertBefore;
    let actual: any;

    switch (type) {
      case 'status':
        actual = response.status;
        break;
      case 'header':
        if (!property) return true;
        actual = response.headers[property.toLowerCase()] || 
                 Object.entries(response.headers).find(([k]) => k.toLowerCase() === property.toLowerCase())?.[1];
        break;
      case 'body':
        if (property) {
          try {
            const parsed = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
            actual = jp.query(parsed, property);
            actual = actual.length === 1 ? actual[0] : actual;
          } catch { actual = undefined; }
        } else {
          actual = response.data;
        }
        break;
    }

    switch (operator) {
      case 'equals': return actual == expected;
      case 'notEquals': return actual != expected;
      case 'contains': return String(actual).includes(String(expected));
      case 'exists': return actual !== undefined && actual !== null;
      case 'matches': return new RegExp(String(expected)).test(String(actual));
      case 'greaterThan': return Number(actual) > Number(expected);
      case 'lessThan': return Number(actual) < Number(expected);
      default: return true;
    }
  }

  /**
   * Executes HTTP request, resolves URL from DB, injects DB-stored auth headers,
   * evaluates assertions, filters outputs, and audits the request/response to the SQLite log database.
   * Supports: response caching, silent mode, auto-retry, conditional requests.
   */
  async send(options: HttpRequestOptions): Promise<HttpResponseData> {
    // 1. Get active environment
    const activeInfo = await this.dbManager.getActiveProjectAndEnv();
    const env = await this.dbManager.getEnvironmentById(activeInfo.envId);
    if (!env) {
      throw new Error(`Active environment ID ${activeInfo.envId} not found in database.`);
    }

    // 2. Resolve URL (with variable interpolation for baseUrl)
    let fullUrl = options.url;
    const envVars = JSON.parse(env.variables || '{}');
    if (!/^https?:\/\//i.test(fullUrl)) {
      let baseUrl = env.baseUrl || '';
      // Interpolate variables in baseUrl
      baseUrl = baseUrl.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
        const trimmed = key.trim();
        return envVars[trimmed] !== undefined ? String(envVars[trimmed]) : `{{${trimmed}}}`;
      });
      if (!baseUrl) {
        throw new Error(`Relative URL "${fullUrl}" provided but no baseUrl is configured for the active environment "${activeInfo.envName}" in project "${activeInfo.projectName}"`);
      }
      const cleanBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
      const cleanPath = fullUrl.startsWith('/') ? fullUrl : `/${fullUrl}`;
      fullUrl = `${cleanBase}${cleanPath}`;
    }

    // 3. Verify Allowlist
    if (!(await this.dbManager.isUrlAllowed(fullUrl))) {
      throw new Error(`Access Denied: The URL "${fullUrl}" is not allowed under the current security policy/allowlist.`);
    }

    // 4. Resolve Headers & Cookies from DB environment
    const requestHeaders: Record<string, string> = {};

    const dbHeaders = JSON.parse(env.headers || '{}');
    Object.assign(requestHeaders, dbHeaders);

    const dbCookies = JSON.parse(env.cookies || '{}');
    if (Object.keys(dbCookies).length > 0) {
      requestHeaders['Cookie'] = Object.entries(dbCookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    }

    // Apply call-specific headers
    if (options.headers) {
      Object.assign(requestHeaders, options.headers);
    }

    // 5. Inject DB Authorization
    if (env.authType && env.authType !== 'none') {
      if (env.authType === 'bearer' && env.authToken) {
        requestHeaders['Authorization'] = env.authToken.startsWith('Bearer ')
          ? env.authToken
          : `Bearer ${env.authToken}`;
      } else if (env.authType === 'apiKey' && env.authToken) {
        const keyName = env.apiKeyHeaderName || 'x-api-key';
        requestHeaders[keyName] = env.authToken;
      } else if (env.authType === 'basic') {
        // Basic Auth: authToken format is "username:password"
        const encoded = Buffer.from(env.authToken || ':').toString('base64');
        requestHeaders['Authorization'] = `Basic ${encoded}`;
      } else if (env.authType === 'oauth2' && env.oauth2Config) {
        try {
          const oauthConfig = JSON.parse(env.oauth2Config);
          if (oauthConfig.tokenUrl && oauthConfig.clientId && oauthConfig.clientSecret) {
            const token = await this.oauthAuthenticator.getAccessToken(env.id, oauthConfig);
            requestHeaders['Authorization'] = `Bearer ${token}`;
          }
        } catch (err: any) {
          logger.error('HTTP', `Failed to inject OAuth2 token from database: ${err.message}`);
        }
      }
    }

    // 6. Construct Request Body
    let requestData: any = undefined;
    const bodyType = options.bodyType || 'json';

    if (options.body !== undefined && options.body !== null) {
      if (bodyType === 'json') {
        requestData = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        if (!requestHeaders['Content-Type']) {
          requestHeaders['Content-Type'] = 'application/json';
        }
      } else if (bodyType === 'urlencoded') {
        const urlParams = new URLSearchParams();
        const bodyObj = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        for (const [key, val] of Object.entries(bodyObj)) {
          urlParams.append(key, String(val));
        }
        requestData = urlParams.toString();
        if (!requestHeaders['Content-Type']) {
          requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      } else if (bodyType === 'form-data') {
        const formData = new FormData();
        const bodyObj = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        for (const [key, val] of Object.entries(bodyObj)) {
          formData.append(key, String(val));
        }
        // File uploads: add files from fileFields
        if (options.fileFields) {
          for (const [fieldName, filePath] of Object.entries(options.fileFields)) {
            try {
              const fileBuffer = await fs.readFile(filePath);
              const blob = new Blob([fileBuffer]);
              formData.append(fieldName, blob, path.basename(filePath));
            } catch (err: any) {
              logger.error('HTTP', `File upload failed: "${filePath}" for field "${fieldName}": ${err.message}`);
            }
          }
        }
        requestData = formData;
        if (requestHeaders['Content-Type'] && requestHeaders['Content-Type'].includes('multipart/form-data')) {
          delete requestHeaders['Content-Type'];
        }
      } else {
        requestData = String(options.body);
        if (!requestHeaders['Content-Type']) {
          requestHeaders['Content-Type'] = 'text/plain';
        }
      }
    }

    // 7. Check Response Cache (GET/HEAD only)
    const cacheKey = this.getCacheKey(options);
    const cacheTtl = options.cacheTtl || 0;
    if (cacheKey && cacheTtl > 0) {
      const cached = this.responseCache.get(cacheKey);
      if (cached && cached.expiry > Date.now()) {
        return { ...cached.data, cached: true };
      }
    }

    // 8. Execute Request (with auto-retry support)
    const maxRetries = options.retryCount ?? 0;
    const retryDelay = options.retryDelay ?? 1000;
    let lastError: Error | null = null;
    let response: any;
    let durationMs = 0;
    let success = 1;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, retryDelay * attempt)); // Exponential backoff
      }

      const startTime = Date.now();
      const axiosConfig: AxiosRequestConfig = {
        url: fullUrl,
        method: options.method as Method,
        headers: requestHeaders,
        params: options.params,
        data: requestData,
        timeout: options.timeout ?? env.timeout ?? 30000,
        validateStatus: () => true
      };

      try {
        response = await axios(axiosConfig);
        durationMs = Date.now() - startTime;
        lastError = null;
        logger.httpRequest(options.method || 'GET', fullUrl, response.status, durationMs);
        break; // Success, exit retry loop
      } catch (err: any) {
        durationMs = Date.now() - startTime;
        lastError = err;
        
        // Only retry on network errors or 5xx
        if (attempt < maxRetries && (!err.response || (err.response?.status >= 500))) {
          continue;
        }
        
        // Log failed request
        success = 0;
        await this.dbManager.logRequest({
          environmentId: env.id,
          projectName: activeInfo.projectName,
          environmentName: activeInfo.envName,
          url: fullUrl,
          method: options.method,
          requestHeaders: JSON.stringify(redactHeaders(requestHeaders)),
          requestBody: redactBody(options.body),
          responseStatus: err.response?.status || 0,
          responseHeaders: JSON.stringify({}),
          responseBody: `Error: ${err.message}`,
          durationMs,
          success
        });

        throw new Error(`HTTP Request Failed (${durationMs}ms)${attempt > 0 ? ` after ${attempt} retries` : ''}: ${err.message}`);
      }
    }

    let responseBody = response.data;
    let isTruncated = false;
    let originalSize = 0;

    // 9. Conditional Request (assertBefore) — if condition fails, return short response
    if (options.assertBefore) {
      const conditionMet = this.evaluateAssertBefore(response, options.assertBefore);
      if (!conditionMet) {
        const shortResult: HttpResponseData = {
          status: response.status,
          statusText: response.statusText,
          headers: {},
          body: `[Conditional Request] assertBefore condition NOT met: ${options.assertBefore.type} ${options.assertBefore.operator} ${JSON.stringify(options.assertBefore.expected)}. Skipped response body.`,
          fullBody: undefined,
          durationMs,
          isTruncated: false,
          originalSize: 0
        };
        return shortResult;
      }
    }

    // Apply JSONPath filters
    if (options.jsonpathFilter && responseBody) {
      try {
        const parsedJson = typeof responseBody === 'string'
          ? JSON.parse(responseBody)
          : JSON.parse(JSON.stringify(responseBody));
        const filtered = jp.query(parsedJson, options.jsonpathFilter);
        responseBody = filtered.length === 1 ? filtered[0] : filtered;
      } catch (jpErr: any) {
        responseBody = {
          error: `JSONPath filter "${options.jsonpathFilter}" evaluation failed.`,
          details: jpErr.message,
          originalBody: responseBody
        };
      }
    }

    // Response Truncation
    const stringifiedBody = typeof responseBody === 'object'
      ? JSON.stringify(responseBody, null, 2)
      : String(responseBody);
    
    originalSize = stringifiedBody.length;
    const limit = options.maxResponseLength || 15000;

    if (originalSize > limit) {
      isTruncated = true;
      responseBody = stringifiedBody.substring(0, limit) + `\n\n[... Response truncated. Total size: ${originalSize} chars. Configured limit: ${limit} chars ...]`;
    }

    // Reformat headers
    const responseHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(response.headers)) {
      if (val !== undefined) {
        responseHeaders[key] = Array.isArray(val) ? val.join(', ') : String(val);
      }
    }

    // 10. Silent Mode — only return status/duration, no body
    if (options.returnBody === false) {
      const silentResult: HttpResponseData = {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: `[Silent Mode] ${response.status} ${response.statusText} (${durationMs}ms)`,
        fullBody: undefined,
        durationMs,
        isTruncated: false,
        originalSize: 0
      };
      return silentResult;
    }

    // 11. Log Request and Response to DB
    await this.dbManager.logRequest({
      environmentId: env.id,
      projectName: activeInfo.projectName,
      environmentName: activeInfo.envName,
      url: fullUrl,
      method: options.method,
      requestHeaders: JSON.stringify(redactHeaders(requestHeaders)),
      requestBody: redactBody(options.body),
      responseStatus: response.status,
      responseHeaders: JSON.stringify(responseHeaders),
      responseBody: stringifiedBody.substring(0, 100000),
      durationMs,
      success
    });

    // 12. Cookie Jar: Auto-track Set-Cookie headers and persist to environment
    if (responseHeaders['set-cookie']) {
      const setCookieStr = responseHeaders['set-cookie'];
      const existingCookies = JSON.parse(env.cookies || '{}');
      // Parse "key=value" from each Set-Cookie header
      const cookieParts = Array.isArray(setCookieStr) ? setCookieStr : [setCookieStr];
      for (const part of cookieParts) {
        const match = part.match(/^([^=]+)=([^;]+)/);
        if (match) {
          existingCookies[match[1]] = match[2];
        }
      }
      // Persist updated cookies back to environment
      await this.dbManager.run(
        'UPDATE environments SET cookies = ? WHERE id = ?',
        [JSON.stringify(existingCookies), env.id]
      );
      logger.debug('HTTP', `Cookie Jar: updated ${Object.keys(existingCookies).length} cookies for env "${activeInfo.envName}"`);
    }

    // 12. Build result and cache it
    const result: HttpResponseData = {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      fullBody: response.data,
      durationMs,
      isTruncated,
      originalSize,
      cached: false
    };

    // Cache the response (GET/HEAD only, max 50 entries, LRU eviction)
    if (cacheKey && cacheTtl > 0) {
      if (this.responseCache.size >= this.MAX_CACHE_SIZE) {
        const oldest = this.responseCache.keys().next().value;
        if (oldest) this.responseCache.delete(oldest);
      }
      this.responseCache.set(cacheKey, { data: result, expiry: Date.now() + cacheTtl });
    }

    return result;
  }
}
