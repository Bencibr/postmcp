import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createSafeLookup } from '../utils/security.js';
export class WebSocketManager {
    dbManager;
    connections = new Map();
    nextId = 1;
    constructor(dbManager) {
        this.dbManager = dbManager;
    }
    /**
     * Connects to a WebSocket endpoint using DB environment profile settings and headers.
     */
    async connect(url, headers, timeoutMs = 10000) {
        // 1. Get active environment
        const activeInfo = await this.dbManager.getActiveProjectAndEnv();
        const env = await this.dbManager.getEnvironmentById(activeInfo.envId);
        if (!env) {
            throw new Error(`Active environment ID ${activeInfo.envId} not found in database.`);
        }
        // 2. Resolve URL (with variable interpolation for baseUrl)
        let fullUrl = url;
        if (/^https?:\/\//i.test(fullUrl)) {
            // Convert http(s):// to ws(s):// for WebSocket connections
            fullUrl = fullUrl.replace(/^http/i, 'ws');
        }
        else if (!/^wss?:\/\//i.test(fullUrl)) {
            // Relative path — resolve against active environment's baseUrl
            let baseUrl = env.baseUrl || '';
            const envVars = JSON.parse(env.variables || '{}');
            // Interpolate variables in baseUrl
            baseUrl = baseUrl.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
                const trimmed = key.trim();
                return envVars[trimmed] !== undefined ? String(envVars[trimmed]) : `{{${trimmed}}}`;
            });
            if (!baseUrl) {
                throw new Error(`Relative WS URL "${fullUrl}" provided but no baseUrl is configured for the active environment "${activeInfo.envName}" in project "${activeInfo.projectName}"`);
            }
            let cleanBase = baseUrl.replace(/^http/i, 'ws');
            cleanBase = cleanBase.endsWith('/') ? cleanBase.slice(0, -1) : cleanBase;
            const cleanPath = fullUrl.startsWith('/') ? fullUrl : `/${fullUrl}`;
            fullUrl = `${cleanBase}${cleanPath}`;
        }
        // 3. Verify destination and repeat IP validation during the socket lookup.
        await this.dbManager.assertUrlAllowed(fullUrl, ['ws:', 'wss:']);
        const allowlist = await this.dbManager.getAllowlist();
        // 4. Setup connection ID
        const connectionId = `ws_${this.nextId++}`;
        const emitter = new EventEmitter();
        // Headers injection
        const socketHeaders = {};
        const dbHeaders = JSON.parse(env.headers || '{}');
        Object.assign(socketHeaders, dbHeaders);
        const dbCookies = JSON.parse(env.cookies || '{}');
        if (Object.keys(dbCookies).length > 0) {
            socketHeaders['Cookie'] = Object.entries(dbCookies)
                .map(([k, v]) => `${k}=${v}`)
                .join('; ');
        }
        if (headers) {
            Object.assign(socketHeaders, headers);
        }
        // Auth injection
        if (env.authType && env.authType !== 'none') {
            if (env.authType === 'bearer' && env.authToken) {
                socketHeaders['Authorization'] = env.authToken.startsWith('Bearer ') ? env.authToken : `Bearer ${env.authToken}`;
            }
            else if (env.authType === 'apiKey' && env.authToken) {
                const headerName = env.apiKeyHeaderName || 'x-api-key';
                socketHeaders[headerName] = env.authToken;
            }
            else if (env.authType === 'oauth2') {
                const cachedToken = await this.dbManager.getCachedToken(env.id);
                if (cachedToken && cachedToken.accessToken) {
                    socketHeaders['Authorization'] = `Bearer ${cachedToken.accessToken}`;
                }
            }
        }
        const socket = new WebSocket(fullUrl, {
            headers: socketHeaders,
            handshakeTimeout: Math.min(Math.max(1, timeoutMs), 120000),
            lookup: createSafeLookup(allowlist),
        });
        const connState = {
            id: connectionId,
            url: fullUrl,
            status: 'connecting',
            messages: [],
            socket,
            emitter
        };
        this.connections.set(connectionId, connState);
        // Bind events
        socket.on('open', () => {
            connState.status = 'open';
            emitter.emit('open');
        });
        socket.on('message', (data) => {
            const messageStr = data.toString('utf8');
            const msg = {
                direction: 'incoming',
                data: messageStr,
                timestamp: Date.now()
            };
            connState.messages.push(msg);
            emitter.emit('message', msg);
        });
        socket.on('error', (err) => {
            connState.status = 'error';
            connState.error = err.message;
            emitter.emit('error', err);
        });
        socket.on('close', (code, reason) => {
            connState.status = 'closed';
            emitter.emit('close', code, reason.toString());
        });
        // Wait for open
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                connState.emitter.off('open', onOpen);
                connState.emitter.off('error', onError);
                connState.emitter.off('close', onClose);
            };
            const onOpen = () => {
                cleanup();
                resolve({ connectionId, status: 'open' });
            };
            const onError = (err) => {
                cleanup();
                this.connections.delete(connectionId);
                reject(new Error(`WebSocket connection failed to "${fullUrl}": ${err.message}`));
            };
            const onClose = (code, reason) => {
                cleanup();
                this.connections.delete(connectionId);
                reject(new Error(`WebSocket connection to "${fullUrl}" closed during handshake. Code: ${code}, Reason: ${reason}`));
            };
            connState.emitter.once('open', onOpen);
            connState.emitter.once('error', onError);
            connState.emitter.once('close', onClose);
            const timer = setTimeout(() => {
                cleanup();
                socket.terminate();
                this.connections.delete(connectionId);
                reject(new Error(`WebSocket connection handshake to "${fullUrl}" timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });
    }
    /**
     * Sends a message through an active WebSocket.
     */
    async send(connectionId, message) {
        const conn = this.connections.get(connectionId);
        if (!conn) {
            throw new Error(`WebSocket connection "${connectionId}" not found`);
        }
        if (conn.status !== 'open') {
            throw new Error(`WebSocket connection "${connectionId}" is not open (status: ${conn.status})`);
        }
        const payload = typeof message === 'object' ? JSON.stringify(message) : String(message);
        return new Promise((resolve, reject) => {
            conn.socket.send(payload, (err) => {
                if (err) {
                    reject(new Error(`Failed to send message: ${err.message}`));
                }
                else {
                    conn.messages.push({
                        direction: 'outgoing',
                        data: payload,
                        timestamp: Date.now()
                    });
                    resolve();
                }
            });
        });
    }
    /**
     * Reads buffered messages for a connection.
     * Can optionally block/wait for a pattern to appear if not already in the buffer.
     */
    async read(connectionId, limit = 50, waitForPattern, timeoutMs = 5000) {
        const conn = this.connections.get(connectionId);
        if (!conn) {
            throw new Error(`WebSocket connection "${connectionId}" not found`);
        }
        if (waitForPattern) {
            const regex = new RegExp(waitForPattern, 'i');
            const matches = conn.messages.filter(m => m.direction === 'incoming' && regex.test(m.data));
            if (matches.length > 0) {
                return this.getLimitedMessages(conn.messages, limit);
            }
            if (conn.status !== 'open') {
                throw new Error(`WebSocket connection "${connectionId}" is closed and pattern "${waitForPattern}" was not found in buffer.`);
            }
            await new Promise((resolve, reject) => {
                const regex = new RegExp(waitForPattern, 'i');
                const onMessage = (msg) => {
                    if (msg.direction === 'incoming' && regex.test(msg.data)) {
                        cleanup();
                        resolve();
                    }
                };
                const onClose = () => {
                    cleanup();
                    reject(new Error(`WebSocket connection "${connectionId}" closed while waiting for pattern "${waitForPattern}"`));
                };
                const cleanup = () => {
                    clearTimeout(timer);
                    conn.emitter.off('message', onMessage);
                    conn.emitter.off('close', onClose);
                };
                conn.emitter.on('message', onMessage);
                conn.emitter.once('close', onClose);
                const timer = setTimeout(() => {
                    cleanup();
                    reject(new Error(`Timed out waiting ${timeoutMs}ms for message pattern "${waitForPattern}"`));
                }, timeoutMs);
            });
        }
        return this.getLimitedMessages(conn.messages, limit);
    }
    getLimitedMessages(messages, limit) {
        const start = Math.max(0, messages.length - limit);
        return messages.slice(start);
    }
    /**
     * Closes a connection.
     */
    async close(connectionId) {
        const conn = this.connections.get(connectionId);
        if (!conn) {
            throw new Error(`WebSocket connection "${connectionId}" not found`);
        }
        if (conn.status === 'closed') {
            this.connections.delete(connectionId);
            return;
        }
        return new Promise((resolve) => {
            conn.socket.once('close', () => {
                this.connections.delete(connectionId);
                resolve();
            });
            conn.socket.close(1000, 'MCP Connection Closed');
            setTimeout(() => {
                if (this.connections.has(connectionId)) {
                    conn.socket.terminate();
                    this.connections.delete(connectionId);
                    resolve();
                }
            }, 3000);
        });
    }
    listConnections() {
        return Array.from(this.connections.values()).map(c => ({
            connectionId: c.id,
            url: c.url,
            status: c.status,
            messageCount: c.messages.length
        }));
    }
    async cleanupAll() {
        const promises = Array.from(this.connections.keys()).map(id => this.close(id).catch(() => { }));
        await Promise.all(promises);
    }
}
