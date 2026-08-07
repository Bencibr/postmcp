import axios from 'axios';
import jp from 'jsonpath';
import { createHash } from 'crypto';
import path from 'path';
import { OAuth2Authenticator } from './oauth.js';
import { logger } from '../utils/logger.js';
import { createSafeRequestOptions, readAllowedFile, redactBody, redactHeaders, } from '../utils/security.js';
export class HttpClient {
    dbManager;
    oauthAuthenticator;
    responseCache = new Map();
    MAX_CACHE_SIZE = 50;
    constructor(dbManager) {
        this.dbManager = dbManager;
        this.oauthAuthenticator = new OAuth2Authenticator(dbManager);
    }
    /**
     * Generates a deterministic cache key from request options (excludes timestamp-sensitive fields).
     */
    getCacheKey(options, fullUrl, projectId, environmentId, requestHeaders) {
        // Only cache GET/HEAD requests, skip when body/auth-sensitive
        const method = (options.method || 'GET').toUpperCase();
        if (!['GET', 'HEAD'].includes(method))
            return '';
        // Build key from URL + headers + params (sorted for consistency)
        const headerStr = JSON.stringify(requestHeaders, Object.keys(requestHeaders).sort());
        const paramsStr = options.params ? JSON.stringify(options.params, Object.keys(options.params).sort()) : '';
        const identityHash = createHash('sha256').update(headerStr).digest('hex');
        const responseView = JSON.stringify({
            jsonpathFilter: options.jsonpathFilter,
            maxResponseLength: options.maxResponseLength,
            returnBody: options.returnBody,
            assertBefore: options.assertBefore,
        });
        return `${projectId}:${environmentId}:${method}:${fullUrl}|${identityHash}|${paramsStr}|${options.body || ''}|${responseView}`;
    }
    /**
     * Evaluates a conditional assertion (assertBefore) against a response.
     * Returns true if the condition is met (response should be returned).
     */
    evaluateAssertBefore(response, assertBefore) {
        const { type, property, operator, expected } = assertBefore;
        let actual;
        switch (type) {
            case 'status':
                actual = response.status;
                break;
            case 'header':
                if (!property)
                    return true;
                actual = response.headers[property.toLowerCase()] ||
                    Object.entries(response.headers).find(([k]) => k.toLowerCase() === property.toLowerCase())?.[1];
                break;
            case 'body':
                if (property) {
                    try {
                        const parsed = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
                        actual = jp.query(parsed, property);
                        actual = actual.length === 1 ? actual[0] : actual;
                    }
                    catch {
                        actual = undefined;
                    }
                }
                else {
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
    async send(options) {
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
        // 3. Verify the initial destination. Redirects and DNS resolutions are
        // validated again by the request transport below.
        await this.dbManager.assertUrlAllowed(fullUrl, ['http:', 'https:']);
        const allowlist = await this.dbManager.getAllowlist();
        // 4. Resolve Headers & Cookies from DB environment
        const requestHeaders = {};
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
            }
            else if (env.authType === 'apiKey' && env.authToken) {
                const keyName = env.apiKeyHeaderName || 'x-api-key';
                requestHeaders[keyName] = env.authToken;
            }
            else if (env.authType === 'basic') {
                // Basic Auth: authToken format is "username:password"
                const encoded = Buffer.from(env.authToken || ':').toString('base64');
                requestHeaders['Authorization'] = `Basic ${encoded}`;
            }
            else if (env.authType === 'oauth2' && env.oauth2Config) {
                try {
                    const oauthConfig = JSON.parse(env.oauth2Config);
                    if (oauthConfig.tokenUrl && oauthConfig.clientId && oauthConfig.clientSecret) {
                        const token = await this.oauthAuthenticator.getAccessToken(env.id, oauthConfig);
                        requestHeaders['Authorization'] = `Bearer ${token}`;
                    }
                }
                catch (err) {
                    logger.error('HTTP', `Failed to inject OAuth2 token from database: ${err.message}`);
                    throw new Error(`OAuth2 authentication failed; request was not sent: ${err.message}`);
                }
            }
        }
        // 6. Construct Request Body
        let requestData = undefined;
        const bodyType = options.bodyType || 'json';
        if (options.body !== undefined && options.body !== null) {
            if (bodyType === 'json') {
                requestData = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
                if (!requestHeaders['Content-Type']) {
                    requestHeaders['Content-Type'] = 'application/json';
                }
            }
            else if (bodyType === 'urlencoded') {
                const urlParams = new URLSearchParams();
                const bodyObj = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
                for (const [key, val] of Object.entries(bodyObj)) {
                    urlParams.append(key, String(val));
                }
                requestData = urlParams.toString();
                if (!requestHeaders['Content-Type']) {
                    requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
                }
            }
            else if (bodyType === 'form-data') {
                const formData = new FormData();
                const bodyObj = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
                for (const [key, val] of Object.entries(bodyObj)) {
                    formData.append(key, String(val));
                }
                // File uploads: add files from fileFields
                if (options.fileFields) {
                    if (options.confirmFileAccess !== true) {
                        throw new Error('File Access Denied: fileFields requires confirmFileAccess: true.');
                    }
                    for (const [fieldName, filePath] of Object.entries(options.fileFields)) {
                        const fileBuffer = await readAllowedFile(filePath);
                        const blob = new Blob([Uint8Array.from(fileBuffer)]);
                        formData.append(fieldName, blob, path.basename(filePath));
                    }
                }
                requestData = formData;
                if (requestHeaders['Content-Type'] && requestHeaders['Content-Type'].includes('multipart/form-data')) {
                    delete requestHeaders['Content-Type'];
                }
            }
            else {
                requestData = String(options.body);
                if (!requestHeaders['Content-Type']) {
                    requestHeaders['Content-Type'] = 'text/plain';
                }
            }
        }
        // 7. Check Response Cache (GET/HEAD only)
        const cacheKey = this.getCacheKey(options, fullUrl, activeInfo.projectId, env.id, requestHeaders);
        const cacheTtl = Math.min(Math.max(0, options.cacheTtl || 0), 60 * 60 * 1000);
        if (cacheKey && cacheTtl > 0) {
            const cached = this.responseCache.get(cacheKey);
            if (cached && cached.expiry > Date.now()) {
                await this.dbManager.logRequest({
                    environmentId: env.id,
                    projectName: activeInfo.projectName,
                    environmentName: activeInfo.envName,
                    url: fullUrl,
                    method: options.method || 'GET',
                    requestHeaders: JSON.stringify(redactHeaders(requestHeaders, [env.apiKeyHeaderName || 'x-api-key'])),
                    requestBody: redactBody(options.body),
                    responseStatus: cached.data.status,
                    responseHeaders: JSON.stringify(redactHeaders(cached.data.headers)),
                    responseBody: redactBody(cached.data.fullBody ?? cached.data.body, false).substring(0, 100000),
                    durationMs: 0,
                    success: cached.data.status < 400 ? 1 : 0,
                });
                return { ...cached.data, cached: true };
            }
        }
        // 8. Execute Request (with auto-retry support)
        const maxRetries = Math.min(Math.max(0, Math.trunc(options.retryCount ?? 0)), 5);
        const retryDelay = Math.min(Math.max(0, options.retryDelay ?? 1000), 30000);
        let lastError = null;
        let response;
        let durationMs = 0;
        let success = 1;
        const hasSensitiveHeaders = env.authType !== 'none'
            || Object.keys(requestHeaders).some(key => /authorization|cookie|api[-_]?key|secret/i.test(key));
        const safeRequestOptions = createSafeRequestOptions(allowlist, fullUrl, ['http:', 'https:'], hasSensitiveHeaders);
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                await new Promise(r => setTimeout(r, Math.min(retryDelay * (2 ** (attempt - 1)), 30000)));
            }
            const startTime = Date.now();
            const axiosConfig = {
                url: fullUrl,
                method: options.method,
                headers: requestHeaders,
                params: options.params,
                data: requestData,
                timeout: Math.min(Math.max(1, options.timeout ?? env.timeout ?? 30000), 120000),
                maxContentLength: 10 * 1024 * 1024,
                maxBodyLength: 10 * 1024 * 1024,
                validateStatus: () => true,
                ...safeRequestOptions,
            };
            try {
                response = await axios(axiosConfig);
                durationMs = Date.now() - startTime;
                lastError = null;
                logger.httpRequest(options.method || 'GET', fullUrl, response.status, durationMs);
                if (response.status >= 500 && attempt < maxRetries)
                    continue;
                break;
            }
            catch (err) {
                durationMs = Date.now() - startTime;
                lastError = err;
                // Retry only transport failures. HTTP 5xx responses are handled above
                // because validateStatus intentionally preserves them for assertions.
                if (attempt < maxRetries && !err.response) {
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
                    requestHeaders: JSON.stringify(redactHeaders(requestHeaders, [env.apiKeyHeaderName || 'x-api-key'])),
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
        if (!response)
            throw lastError || new Error('HTTP request failed without a response.');
        success = response.status < 400 ? 1 : 0;
        let responseBody = response.data;
        let isTruncated = false;
        let originalSize = 0;
        // 9. Conditional Request (assertBefore). The network event is still
        // logged and cookie state is still updated even when output is suppressed.
        const conditionMet = options.assertBefore
            ? this.evaluateAssertBefore(response, options.assertBefore)
            : true;
        // Apply JSONPath filters
        if (options.jsonpathFilter && responseBody) {
            try {
                const parsedJson = typeof responseBody === 'string'
                    ? JSON.parse(responseBody)
                    : JSON.parse(JSON.stringify(responseBody));
                const filtered = jp.query(parsedJson, options.jsonpathFilter);
                responseBody = filtered.length === 1 ? filtered[0] : filtered;
            }
            catch (jpErr) {
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
        const limit = Math.min(Math.max(0, options.maxResponseLength ?? 15000), 1_000_000);
        if (originalSize > limit) {
            isTruncated = true;
            responseBody = stringifiedBody.substring(0, limit) + `\n\n[... Response truncated. Total size: ${originalSize} chars. Configured limit: ${limit} chars ...]`;
        }
        // Reformat headers
        const responseHeaders = {};
        for (const [key, val] of Object.entries(response.headers)) {
            if (val !== undefined) {
                responseHeaders[key] = Array.isArray(val) ? val.join(', ') : String(val);
            }
        }
        // 11. Log Request and Response to DB
        await this.dbManager.logRequest({
            environmentId: env.id,
            projectName: activeInfo.projectName,
            environmentName: activeInfo.envName,
            url: fullUrl,
            method: options.method || 'GET',
            requestHeaders: JSON.stringify(redactHeaders(requestHeaders, [env.apiKeyHeaderName || 'x-api-key'])),
            requestBody: redactBody(options.body),
            responseStatus: response.status,
            responseHeaders: JSON.stringify(redactHeaders(responseHeaders)),
            responseBody: redactBody(response.data, false).substring(0, 100000),
            durationMs,
            success
        });
        // 12. Cookie Jar: Auto-track Set-Cookie headers and persist to environment
        const rawSetCookie = response.headers['set-cookie'];
        if (rawSetCookie) {
            const existingCookies = JSON.parse(env.cookies || '{}');
            const cookieParts = Array.isArray(rawSetCookie) ? rawSetCookie : [String(rawSetCookie)];
            for (const part of cookieParts) {
                const match = part.match(/^([^=]+)=([^;]+)/);
                if (match) {
                    existingCookies[match[1]] = match[2];
                }
            }
            // Persist updated cookies back to environment
            await this.dbManager.run('UPDATE environments SET cookies = ? WHERE id = ?', [JSON.stringify(existingCookies), env.id]);
            logger.debug('HTTP', `Cookie Jar: updated ${Object.keys(existingCookies).length} cookies for env "${activeInfo.envName}"`);
        }
        // 12. Build result and cache it
        const result = {
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
        if (!conditionMet && options.assertBefore) {
            result.headers = {};
            result.body = `[Conditional Request] assertBefore condition NOT met: ${options.assertBefore.type} ${options.assertBefore.operator} ${JSON.stringify(options.assertBefore.expected)}. Skipped response body.`;
            result.fullBody = undefined;
            result.isTruncated = false;
            result.originalSize = 0;
        }
        else if (options.returnBody === false) {
            result.headers = {};
            result.body = `[Silent Mode] ${response.status} ${response.statusText} (${durationMs}ms)`;
            result.fullBody = undefined;
            result.isTruncated = false;
            result.originalSize = 0;
        }
        // Cache the response (GET/HEAD only, max 50 entries, LRU eviction)
        if (cacheKey && cacheTtl > 0) {
            if (this.responseCache.size >= this.MAX_CACHE_SIZE) {
                const oldest = this.responseCache.keys().next().value;
                if (oldest)
                    this.responseCache.delete(oldest);
            }
            this.responseCache.set(cacheKey, { data: result, expiry: Date.now() + cacheTtl });
        }
        return result;
    }
}
