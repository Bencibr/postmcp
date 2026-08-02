import axios from 'axios';
import { assertOAuthTransport, assertSafeOutboundUrl, createSafeRequestOptions, } from '../utils/security.js';
export class OAuth2Authenticator {
    dbManager;
    constructor(dbManager) {
        this.dbManager = dbManager;
    }
    /**
     * Retrieves a valid access token for the given environment and config.
     * Uses auth_cache table if valid. Otherwise, executes exchange and stores token.
     */
    async getAccessToken(envId, config) {
        const cached = await this.dbManager.getCachedToken(envId);
        const now = Date.now();
        const safetyBufferMs = 15 * 1000; // 15s buffer
        if (cached && cached.accessToken && cached.expiresAt > now + safetyBufferMs) {
            return cached.accessToken;
        }
        // Exchange token
        const token = await this.fetchNewToken(config);
        // Save to cache
        const expiresAt = token.expiresIn ? now + token.expiresIn * 1000 : now + 3600 * 1000; // default 1 hour if not provided
        await this.dbManager.setCachedToken(envId, token.accessToken, expiresAt);
        return token.accessToken;
    }
    /**
     * Performs the HTTP request to exchange credentials for an access token.
     */
    async fetchNewToken(config) {
        const { tokenUrl, clientId, clientSecret, scope, grantType } = config;
        const allowlist = await this.dbManager.getAllowlist();
        const parsedTokenUrl = await assertSafeOutboundUrl(tokenUrl, allowlist, ['http:', 'https:']);
        assertOAuthTransport(parsedTokenUrl);
        const safeRequestOptions = createSafeRequestOptions(allowlist, tokenUrl, ['http:', 'https:'], true);
        const params = new URLSearchParams();
        params.append('grant_type', grantType || 'client_credentials');
        if (scope)
            params.append('scope', scope);
        if (grantType === 'password') {
            if (!config.username || !config.password) {
                throw new Error('OAuth2 password grant requires username and password');
            }
            params.append('username', config.username);
            params.append('password', config.password);
            params.append('client_id', clientId);
            params.append('client_secret', clientSecret);
        }
        const tryExchange = async (headers, body) => {
            try {
                const response = await axios.post(tokenUrl, body, {
                    headers,
                    timeout: 10000,
                    maxContentLength: 1024 * 1024,
                    maxBodyLength: 1024 * 1024,
                    ...safeRequestOptions,
                });
                if (response.data?.access_token) {
                    return {
                        accessToken: response.data.access_token,
                        expiresIn: typeof response.data.expires_in === 'number' ? response.data.expires_in : undefined
                    };
                }
                throw new Error('Response did not contain an access_token');
            }
            catch (error) {
                if (/Access Denied|OAuth token endpoints must use HTTPS/i.test(error?.message || ''))
                    throw error;
                return null;
            }
        };
        // Primary: Basic Auth header
        const basicAuth = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const primaryHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (grantType !== 'password')
            primaryHeaders['Authorization'] = basicAuth;
        const result = await tryExchange(primaryHeaders, params.toString());
        if (result)
            return result;
        // Fallback: credentials in body (only for client_credentials)
        if (grantType !== 'password') {
            const fallbackParams = new URLSearchParams();
            fallbackParams.append('grant_type', 'client_credentials');
            fallbackParams.append('client_id', clientId);
            fallbackParams.append('client_secret', clientSecret);
            if (scope)
                fallbackParams.append('scope', scope);
            const fallbackResult = await tryExchange({ 'Content-Type': 'application/x-www-form-urlencoded' }, fallbackParams.toString());
            if (fallbackResult)
                return fallbackResult;
        }
        // Primary error detail
        throw new Error(`OAuth2 token exchange failed (grant_type: ${grantType || 'client_credentials'})`);
    }
}
