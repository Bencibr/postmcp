import os from 'os';
import path from 'path';
import fs from 'fs/promises';
const DEFAULT_CONFIG = {
    activeProfile: 'default',
    profiles: {
        default: {
            baseUrl: '',
            headers: {},
            cookies: {},
            variables: {},
            auth: {
                type: 'none'
            }
        }
    },
    authCache: {}
};
export class ConfigManager {
    configPath;
    data = { ...DEFAULT_CONFIG };
    constructor(customPath) {
        if (customPath) {
            this.configPath = customPath;
        }
        else {
            const homeDir = os.homedir();
            this.configPath = path.join(homeDir, '.postmcp', 'config.json');
        }
    }
    /**
     * Initializes the config manager: loads file or creates one with defaults.
     */
    async initialize() {
        try {
            const dir = path.dirname(this.configPath);
            await fs.mkdir(dir, { recursive: true });
            try {
                const fileContent = await fs.readFile(this.configPath, 'utf8');
                const parsed = JSON.parse(fileContent);
                this.data = {
                    ...DEFAULT_CONFIG,
                    ...parsed,
                    profiles: {
                        ...DEFAULT_CONFIG.profiles,
                        ...(parsed.profiles || {})
                    },
                    authCache: parsed.authCache || {}
                };
            }
            catch (err) {
                if (err.code === 'ENOENT') {
                    // File does not exist, write default config
                    await this.save();
                }
                else {
                    console.error(`Failed to parse config file: ${err.message}. Using defaults.`);
                    this.data = { ...DEFAULT_CONFIG };
                }
            }
        }
        catch (err) {
            console.error(`Config initialization failed: ${err.message}`);
            throw err;
        }
    }
    /**
     * Writes the current configuration state to disk.
     */
    async save() {
        try {
            const content = JSON.stringify(this.data, null, 2);
            await fs.writeFile(this.configPath, content, 'utf8');
        }
        catch (err) {
            console.error(`Failed to save config: ${err.message}`);
            throw err;
        }
    }
    getData() {
        return this.data;
    }
    getActiveProfileName() {
        return this.data.activeProfile;
    }
    setActiveProfile(profileName) {
        if (!this.data.profiles[profileName]) {
            this.data.profiles[profileName] = {
                baseUrl: '',
                headers: {},
                cookies: {},
                variables: {},
                auth: { type: 'none' }
            };
        }
        this.data.activeProfile = profileName;
    }
    getActiveProfile() {
        const active = this.data.activeProfile;
        return this.data.profiles[active] || { auth: { type: 'none' } };
    }
    setProfileData(profileName, updates) {
        const current = this.data.profiles[profileName] || {};
        this.data.profiles[profileName] = {
            ...current,
            ...updates,
            headers: { ...(current.headers || {}), ...(updates.headers || {}) },
            cookies: { ...(current.cookies || {}), ...(updates.cookies || {}) },
            variables: { ...(current.variables || {}), ...(updates.variables || {}) },
            auth: updates.auth !== undefined ? updates.auth : current.auth
        };
    }
    deleteProfile(profileName) {
        if (profileName === 'default') {
            return false; // Cannot delete default profile
        }
        if (this.data.activeProfile === profileName) {
            this.data.activeProfile = 'default';
        }
        delete this.data.profiles[profileName];
        delete this.data.authCache[profileName];
        return true;
    }
    // Auth cache management
    getCachedToken(profileName) {
        return this.data.authCache[profileName];
    }
    setCachedToken(profileName, token, expiresAt) {
        this.data.authCache[profileName] = {
            accessToken: token,
            expiresAt
        };
    }
    clearCachedToken(profileName) {
        delete this.data.authCache[profileName];
    }
    // Allowlist
    isUrlAllowed(urlStr) {
        if (!this.data.allowlist || this.data.allowlist.length === 0) {
            return true; // No restrictions
        }
        try {
            const parsedUrl = new URL(urlStr);
            const host = parsedUrl.host.toLowerCase();
            const hostname = parsedUrl.hostname.toLowerCase();
            return this.data.allowlist.some(allowed => {
                const clean = allowed.trim().toLowerCase();
                if (clean === '*' || clean === '')
                    return true;
                // Exact match or subdomain wildcard match, e.g. "*.example.com"
                if (clean.startsWith('*.')) {
                    const suffix = clean.substring(2);
                    return hostname.endsWith(suffix);
                }
                return hostname === clean || host === clean;
            });
        }
        catch {
            return false; // Invalid URL
        }
    }
    setAllowlist(allowlist) {
        this.data.allowlist = allowlist;
    }
}
