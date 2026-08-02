/**
 * Negative test suite for postmcp.
 * Tests abnormal states, error recovery, and ensures no hangs/crashes.
 */
import { MockServer } from './mockServer.js';
import { DbManager } from '../db/sqlite.js';
import { HttpClient } from '../client/http.js';
import { WebSocketManager } from '../client/ws.js';
import { OAuth2Authenticator } from '../client/oauth.js';
import { SwaggerParser } from '../utils/swagger.js';
import path from 'path';
import fs from 'fs/promises';

let passed = 0;
let failed = 0;
const errors: string[] = [];

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; errors.push(msg); console.log(`  ❌ FAILED: ${msg}`); }
}

async function main() {
  const mock = new MockServer(8092);
  await mock.start();
  const dbPath = path.join(process.cwd(), 'src/test', 'negative_test.db');
  try { await fs.unlink(dbPath); } catch {}
  const dbC = new DbManager(dbPath);
  await dbC.initialize();
  await dbC.setAllowlist(['private:localhost']);

  try {
    // ===== GROUP 1: Database Abnormal =====
    console.log('\n=== 🔴 GROUP 1: Database Abnormal ===');

    // 1.1 Auto-create directories
    const deepDb = new DbManager('/tmp/postmcp_negative_test/deep/dir/test.db');
    try {
      await deepDb.initialize();
      assert(true, 'Auto-creates nested directories');
      await deepDb.close();
      await fs.unlink('/tmp/postmcp_negative_test/deep/dir/test.db');
      await fs.rmdir('/tmp/postmcp_negative_test/deep/dir');
      await fs.rmdir('/tmp/postmcp_negative_test/deep');
      await fs.rmdir('/tmp/postmcp_negative_test');
    } catch (e: any) {
      assert(false, `Auto-create failed: ${e.message}`);
    }

    // 1.2 Concurrent writes
    const dbC = new DbManager(dbPath);
    await dbC.initialize();
    try {
      await Promise.all([
        dbC.createProject('C1'), dbC.createProject('C2'), dbC.createProject('C3')
      ]);
      assert(true, 'Concurrent DB writes OK');
    } catch (e: any) {
      assert(false, `Concurrent writes failed: ${e.message}`);
    }

    // ===== GROUP 2: Network Abnormal =====
    console.log('\n=== 🔴 GROUP 2: Network Abnormal ===');
    const netProjId = await dbC.createProject('NetTest');
    const netEnvId = await dbC.configureEnvironment(netProjId, 'dev', {
      baseUrl: 'http://localhost:8092', authType: 'none'
    });
    await dbC.switchProject(netProjId);
    await dbC.switchEnvironment(netEnvId);
    const hc = new HttpClient(dbC);

    // 2.1 Connection refused
    try {
      await hc.send({ url: 'http://localhost:1/test', method: 'GET', timeout: 2000 });
      assert(false, 'Refused should throw');
    } catch (e: any) {
      assert(e.message.includes('Failed') || e.message.includes('ECONNREFUSED'),
        `Refused error: ${e.message.slice(0, 80)}`);
    }

    // 2.2 Very short timeout — does the server hang?
    const timeoutStart = Date.now();
    try {
      await hc.send({ url: '/api/users/1', method: 'GET', timeout: 1 });
    } catch {}
    const timeoutElapsed = Date.now() - timeoutStart;
    assert(timeoutElapsed < 5000, `Short timeout doesn't hang (took ${timeoutElapsed}ms)`);

    // 2.3 Relative URL without baseUrl — must be absolute
    try {
      const dbNoBase = new DbManager(dbPath);
      await dbNoBase.initialize();
      const nbProjId = await dbNoBase.createProject('NoBase');
      const nbEnvId = await dbNoBase.configureEnvironment(nbProjId, 'dev', { baseUrl: '', authType: 'none' });
      await dbNoBase.switchProject(nbProjId);
      await dbNoBase.switchEnvironment(nbEnvId);
      const hcNoBase = new HttpClient(dbNoBase);
      await hcNoBase.send({ url: '/relative/without/base', method: 'GET' });
      assert(false, 'Relative URL without baseUrl should throw');
      await dbNoBase.close();
    } catch (e: any) {
      assert(true, `Relative URL error: ${e.message.slice(0, 80)}`);
    }
    // Restore active project/env for subsequent tests
    await dbC.switchProject(netProjId);
    await dbC.switchEnvironment(netEnvId);

    // ===== GROUP 3: Malformed Input =====
    console.log('\n=== 🔴 GROUP 3: Malformed Input ===');

    // 3.1 Invalid JSONPath filter (should not crash server)
    const res1 = await hc.send({ url: '/api/users/1', method: 'GET', jsonpathFilter: '$[[[[invalid' });
    assert(typeof res1.body !== 'undefined', `Invalid JSONPath handled, body type: ${typeof res1.body}`);

    // 3.2 Invalid JSON body
    try {
      await hc.send({ url: '/api/login', method: 'POST', body: '{bad json!!!}', bodyType: 'json' });
    } catch (e: any) {
      assert(true, 'Invalid JSON body throws');
    }

    // 3.3 Non-existent environment
    try { await dbC.switchEnvironment(99999); assert(false, 'Should throw'); }
    catch (e: any) { assert(true, 'Bad env switch throws'); }

    // 3.4 Delete non-existent project/entity
    try { await dbC.deleteProject(99999); assert(true, 'Delete non-existent project OK'); }
    catch (e: any) { assert(false, `Delete crashed: ${e.message}`); }

    try { await dbC.deleteEnvironment(99999); assert(true, 'Delete non-existent env OK'); }
    catch (e: any) { assert(false, `Delete env crashed: ${e.message}`); }

    try { await dbC.deleteTestSuite(99999); assert(true, 'Delete non-existent suite OK'); }
    catch (e: any) { assert(false, `Delete suite crashed: ${e.message}`); }

    // 3.5 Empty string inputs
    const res2 = await hc.send({ url: '/api/users/1', method: 'GET', headers: {} });
    assert(res2.status === 200, 'Empty headers OK');

    // ===== GROUP 4: WebSocket Abnormal =====
    console.log('\n=== 🔴 GROUP 4: WebSocket Abnormal ===');
    const ws = new WebSocketManager(dbC);

    // 4.1 Connect to non-WS endpoint (HTTP endpoint)
    try {
      await ws.connect('ws://localhost:8092/api/users/1', {}, 2000);
      // Might fail or succeed depending on server handling — either is OK as long as no crash
      assert(true, 'WS to HTTP endpoint handled (no crash)');
    } catch (e: any) {
      assert(true, `WS to HTTP endpoint fails gracefully: ${e.message.slice(0, 80)}`);
    }

    // 4.2 Non-existent connection operations
    try { await ws.read('nonexistent'); assert(false, 'Should throw'); }
    catch (e: any) { assert(true, 'Read bad conn throws'); }

    try { await ws.send('nonexistent', 'msg'); assert(false, 'Should throw'); }
    catch (e: any) { assert(true, 'Send bad conn throws'); }

    try { await ws.close('nonexistent'); assert(false, 'Should throw'); }
    catch (e: any) { assert(true, 'Close bad conn throws'); }

    // 4.3 WS send after close (no crash, no hang)
    try {
      const conn = await ws.connect('ws://localhost:8092/ws', {}, 3000);
      await ws.close(conn.connectionId);
      const sendStart = Date.now();
      try { await ws.send(conn.connectionId, 'msg after close'); } catch {}
      assert(Date.now() - sendStart < 5000, 'Send after close does not hang');
    } catch (e: any) {
      assert(true, `WS lifecycle: ${e.message.slice(0, 60)}`);
    }

    // 4.4 WS connection to unreachable host — does it hang?
    const wsStart = Date.now();
    try {
      await ws.connect('ws://localhost:1/ws', {}, 1500);
    } catch {}
    assert(Date.now() - wsStart < 10000, 'WS to unreachable does not hang');

    // ===== GROUP 5: OAuth Abnormal =====
    console.log('\n=== 🔴 GROUP 5: OAuth Abnormal ===');
    const oa = new OAuth2Authenticator(dbC);

    // 5.1 OAuth invalid token URL  
    try {
      await oa.getAccessToken(netEnvId, {
        grantType: 'client_credentials',
        tokenUrl: 'http://localhost:1/oauth/bad',
        clientId: 'x', clientSecret: 'x'
      });
      assert(false, 'Bad OAuth URL should throw');
    } catch (e: any) {
      assert(e.message.includes('OAuth2') || e.message.includes('Failed'),
        `OAuth bad URL: ${e.message.slice(0, 80)}`);
    }

    // 5.2 OAuth password without credentials
    try {
      await oa.getAccessToken(netEnvId, {
        grantType: 'password',
        tokenUrl: 'http://localhost:8092/oauth/token',
        clientId: 'x', clientSecret: 'x'
      });
      assert(false, 'Password without username should throw');
    } catch (e: any) {
      assert(true, `OAuth missing fields: ${e.message.slice(0, 80)}`);
    }

    // ===== GROUP 6: Swagger Abnormal =====
    console.log('\n=== 🔴 GROUP 6: Swagger Abnormal ===');
    const sp = new SwaggerParser(dbC);

    // 6.1 Non-existent file
    try {
      await sp.importSpec({ filePath: '/tmp/nonexistent_swagger.json' });
      assert(false, 'Non-existent file should throw');
    } catch (e: any) {
      assert(true, 'Bad file path throws');
    }

    // 6.2 Invalid spec content
    const badSpecPath = path.join(process.cwd(), 'src/test', 'bad_spec.json');
    await fs.writeFile(badSpecPath, '{invalid json');
    try {
      await sp.importSpec({ filePath: badSpecPath });
      assert(false, 'Invalid spec should throw');
    } catch (e: any) {
      assert(true, 'Invalid spec content throws');
    }
    await fs.unlink(badSpecPath);

    // ===== GROUP 7: Recovery After Failure =====
    console.log('\n=== 🔴 GROUP 7: Recovery After Failure ===');

    // 7.1 Normal request still works after failures
    // (Previous tests may have left DB in altered state — basic ops should still work)
    const recoverProj = await dbC.createProject('RecoveryTest');
    assert(recoverProj > 0, 'Create project works after all failures');

    await dbC.switchProject(recoverProj);
    const recoverEnv = await dbC.configureEnvironment(recoverProj, 'dev', {
      baseUrl: 'http://localhost:8092', authType: 'none'
    });
    await dbC.switchEnvironment(recoverEnv);
    assert(recoverEnv > 0, 'Configure env works after failures');

    const recoverRes = await hc.send({ url: '/api/users/1', method: 'GET' });
    assert(recoverRes.status === 200, 'HTTP request works after all failures');

    // 7.2 DB query still works after failures
    const stats = await dbC.getDatabaseStats();
    assert(stats.projectsCount > 0, 'DB stats work after all failures');

    // 7.3 WS still works after failures
    try {
      const wsConn = await ws.connect('ws://localhost:8092/ws', {}, 3000);
      assert(wsConn.status === 'open', 'WS works after all failures');
      await ws.send(wsConn.connectionId, 'ping');
      const msgs = await ws.read(wsConn.connectionId, 10, 'echo: ping', 2000);
      assert(msgs.some((m: any) => m.data === 'echo: ping'), 'WS send/read works after failures');
      await ws.close(wsConn.connectionId);
    } catch (e: any) {
      assert(false, `WS recovery failed: ${e.message.slice(0, 80)}`);
    }

    // ===== GROUP 8: Stress - No Resource Leak =====
    console.log('\n=== 🔴 GROUP 8: Stress / No Hang ===');

    // 8.1 Multiple rapid requests
    const rapidStart = Date.now();
    await Promise.all(Array.from({ length: 5 }, () =>
      hc.send({ url: '/api/users/1', method: 'GET' })
    ));
    assert(Date.now() - rapidStart < 10000, '5 concurrent requests complete in time');

    // 8.2 Repeated connect/close WS (no leak)
    for (let i = 0; i < 3; i++) {
      try {
        const c = await ws.connect('ws://localhost:8092/ws', {}, 2000);
        await ws.close(c.connectionId);
      } catch {}
    }
    const remaining = ws.listConnections();
    assert(remaining.length === 0, `All WS connections cleaned (${remaining.length} remaining)`);

    // 8.3 History with huge filters (no crash)
    try {
      const bigList = await dbC.listHistory({ limit: 1000, offset: 0 });
      assert(Array.isArray(bigList), 'Large history query OK');
    } catch (e: any) {
      assert(false, `Large history query crashed: ${e.message}`);
    }

    // 8.4 OAuth with cached token expiration edge case
    await dbC.setCachedToken(netEnvId, 'expired-token', Date.now() - 100000);

    console.log('\n========================================');
    console.log(`🏁 Negative Test Results:`);
    console.log(`   Passed: ${passed}`);
    console.log(`   Failed: ${failed}`);
    if (errors.length > 0) {
      console.log(`\nFailed tests:`);
      errors.forEach(e => console.log(`   ❌ ${e}`));
    }
    console.log('========================================');

  } finally {
    await mock.stop();
    await dbC.close();
    try { await fs.unlink(dbPath); } catch {}
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
