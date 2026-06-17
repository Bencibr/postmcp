import axios from 'axios';
import jp from 'jsonpath';
import { OAuth2Authenticator } from './oauth.js';
// Helper to redact sensitive keys in headers
function redactHeaders(headers) {
    const redacted = {};
    const sensitiveKeys = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'client-secret'];
    for (const [key, val] of Object.entries(headers)) {
        if (sensitiveKeys.includes(key.toLowerCase())) {
            redacted[key] = '********';
        }
        else {
            redacted[key] = val;
        }
    }
    return redacted;
}
// Helper to redact body secrets (if it is a JSON object or urlencoded string containing keys)
function redactBody(body) {
    if (!body)
        return '';
    if (typeof body === 'object') {
        try {
            const cloned = JSON.parse(JSON.stringify(body));
            const sensitiveKeys = ['password', 'client_secret', 'token', 'secret'];
            const mask = (obj) => {
                if (!obj || typeof obj !== 'object')
                    return;
                for (const key of Object.keys(obj)) {
                    if (sensitiveKeys.includes(key.toLowerCase())) {
                        obj[key] = '********';
                    }
                    else if (typeof obj[key] === 'object') {
                        mask(obj[key]);
                    }
                }
            };
            mask(cloned);
            return JSON.stringify(cloned, null, 2);
        }
        catch {
            return String(body);
        }
    }
    // Try checking urlencoded body
    let bodyStr = String(body);
    const sensitiveRegex = /(password|client_secret|token|secret)=([^&]+)/gi;
    if (sensitiveRegex.test(bodyStr)) {
        return bodyStr.replace(sensitiveRegex, '$1=********');
    }
    return bodyStr;
}
export class HttpClient {
    dbManager;
    oauthAuthenticator;
    constructor(dbManager) {
        this.dbManager = dbManager;
        this.oauthAuthenticator = new OAuth2Authenticator(dbManager);
    }
    /**
     * Executes HTTP request, resolves URL from DB, injects DB-stored auth headers,
     * evaluates assertions, filters outputs, and audits the request/response to the SQLite log database.
     */
    async send(options) {
        // 1. Get active environment
        const activeInfo = await this.dbManager.getActiveProjectAndEnv();
        const env = await this.dbManager.getEnvironmentById(activeInfo.envId);
        if (!env) {
            throw new Error(`Active environment ID ${activeInfo.envId} not found in database.`);
        }
        // 2. Resolve URL
        let fullUrl = options.url;
        if (!/^https?:\/\//i.test(fullUrl)) {
            const baseUrl = env.baseUrl || '';
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
            else if (env.authType === 'oauth2' && env.oauth2Config) {
                try {
                    const oauthConfig = JSON.parse(env.oauth2Config);
                    if (oauthConfig.tokenUrl && oauthConfig.clientId && oauthConfig.clientSecret) {
                        const token = await this.oauthAuthenticator.getAccessToken(env.id, oauthConfig);
                        requestHeaders['Authorization'] = `Bearer ${token}`;
                    }
                }
                catch (err) {
                    console.error(`Failed to inject OAuth2 token from database: ${err.message}`);
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
        // 7. Execute Request
        const startTime = Date.now();
        const axiosConfig = {
            url: fullUrl,
            method: options.method,
            headers: requestHeaders,
            params: options.params,
            data: requestData,
            timeout: options.timeout || 30000,
            validateStatus: () => true
        };
        let response;
        let durationMs = 0;
        let success = 1; // 1 = true, 0 = false
        try {
            response = await axios(axiosConfig);
            durationMs = Date.now() - startTime;
        }
        catch (err) {
            durationMs = Date.now() - startTime;
            success = 0;
            // Log failed request attempt to DB
            await this.dbManager.logRequest({
                environmentId: env.id,
                projectName: activeInfo.projectName,
                environmentName: activeInfo.envName,
                url: fullUrl,
                method: options.method,
                requestHeaders: JSON.stringify(redactHeaders(requestHeaders)),
                requestBody: redactBody(options.body),
                responseStatus: 0,
                responseHeaders: JSON.stringify({}),
                responseBody: `Error: ${err.message}`,
                durationMs,
                success
            });
            throw new Error(`HTTP Request Failed (${durationMs}ms): ${err.message}`);
        }
        let responseBody = response.data;
        let isTruncated = false;
        let originalSize = 0;
        // Apply JSONPath filters
        if (options.jsonpathFilter && responseBody) {
            try {
                const parsedJson = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
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
        const limit = options.maxResponseLength || 15000;
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
        // 8. Log Request and Response to DB
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
            responseBody: stringifiedBody.substring(0, 100000), // Cap database storage size for performance
            durationMs,
            success
        });
        return {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: responseBody,
            fullBody: response.data,
            durationMs,
            isTruncated,
            originalSize
        };
    }
}
