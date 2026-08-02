import sqlite3 from 'sqlite3';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { assertSafeOutboundUrl, redactHeaders, redactSensitiveData } from '../utils/security.js';

export interface OAuth2Config {
  grantType: 'client_credentials' | 'password';
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  username?: string;  // For password grant
  password?: string;  // For password grant
}

export interface ProjectRecord {
  id: number;
  name: string;
  description?: string;
  createdAt: string;
}

export interface EnvironmentRecord {
  id: number;
  projectId: number;
  name: string;
  baseUrl?: string;
  headers?: string; // JSON string
  cookies?: string; // JSON string
  variables?: string; // JSON string
  authType: 'none' | 'bearer' | 'apiKey' | 'basic' | 'oauth2';
  authToken?: string;
  apiKeyHeaderName?: string;
  oauth2Config?: string; // JSON string
  timeout?: number; // Default request timeout in ms
}

export interface HistoryRecord {
  id: number;
  environmentId?: number;
  projectName: string;
  environmentName: string;
  timestamp: string;
  url: string;
  method: string;
  requestHeaders?: string; // JSON string
  requestBody?: string;
  responseStatus: number;
  responseHeaders?: string; // JSON string
  responseBody?: string;
  durationMs: number;
  success: number; // 0 or 1
}

export interface AuthCacheEntry {
  environmentId: number;
  accessToken: string;
  expiresAt: number;
}

export class DbManager {
  private dbPath: string;
  private db!: sqlite3.Database;

  constructor(customPath?: string) {
    if (customPath) {
      this.dbPath = customPath;
    } else {
      const homeDir = os.homedir();
      this.dbPath = path.join(homeDir, '.postmcp', 'postmcp.db');
    }
  }

  /**
   * Promise wrapper to open database connection.
   */
  private openDb(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Initializes database: creates directories, opens file, creates tables, seeds defaults.
   */
  async initialize(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });

    // Open connection
    await this.openDb();

    // Enforce user-only read/write permissions for safety (0600)
    try {
      await fs.chmod(this.dbPath, 0o600);
    } catch (err) {
      // Ignore if not supported on this filesystem
    }

    // Enable WAL mode for concurrent read/write performance
    await this.run('PRAGMA journal_mode=WAL;');

    // Enable foreign keys
    await this.run('PRAGMA foreign_keys = ON;');

    // Define tables
    await this.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        createdAt TEXT NOT NULL
      );
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS environments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        projectId INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        baseUrl TEXT,
        headers TEXT,
        cookies TEXT,
        variables TEXT,
        authType TEXT NOT NULL DEFAULT 'none',
        authToken TEXT,
        apiKeyHeaderName TEXT,
        oauth2Config TEXT,
        timeout INTEGER,
        UNIQUE(projectId, name)
      );
    `);

    // Add timeout column for existing databases
    try { await this.run(`ALTER TABLE environments ADD COLUMN timeout INTEGER;`); } catch {} // Ignore if column exists

    await this.run(`
      CREATE TABLE IF NOT EXISTS auth_cache (
        environmentId INTEGER PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
        accessToken TEXT NOT NULL,
        expiresAt INTEGER NOT NULL
      );
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        environmentId INTEGER REFERENCES environments(id) ON DELETE SET NULL,
        projectName TEXT NOT NULL,
        environmentName TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        url TEXT NOT NULL,
        method TEXT NOT NULL,
        requestHeaders TEXT,
        requestBody TEXT,
        responseStatus INTEGER NOT NULL,
        responseHeaders TEXT,
        responseBody TEXT,
        durationMs INTEGER NOT NULL,
        success INTEGER NOT NULL DEFAULT 1
      );
    `);

    // Performance indexes for history queries
    await this.run(`CREATE INDEX IF NOT EXISTS idx_history_environmentId ON history(environmentId);`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp);`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_history_method ON history(method);`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_history_success ON history(success);`);

    await this.run(`
      CREATE TABLE IF NOT EXISTS test_suites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        projectId INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        steps TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(projectId, name)
      );
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Seed default data if empty
    await this.seedDefaults();
  }

  /**
   * Seeds default Project and active Environment states if DB is fresh.
   */
  private async seedDefaults(): Promise<void> {
    const projects = await this.all<ProjectRecord>('SELECT * FROM projects');
    if (projects.length === 0) {
      const now = new Date().toISOString();
      const pId = await this.createProject('DefaultProject', 'Default postmcp testing space');
      const eId = await this.configureEnvironment(pId, 'default', {
        baseUrl: '',
        headers: JSON.stringify({}),
        cookies: JSON.stringify({}),
        variables: JSON.stringify({}),
        authType: 'none'
      });

      await this.run("INSERT INTO app_state (key, value) VALUES ('active_project_id', ?)", [String(pId)]);
      await this.run("INSERT INTO app_state (key, value) VALUES ('active_environment_id', ?)", [String(eId)]);
    } else {
      // Ensure app_state references are intact
      const activeProj = await this.get<{ value: string }>("SELECT value FROM app_state WHERE key = 'active_project_id'");
      const activeEnv = await this.get<{ value: string }>("SELECT value FROM app_state WHERE key = 'active_environment_id'");
      
      if (!activeProj || !activeEnv) {
        const defaultProj = projects[0];
        const defaultEnv = await this.get<EnvironmentRecord>('SELECT * FROM environments WHERE projectId = ? LIMIT 1', [defaultProj.id]);
        
        if (defaultEnv) {
          await this.run("INSERT OR REPLACE INTO app_state (key, value) VALUES ('active_project_id', ?)", [String(defaultProj.id)]);
          await this.run("INSERT OR REPLACE INTO app_state (key, value) VALUES ('active_environment_id', ?)", [String(defaultEnv.id)]);
        }
      }
    }
  }

  // --- SQLite Query Promise Wrappers ---
  run(sql: string, params: any[] = []): Promise<{ lastID: number; changes: number }> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row as T);
      });
    });
  }

  all<T>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows as T[]);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve();
        return;
      }
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // --- APP STATE QUERIES ---
  async getActiveProjectId(): Promise<number> {
    const row = await this.get<{ value: string }>("SELECT value FROM app_state WHERE key = 'active_project_id'");
    return row ? parseInt(row.value, 10) : 1;
  }

  async getActiveEnvironmentId(): Promise<number> {
    const row = await this.get<{ value: string }>("SELECT value FROM app_state WHERE key = 'active_environment_id'");
    return row ? parseInt(row.value, 10) : 1;
  }

  async getActiveProjectAndEnv(): Promise<{ projectId: number; projectName: string; envId: number; envName: string }> {
    const projectId = await this.getActiveProjectId();
    const envId = await this.getActiveEnvironmentId();

    const project = await this.get<ProjectRecord>('SELECT name FROM projects WHERE id = ?', [projectId]);
    const env = await this.get<EnvironmentRecord>('SELECT name FROM environments WHERE id = ?', [envId]);

    return {
      projectId,
      projectName: project?.name || 'UnknownProject',
      envId,
      envName: env?.name || 'UnknownEnv'
    };
  }

  // --- ALLOWLIST MANAGEMENT ---
  async getAllowlist(): Promise<string[]> {
    const row = await this.get<{ value: string }>("SELECT value FROM app_state WHERE key = 'allowlist'");
    return row ? JSON.parse(row.value) : [];
  }

  async setAllowlist(domains: string[]): Promise<void> {
    const normalized = Array.from(new Set(domains.map(domain => domain.trim().toLowerCase()).filter(Boolean)));
    await this.run("INSERT OR REPLACE INTO app_state (key, value) VALUES ('allowlist', ?)", [JSON.stringify(normalized)]);
  }

  async isUrlAllowed(urlStr: string): Promise<boolean> {
    try {
      await this.assertUrlAllowed(urlStr);
      return true;
    } catch {
      return false;
    }
  }

  async assertUrlAllowed(urlStr: string, allowedProtocols: string[] = ['http:', 'https:', 'ws:', 'wss:']): Promise<URL> {
    return assertSafeOutboundUrl(urlStr, await this.getAllowlist(), allowedProtocols);
  }

  // --- PROJECTS CRUD ---
  async createProject(name: string, description?: string): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.run(
      'INSERT INTO projects (name, description, createdAt) VALUES (?, ?, ?)',
      [name, description || '', now]
    );
    
    // Auto-create a default environment for the project
    await this.configureEnvironment(result.lastID, 'default', { baseUrl: '' });

    return result.lastID;
  }

  async switchProject(id: number): Promise<void> {
    // Check if project exists
    const proj = await this.get<ProjectRecord>('SELECT * FROM projects WHERE id = ?', [id]);
    if (!proj) throw new Error(`Project with ID ${id} not found.`);

    // Find default or first environment for this project
    let env = await this.get<EnvironmentRecord>("SELECT * FROM environments WHERE projectId = ? AND name = 'default'", [id]);
    if (!env) {
      env = await this.get<EnvironmentRecord>('SELECT * FROM environments WHERE projectId = ? LIMIT 1', [id]);
    }

    if (!env) {
      throw new Error(`Project with ID ${id} has no environments configured.`);
    }

    await this.run("UPDATE app_state SET value = ? WHERE key = 'active_project_id'", [String(id)]);
    await this.run("UPDATE app_state SET value = ? WHERE key = 'active_environment_id'", [String(env.id)]);
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return this.all<ProjectRecord>('SELECT * FROM projects ORDER BY name ASC');
  }

  async deleteProject(id: number): Promise<void> {
    const activeProjId = await this.getActiveProjectId();
    if (activeProjId === id) {
      // Find another project to activate first
      const other = await this.get<ProjectRecord>('SELECT id FROM projects WHERE id != ? LIMIT 1', [id]);
      if (!other) {
        throw new Error('Cannot delete the last remaining project. Create another project first.');
      }
      await this.switchProject(other.id);
    }
    await this.run('DELETE FROM projects WHERE id = ?', [id]);
  }

  // --- ENVIRONMENTS CRUD ---
  async configureEnvironment(projectId: number, name: string, data: Partial<Omit<EnvironmentRecord, 'id' | 'projectId' | 'name'>>): Promise<number> {
    const existing = await this.get<EnvironmentRecord>(
      'SELECT id FROM environments WHERE projectId = ? AND name = ?',
      [projectId, name]
    );

    if (existing) {
      // Update
      const updates: string[] = [];
      const params: any[] = [];
      for (const [key, val] of Object.entries(data)) {
        if (val !== undefined) {
          updates.push(`${key} = ?`);
          params.push(val);
        }
      }
      if (updates.length > 0) {
        params.push(existing.id);
        await this.run(
          `UPDATE environments SET ${updates.join(', ')} WHERE id = ?`,
          params
        );
      }
      return existing.id;
    } else {
      // Insert
      const result = await this.run(
        `INSERT INTO environments (projectId, name, baseUrl, headers, cookies, variables, authType, authToken, apiKeyHeaderName, oauth2Config, timeout)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          projectId,
          name,
          data.baseUrl || '',
          data.headers || '{}',
          data.cookies || '{}',
          data.variables || '{}',
          data.authType || 'none',
          data.authToken || '',
          data.apiKeyHeaderName || 'x-api-key',
          data.oauth2Config || '{}',
          data.timeout ?? null
        ]
      );
      return result.lastID;
    }
  }

  async switchEnvironment(id: number): Promise<void> {
    const env = await this.get<EnvironmentRecord>('SELECT * FROM environments WHERE id = ?', [id]);
    if (!env) throw new Error(`Environment with ID ${id} not found.`);

    // Switch active environment and active project to match
    await this.run("UPDATE app_state SET value = ? WHERE key = 'active_project_id'", [String(env.projectId)]);
    await this.run("UPDATE app_state SET value = ? WHERE key = 'active_environment_id'", [String(env.id)]);
  }

  async listEnvironments(projectId: number): Promise<EnvironmentRecord[]> {
    return this.all<EnvironmentRecord>('SELECT * FROM environments WHERE projectId = ? ORDER BY name ASC', [projectId]);
  }

  async getEnvironmentById(id: number): Promise<EnvironmentRecord | undefined> {
    return this.get<EnvironmentRecord>('SELECT * FROM environments WHERE id = ?', [id]);
  }

  async getEnvironmentByName(projectId: number, name: string): Promise<EnvironmentRecord | undefined> {
    return this.get<EnvironmentRecord>('SELECT * FROM environments WHERE projectId = ? AND name = ?', [projectId, name]);
  }

  async deleteEnvironment(id: number): Promise<void> {
    const env = await this.get<EnvironmentRecord>('SELECT * FROM environments WHERE id = ?', [id]);
    if (!env) return;

    if (env.name === 'default') {
      throw new Error('Cannot delete the "default" environment profile.');
    }

    const activeEnvId = await this.getActiveEnvironmentId();
    if (activeEnvId === id) {
      // Fallback active env to "default" environment of this project
      const fallback = await this.get<EnvironmentRecord>(
        "SELECT id FROM environments WHERE projectId = ? AND name = 'default'",
        [env.projectId]
      );
      if (fallback) {
        await this.run("UPDATE app_state SET value = ? WHERE key = 'active_environment_id'", [String(fallback.id)]);
      }
    }

    await this.run('DELETE FROM environments WHERE id = ?', [id]);
  }

  async setEnvironmentVariable(envId: number, key: string, value: any): Promise<void> {
    const env = await this.get<EnvironmentRecord>('SELECT variables FROM environments WHERE id = ?', [envId]);
    if (!env) throw new Error(`Environment with ID ${envId} not found.`);

    const vars = JSON.parse(env.variables || '{}');
    vars[key] = value;

    await this.run('UPDATE environments SET variables = ? WHERE id = ?', [JSON.stringify(vars), envId]);
  }

  async getEnvironmentVariable(envId: number, key: string): Promise<any | undefined> {
    const env = await this.get<EnvironmentRecord>('SELECT variables FROM environments WHERE id = ?', [envId]);
    if (!env) return undefined;
    const vars = JSON.parse(env.variables || '{}');
    return vars[key];
  }

  async deleteEnvironmentVariable(envId: number, key: string): Promise<boolean> {
    const env = await this.get<EnvironmentRecord>('SELECT variables FROM environments WHERE id = ?', [envId]);
    if (!env) throw new Error(`Environment with ID ${envId} not found.`);

    const vars = JSON.parse(env.variables || '{}');
    if (!(key in vars)) return false;

    delete vars[key];
    await this.run('UPDATE environments SET variables = ? WHERE id = ?', [JSON.stringify(vars), envId]);
    return true;
  }

  async listEnvironmentVariables(envId: number): Promise<Record<string, any>> {
    const env = await this.get<EnvironmentRecord>('SELECT variables FROM environments WHERE id = ?', [envId]);
    if (!env) return {};
    return JSON.parse(env.variables || '{}');
  }

  async renameProject(id: number, name: string): Promise<void> {
    const proj = await this.get<ProjectRecord>('SELECT * FROM projects WHERE id = ?', [id]);
    if (!proj) throw new Error(`Project with ID ${id} not found.`);
    await this.run('UPDATE projects SET name = ? WHERE id = ?', [name, id]);
  }

  async renameEnvironment(id: number, name: string): Promise<void> {
    const env = await this.get<EnvironmentRecord>('SELECT * FROM environments WHERE id = ?', [id]);
    if (!env) throw new Error(`Environment with ID ${id} not found.`);
    await this.run('UPDATE environments SET name = ? WHERE id = ?', [name, id]);
  }

  // --- TEST SUITE CRUD ---
  async saveTestSuite(projectId: number, name: string, steps: any[], description?: string): Promise<number> {
    const existing = await this.get<{ id: number }>('SELECT id FROM test_suites WHERE projectId = ? AND name = ?', [projectId, name]);
    const now = new Date().toISOString();
    const stepsJson = JSON.stringify(steps);
    if (existing) {
      await this.run('UPDATE test_suites SET steps = ?, description = ?, updatedAt = ? WHERE id = ?', [stepsJson, description || '', now, existing.id]);
      return existing.id;
    } else {
      const result = await this.run(
        'INSERT INTO test_suites (projectId, name, description, steps, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
        [projectId, name, description || '', stepsJson, now, now]
      );
      return result.lastID;
    }
  }

  async loadTestSuite(id: number): Promise<{ id: number; projectId: number; name: string; description: string; steps: any[]; createdAt: string; updatedAt: string } | undefined> {
    const row = await this.get<any>('SELECT * FROM test_suites WHERE id = ?', [id]);
    if (!row) return undefined;
    return { ...row, steps: JSON.parse(row.steps) };
  }

  async listTestSuites(projectId: number): Promise<{ id: number; name: string; description: string; steps: string; createdAt: string; updatedAt: string }[]> {
    return this.all<any>('SELECT id, name, description, steps, createdAt, updatedAt FROM test_suites WHERE projectId = ? ORDER BY name ASC', [projectId]);
  }

  async deleteTestSuite(id: number): Promise<void> {
    await this.run('DELETE FROM test_suites WHERE id = ?', [id]);
  }

  // --- HISTORY EXPORT ---
  async exportHistory(projectId?: number): Promise<any[]> {
    let rows: any[];
    if (projectId) {
      rows = await this.all<any>('SELECT * FROM history WHERE environmentId IN (SELECT id FROM environments WHERE projectId = ?) ORDER BY id DESC', [projectId]);
    } else {
      rows = await this.all<any>('SELECT * FROM history ORDER BY id DESC');
    }
    return rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      project: r.projectName,
      environment: r.environmentName,
      method: r.method,
      url: r.url,
      status: r.responseStatus,
      durationMs: r.durationMs,
      success: r.success === 1
    }));
  }

  // --- ENVIRONMENT EXPORT/IMPORT ---
  async exportEnvironment(envId: number, includeSecrets = false): Promise<any> {
    const env = await this.get<EnvironmentRecord>('SELECT * FROM environments WHERE id = ?', [envId]);
    if (!env) throw new Error(`Environment with ID ${envId} not found.`);
    const headers = JSON.parse(env.headers || '{}');
    const cookies = JSON.parse(env.cookies || '{}');
    const variables = JSON.parse(env.variables || '{}');
    const oauth2Config = env.oauth2Config ? JSON.parse(env.oauth2Config) : undefined;
    return {
      name: env.name,
      baseUrl: env.baseUrl,
      headers: includeSecrets ? headers : redactHeaders(headers, [env.apiKeyHeaderName || 'x-api-key']),
      cookies: includeSecrets ? cookies : Object.fromEntries(Object.keys(cookies).map(key => [key, '********'])),
      variables: includeSecrets ? variables : redactSensitiveData(variables),
      authType: env.authType,
      authToken: includeSecrets && env.authToken ? env.authToken : (env.authToken ? '********' : ''),
      apiKeyHeaderName: env.apiKeyHeaderName,
      oauth2Config: includeSecrets ? oauth2Config : redactSensitiveData(oauth2Config),
      timeout: env.timeout,
      secretsRedacted: !includeSecrets,
    };
  }

  async importEnvironment(projectId: number, data: any): Promise<number> {
    return this.configureEnvironment(projectId, data.name, {
      baseUrl: data.baseUrl,
      headers: data.headers ? JSON.stringify(data.headers) : undefined,
      cookies: data.cookies ? JSON.stringify(data.cookies) : undefined,
      variables: data.variables ? JSON.stringify(data.variables) : undefined,
      authType: data.authType,
      authToken: data.authToken,
      apiKeyHeaderName: data.apiKeyHeaderName,
      oauth2Config: data.oauth2Config ? JSON.stringify(data.oauth2Config) : undefined,
      timeout: data.timeout
    });
  }

  // --- PROJECT EXPORT/IMPORT ---
  async exportProject(projectId: number, includeSecrets = false): Promise<any> {
    const proj = await this.get<ProjectRecord>('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (!proj) throw new Error(`Project with ID ${projectId} not found.`);
    const envs = await this.listEnvironments(projectId);
    const exportedEnvs = await Promise.all(envs.map(e => this.exportEnvironment(e.id, includeSecrets)));
    return {
      name: proj.name,
      description: proj.description,
      environments: exportedEnvs
    };
  }

  async importProject(data: any): Promise<number> {
    const pId = await this.createProject(data.name, data.description);
    if (data.environments && Array.isArray(data.environments)) {
      for (const envData of data.environments) {
        await this.importEnvironment(pId, envData);
      }
    }
    return pId;
  }

  // --- HISTORY LOGS ---
  async logRequest(data: Omit<HistoryRecord, 'id' | 'timestamp'>): Promise<number> {
    const timestamp = new Date().toISOString();
    const result = await this.run(
      `INSERT INTO history (environmentId, projectName, environmentName, timestamp, url, method, requestHeaders, requestBody, responseStatus, responseHeaders, responseBody, durationMs, success)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.environmentId || null,
        data.projectName,
        data.environmentName,
        timestamp,
        data.url,
        data.method,
        data.requestHeaders || '{}',
        data.requestBody || '',
        data.responseStatus,
        data.responseHeaders || '{}',
        data.responseBody || '',
        data.durationMs,
        data.success
      ]
    );
    return result.lastID;
  }

  async listHistory(filters: {
    projectId?: number;
    environmentId?: number;
    limit?: number;
    offset?: number;
    method?: string;
    statusCode?: number;
    urlKeyword?: string;
    dateFrom?: string;
    dateTo?: string;
    success?: number;
  } = {}): Promise<HistoryRecord[]> {
    let query = 'SELECT * FROM history';
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.environmentId) {
      conditions.push('environmentId = ?');
      params.push(filters.environmentId);
    } else if (filters.projectId) {
      conditions.push('environmentId IN (SELECT id FROM environments WHERE projectId = ?)');
      params.push(filters.projectId);
    }

    if (filters.method) {
      conditions.push('method = ?');
      params.push(filters.method.toUpperCase());
    }

    if (filters.statusCode !== undefined) {
      conditions.push('responseStatus = ?');
      params.push(filters.statusCode);
    }

    if (filters.urlKeyword) {
      conditions.push('url LIKE ?');
      params.push(`%${filters.urlKeyword}%`);
    }

    if (filters.dateFrom) {
      conditions.push('timestamp >= ?');
      params.push(filters.dateFrom);
    }

    if (filters.dateTo) {
      conditions.push('timestamp <= ?');
      params.push(filters.dateTo);
    }

    if (filters.success !== undefined) {
      conditions.push('success = ?');
      params.push(filters.success);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY id DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }
    if (filters.offset) {
      query += ' OFFSET ?';
      params.push(filters.offset);
    }

    return this.all<HistoryRecord>(query, params);
  }

  async getHistoryById(id: number): Promise<HistoryRecord | undefined> {
    return this.get<HistoryRecord>('SELECT * FROM history WHERE id = ?', [id]);
  }

  async clearHistory(olderThanSeconds?: number): Promise<number> {
    if (olderThanSeconds) {
      const boundaryTime = new Date(Date.now() - olderThanSeconds * 1000).toISOString();
      const result = await this.run('DELETE FROM history WHERE timestamp < ?', [boundaryTime]);
      return result.changes;
    } else {
      const result = await this.run('DELETE FROM history');
      return result.changes;
    }
  }

  // --- AUTH CACHE ---
  async getCachedToken(envId: number): Promise<AuthCacheEntry | undefined> {
    return this.get<AuthCacheEntry>('SELECT * FROM auth_cache WHERE environmentId = ?', [envId]);
  }

  async setCachedToken(envId: number, accessToken: string, expiresAt: number): Promise<void> {
    await this.run(
      'INSERT OR REPLACE INTO auth_cache (environmentId, accessToken, expiresAt) VALUES (?, ?, ?)',
      [envId, accessToken, expiresAt]
    );
  }

  async clearCachedToken(envId: number): Promise<void> {
    await this.run('DELETE FROM auth_cache WHERE environmentId = ?', [envId]);
  }

  // --- DATABASE MAINTENANCE ---
  async getDatabaseStats(): Promise<{
    filePath: string;
    fileSize: number;
    projectsCount: number;
    environmentsCount: number;
    historyCount: number;
    authCacheCount: number;
  }> {
    const stat = await fs.stat(this.dbPath);
    
    const projCountRow = await this.get<{ 'COUNT(*)': number }>('SELECT COUNT(*) FROM projects');
    const envCountRow = await this.get<{ 'COUNT(*)': number }>('SELECT COUNT(*) FROM environments');
    const histCountRow = await this.get<{ 'COUNT(*)': number }>('SELECT COUNT(*) FROM history');
    const cacheCountRow = await this.get<{ 'COUNT(*)': number }>('SELECT COUNT(*) FROM auth_cache');

    return {
      filePath: this.dbPath,
      fileSize: stat.size,
      projectsCount: projCountRow ? projCountRow['COUNT(*)'] : 0,
      environmentsCount: envCountRow ? envCountRow['COUNT(*)'] : 0,
      historyCount: histCountRow ? histCountRow['COUNT(*)'] : 0,
      authCacheCount: cacheCountRow ? cacheCountRow['COUNT(*)'] : 0
    };
  }

  async resetDatabase(): Promise<void> {
    await this.close();
    await fs.unlink(this.dbPath);
    await this.initialize();
  }
}
