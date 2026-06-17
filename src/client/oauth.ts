import axios from 'axios';
import { DbManager, OAuth2Config } from '../db/sqlite.js';

export class OAuth2Authenticator {
  private dbManager: DbManager;

  constructor(dbManager: DbManager) {
    this.dbManager = dbManager;
  }

  /**
   * Retrieves a valid access token for the given environment and config.
   * Uses auth_cache table if valid. Otherwise, executes exchange and stores token.
   */
  async getAccessToken(envId: number, config: OAuth2Config): Promise<string> {
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
   * Performs the HTTP request to exchange client credentials for an access token.
   */
  private async fetchNewToken(config: OAuth2Config): Promise<{ accessToken: string; expiresIn?: number }> {
    const { tokenUrl, clientId, clientSecret, scope } = config;

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    if (scope) {
      params.append('scope', scope);
    }

    const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    try {
      const response = await axios.post(tokenUrl, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': authHeader
        },
        timeout: 10000 // 10s timeout
      });

      const data = response.data;
      if (!data || !data.access_token) {
        throw new Error('Response did not contain an access_token');
      }

      return {
        accessToken: data.access_token,
        expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined
      };
    } catch (err: any) {
      // Fallback: Some servers expect credentials in the body, try body fallback
      try {
        const bodyParams = new URLSearchParams();
        bodyParams.append('grant_type', 'client_credentials');
        bodyParams.append('client_id', clientId);
        bodyParams.append('client_secret', clientSecret);
        if (scope) {
          bodyParams.append('scope', scope);
        }

        const fallbackResponse = await axios.post(tokenUrl, bodyParams.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 10000
        });

        const fallbackData = fallbackResponse.data;
        if (fallbackData && fallbackData.access_token) {
          return {
            accessToken: fallbackData.access_token,
            expiresIn: typeof fallbackData.expires_in === 'number' ? fallbackData.expires_in : undefined
          };
        }
      } catch (fallbackErr: any) {
        console.error(`OAuth2 basic auth failed: ${err.message}. Fallback body auth also failed: ${fallbackErr.message}`);
      }

      const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`OAuth2 token exchange failed: ${errorDetail}`);
    }
  }
}
