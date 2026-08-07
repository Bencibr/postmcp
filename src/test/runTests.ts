import path from 'path';
import fs from 'fs/promises';
import { MockServer } from './mockServer.js';
import { DbManager } from '../db/sqlite.js';
import { HttpClient } from '../client/http.js';
import { WebSocketManager } from '../client/ws.js';
import { AssertionEngine } from '../utils/assertion.js';
import { DiffEngine } from '../utils/diff.js';
import { SwaggerParser } from '../utils/swagger.js';
import { redactBody, redactSensitiveData } from '../utils/security.js';

function interpolate(target: any, variables: Record<string, any>): any {
  if (typeof target === 'string') {
    return target.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
      const trimmed = key.trim();
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

async function runTests() {
  console.log('🚀 Starting SQLite Unified DB Integration Tests...');
  const port = 8089;
  const mockServer = new MockServer(port);
  await mockServer.start();

  // Create temporary DB path to avoid polluting user config
  const tempDbPath = path.join(process.cwd(), 'src', 'test', 'temp_postmcp.db');
  
  // Clean up any old temp DB file
  try {
    await fs.unlink(tempDbPath);
  } catch {}

  const dbManager = new DbManager(tempDbPath);
  await dbManager.initialize();
  await dbManager.setAllowlist(['private:localhost']);

  const httpClient = new HttpClient(dbManager);
  const wsManager = new WebSocketManager(dbManager);

  let successCount = 0;
  let failCount = 0;

  const assert = (condition: boolean, message: string) => {
    if (condition) {
      console.log(` ✅ ${message}`);
      successCount++;
    } else {
      console.error(` ❌ FAILED: ${message}`);
      failCount++;
    }
  };

  try {
    // 1. Test Project Operations
    console.log('\n--- Test 1: Project Operations ---');
    const pId = await dbManager.createProject('MyProject', 'Tests workspace');
    assert(pId > 0, `Created project "MyProject" with ID: ${pId}`);

    const projects = await dbManager.listProjects();
    assert(projects.some(p => p.name === 'MyProject'), 'Project "MyProject" listed in DB');

    await dbManager.switchProject(pId);
    const state = await dbManager.getActiveProjectAndEnv();
    assert(state.projectId === pId && state.envName === 'default', `Active project set to ${state.projectName} (ID: ${state.projectId})`);

    // 2. Test Environment Configurations
    console.log('\n--- Test 2: Environment Operations ---');
    const devId = await dbManager.configureEnvironment(pId, 'dev', {
      baseUrl: `http://localhost:${port}`,
      headers: JSON.stringify({ 'X-Client': 'TestApp' }),
      variables: JSON.stringify({ username: 'admin', password: 'secret' }),
      authType: 'none'
    });
    assert(devId > 0, `Configured environment "dev" with ID: ${devId}`);

    const prodId = await dbManager.configureEnvironment(pId, 'prod', {
      baseUrl: `http://localhost:${port}`,
      authType: 'bearer',
      authToken: 'mock-jwt-token-xyz'
    });
    assert(prodId > 0, `Configured environment "prod" with ID: ${prodId}`);

    await dbManager.switchEnvironment(devId);
    const activeState = await dbManager.getActiveProjectAndEnv();
    assert(activeState.envId === devId && activeState.envName === 'dev', 'Switched environment to "dev"');

    // 3. Test HttpClient GET (verify baseUrl resolution and headers)
    console.log('\n--- Test 3: HTTP GET & JSONPath ---');
    const getRes = await httpClient.send({
      url: '/api/users/1',
      method: 'GET',
      jsonpathFilter: '$.name'
    });
    assert(getRes.status === 200, `GET /api/users/1 code is ${getRes.status}`);
    assert(getRes.body === 'Alice', `Response filtered name matches Alice: "${getRes.body}"`);

    const report = AssertionEngine.run(getRes, [
      { type: 'body', property: '$.role', operator: 'equals', expected: 'admin' }
    ]);
    assert(report.passed, `Assertion on fullBody passed: ${report.passed}`);

    // 4. Test DB History logging
    console.log('\n--- Test 4: Verify request logged in SQLite history table ---');
    const history = await dbManager.listHistory({ environmentId: devId });
    assert(history.length === 1, `History logged count: ${history.length}`);
    assert(history[0].url === `http://localhost:${port}/api/users/1`, `Logged full URL: "${history[0].url}"`);
    assert(history[0].responseStatus === 200, `Logged status: ${history[0].responseStatus}`);
    assert(JSON.parse(history[0].requestHeaders || '{}')['X-Client'] === 'TestApp', 'Logged default headers correctly');

    // 5. Test HttpClient POST with variables
    console.log('\n--- Test 5: HTTP POST & Variable Extraction ---');
    const env = await dbManager.getEnvironmentById(devId);
    const vars = JSON.parse(env?.variables || '{}');

    const loginRes = await httpClient.send({
      url: '/api/login',
      method: 'POST',
      body: interpolate({
        username: '{{username}}',
        password: '{{password}}'
      }, vars),
      bodyType: 'json'
    });

    assert(loginRes.status === 200, `Login status: ${loginRes.status}`);
    const token = loginRes.body.token;
    assert(token === 'mock-jwt-token-xyz', `Login token retrieved: "${token}"`);

    // Save token variable to dev env in DB
    await dbManager.setEnvironmentVariable(devId, 'sessionToken', token);
    const updatedEnv = await dbManager.getEnvironmentById(devId);
    assert(JSON.parse(updatedEnv?.variables || '{}')['sessionToken'] === token, 'Variable "sessionToken" updated in database');

    // 6. Test Authenticated HTTP request
    console.log('\n--- Test 6: Auth request with dynamic variables ---');
    const updatedVars = JSON.parse(updatedEnv?.variables || '{}');
    const secureRes = await httpClient.send({
      url: '/api/secure/data',
      method: 'GET',
      headers: interpolate({
        'Authorization': 'Bearer {{sessionToken}}'
      }, updatedVars)
    });

    assert(secureRes.status === 200, `Secure path response code is ${secureRes.status}`);
    assert(secureRes.body.data === 'sensitive-secret', `Secure path data matches: "${secureRes.body.data}"`);

    // Check header redaction in history db
    const historyList = await dbManager.listHistory({ environmentId: devId });
    const authHeaderInDb = JSON.parse(historyList[0].requestHeaders || '{}')['Authorization'];
    assert(authHeaderInDb === '********', `Auth header redacted in database log: "${authHeaderInDb}"`);

    // 7. Test DiffEngine
    console.log('\n--- Test 7: Response comparisons diff generation ---');
    const log1 = historyList[1]; // GET /api/users/1
    const log2 = historyList[0]; // GET /api/secure/data

    const mdDiff = DiffEngine.renderMarkdownDiff(
      log1.id,
      log2.id,
      log1.responseStatus,
      log2.responseStatus,
      log1.durationMs,
      log2.durationMs,
      log1.responseBody || '',
      log2.responseBody || ''
    );
    assert(mdDiff.includes('Comparison') && mdDiff.includes('Response Body Diff'), 'Markdown comparison diff rendered successfully');

    // 8. Test WebSockets
    console.log('\n--- Test 8: WebSocket persistence & allowlists ---');
    const wsUrl = `ws://localhost:${port}/ws`;
    const wsConn = await wsManager.connect(wsUrl);
    assert(wsConn.status === 'open', `WebSocket connected with connectionId: ${wsConn.connectionId}`);

    await wsManager.send(wsConn.connectionId, 'hello socket');
    const wsLogs = await wsManager.read(wsConn.connectionId, 10, 'echo: hello socket', 2000);
    assert(wsLogs.some(m => m.data === 'echo: hello socket'), 'WebSocket read correctly matches echo message');

    await wsManager.close(wsConn.connectionId);
    assert(wsManager.listConnections().length === 0, 'WebSocket closed cleanly');

    // 8b. Test WebSocket variable interpolation in absolute/relative URLs and headers
    console.log('\n--- Test 8b: WebSocket URL/header variable interpolation ---');
    await dbManager.setEnvironmentVariable(devId, 'token', 'abc');

    const wsAbsConn = await wsManager.connect(`ws://localhost:${port}/ws?token={{token}}`);
    assert(wsAbsConn.status === 'open', 'WebSocket connected with absolute URL containing {{token}}');
    assert(mockServer.lastWsQuery?.get('token') === 'abc', `Absolute WS URL token interpolated: got "${mockServer.lastWsQuery?.get('token')}" expected "abc"`);
    await wsManager.close(wsAbsConn.connectionId);

    const wsRelConn = await wsManager.connect(`/ws?token={{token}}`);
    assert(wsRelConn.status === 'open', 'WebSocket connected with relative path containing {{token}}');
    assert(mockServer.lastWsQuery?.get('token') === 'abc', `Relative WS URL token interpolated: got "${mockServer.lastWsQuery?.get('token')}" expected "abc"`);
    await wsManager.close(wsRelConn.connectionId);

    const wsHeaderConn = await wsManager.connect(`ws://localhost:${port}/ws`, { 'X-Api-Key': '{{token}}' });
    assert(wsHeaderConn.status === 'open', 'WebSocket connected with header containing {{token}}');
    assert(mockServer.lastWsHeaders?.['x-api-key'] === 'abc', `WS header token interpolated: got "${mockServer.lastWsHeaders?.['x-api-key']}" expected "abc"`);
    await wsManager.close(wsHeaderConn.connectionId);

    // 8c. Test history_get exposes plaintext response token while list/summary stays masked
    console.log('\n--- Test 8c: history_get shows plaintext response token (summary stays masked) ---');
    const loginDetail = await httpClient.send({
      url: '/api/login',
      method: 'POST',
      body: { username: 'admin', password: 'secret' },
      bodyType: 'json'
    });
    assert(loginDetail.status === 200, 'Fresh login to inspect history detail');

    const recentRows = await dbManager.listHistory({ environmentId: devId, method: 'POST', limit: 1 });
    const detailRow = recentRows[0];
    assert(Boolean(detailRow.responseBody?.includes('mock-jwt-token-xyz')), 'history_get response body contains plaintext token (reusable for later requests)');
    assert(!detailRow.responseBody?.includes('"token": "********"'), 'history_get response body token is not masked');
    assert(Boolean(detailRow.requestBody?.includes('"password": "********"')), 'history_get request body password stays masked');

    // Default redaction (used by list/summary/other paths) must keep masking secrets
    assert(redactSensitiveData({ token: 'mock-jwt-token-xyz', password: 'pw' }).token === '********', 'Default redactSensitiveData still masks token keys');
    assert(redactBody({ token: 'mock-jwt-token-xyz' }).includes('"token": "********"'), 'Default redactBody still masks secrets');
    assert(redactBody({ token: 'mock-jwt-token-xyz' }, false).includes('mock-jwt-token-xyz'), 'redactBody with maskSecrets=false preserves tokens');

    // 9. Test Database Maintenance
    console.log('\n--- Test 9: Database Stats & Reset ---');
    const stats = await dbManager.getDatabaseStats();
    assert(stats.projectsCount === 2, `Stats projects count: ${stats.projectsCount}`);
    assert(stats.fileSize > 0, `Database file size is valid: ${stats.fileSize} bytes`);

    await dbManager.resetDatabase();
    await dbManager.setAllowlist(['private:localhost']);
    const newStats = await dbManager.getDatabaseStats();
    assert(newStats.projectsCount === 1, `Factory reset succeeded. Projects count reset to: ${newStats.projectsCount}`);
    const activeInfo = await dbManager.getActiveProjectAndEnv();
    assert(activeInfo.projectName === 'DefaultProject', 'Default project re-seeded successfully after reset');

    // 10. Test Swagger Import (JSON & YAML, File & URL)
    console.log('\n--- Test 10: Swagger / OpenAPI Import ---');
    const swaggerParser = new SwaggerParser(dbManager);
    
    // Test Local YAML import
    const yamlPath = path.join(process.cwd(), 'src', 'test', 'mockSwagger.yaml');
    const yamlDoc = await swaggerParser.importSpec({ filePath: yamlPath, confirmFileAccess: true });
    assert(yamlDoc.includes('Mock User API') && yamlDoc.includes('GET') && yamlDoc.includes('/users'), 'Local YAML Swagger spec parsed successfully');

    // Test Local JSON import
    const jsonPath = path.join(process.cwd(), 'src', 'test', 'mockSwagger.json');
    const jsonDoc = await swaggerParser.importSpec({ filePath: jsonPath, confirmFileAccess: true });
    assert(jsonDoc.includes('Mock User API Legacy') && jsonDoc.includes('Retrieve all users legacy'), 'Local JSON Swagger spec parsed successfully');

    // Test Remote JSON import via URL
    const remoteUrl = `http://localhost:${port}/swagger.json`;
    const remoteDoc = await swaggerParser.importSpec({ url: remoteUrl });
    assert(remoteDoc.includes('Mock Remote API') && remoteDoc.includes('Retrieve all users remotely'), 'Remote URL JSON Swagger spec parsed successfully');

  } catch (err: any) {
    console.error(`\n❌ CRITICAL EXCEPTION during integration tests: ${err.message}`);
    console.error(err.stack);
    failCount++;
  } finally {
    // Cleanup
    await mockServer.stop();
    await dbManager.close();
    try {
      await fs.unlink(tempDbPath);
    } catch {}

    console.log('\n========================================');
    console.log(`🏁 Test Results Summary:`);
    console.log(`   Passed: ${successCount}`);
    console.log(`   Failed: ${failCount}`);
    console.log('========================================');

    if (failCount > 0) {
      process.exit(1);
    } else {
      console.log('🎉 All integration tests passed successfully!');
      process.exit(0);
    }
  }
}

runTests();
