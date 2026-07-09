/**
 * Stress test for postmcp — measures throughput, latency, concurrency, memory.
 */
import { MockServer } from './mockServer.js';
import { DbManager } from '../db/sqlite.js';
import { HttpClient } from '../client/http.js';
import { WebSocketManager } from '../client/ws.js';
import path from 'path';
import fs from 'fs/promises';

async function stressTest() {
  const mock = new MockServer(8094);
  await mock.start();
  const dbPath = path.join(process.cwd(), 'src/test', 'stress_test.db');
  try { await fs.unlink(dbPath); } catch {}

  const db = new DbManager(dbPath);
  await db.initialize();
  const pId = await db.createProject('StressTest');
  const eId = await db.configureEnvironment(pId, 'dev', {
    baseUrl: 'http://localhost:8094', authType: 'none'
  });
  await db.switchProject(pId);
  await db.switchEnvironment(eId);
  const client = new HttpClient(db);

  // TEST 1: Sequential Throughput
  console.log('\n=== 📊 TEST 1: Sequential Throughput ===');
  const seqCount = 50;
  const seqStart = Date.now();
  for (let i = 0; i < seqCount; i++) {
    await client.send({ url: '/api/users/1', method: 'GET' });
  }
  const seqMs = Date.now() - seqStart;
  console.log(`  ${seqCount} sequential: ${seqMs}ms (${(seqCount / seqMs * 1000).toFixed(0)} req/s)`);

  // TEST 2: Parallel Throughput
  console.log('\n=== 📊 TEST 2: Parallel Throughput ===');
  const parCount = 30;
  const parStart = Date.now();
  await Promise.all(Array.from({ length: parCount }, () =>
    client.send({ url: '/api/users/1', method: 'GET' })
  ));
  const parMs = Date.now() - parStart;
  console.log(`  ${parCount} parallel:    ${parMs}ms (${(parCount / parMs * 1000).toFixed(0)} req/s)`);

  // TEST 3: Latency Distribution
  console.log('\n=== 📊 TEST 3: Latency Distribution ===');
  const latCount = 100;
  const lats: number[] = [];
  for (let i = 0; i < latCount; i++) {
    const s = Date.now();
    await client.send({ url: '/api/users/1', method: 'GET' });
    lats.push(Date.now() - s);
  }
  lats.sort((a: number, b: number) => a - b);
  const p50 = lats[Math.floor(latCount * 0.5)];
  const p90 = lats[Math.floor(latCount * 0.9)];
  const p99 = lats[Math.floor(latCount * 0.99)];
  const avg = (lats.reduce((a: number, b: number) => a + b, 0) / latCount).toFixed(1);
  console.log(`  P50: ${p50}ms | P90: ${p90}ms | P99: ${p99}ms | Avg: ${avg}ms`);

  // TEST 4: Mixed Load (HTTP + WebSocket)
  console.log('\n=== 📊 TEST 4: Mixed Load (HTTP + WebSocket) ===');
  const ws = new WebSocketManager(db);
  const wsConn = await ws.connect('ws://localhost:8094/ws', {}, 3000);
  const mixedStart = Date.now();
  await Promise.all([
    client.send({ url: '/api/users/1', method: 'GET' }),
    client.send({ url: '/api/login', method: 'POST', body: JSON.stringify({username:'admin', password:'secret'}), bodyType: 'json' }),
    ws.send(wsConn.connectionId, 'get-time'),
    client.send({ url: '/api/secure/data', method: 'GET', headers: { Authorization: 'Bearer mock-jwt-token-xyz' } }),
    ws.read(wsConn.connectionId, 10, 'time', 2000),
  ]);
  console.log(`  Mixed 5 ops (2 HTTP + 2 WS + wait): ${Date.now() - mixedStart}ms`);
  await ws.close(wsConn.connectionId);

  // TEST 5: SQLite Write Stress (each request writes to history)
  console.log('\n=== 📊 TEST 5: SQLite Write Stress ===');
  const writeCount = 30;
  const writeStart = Date.now();
  await Promise.all(Array.from({ length: writeCount }, (_, i) =>
    client.send({ url: '/api/users/1', method: 'GET' })
  ));
  console.log(`  ${writeCount} parallel writes: ${Date.now() - writeStart}ms`);

  // TEST 6: History Query Performance
  console.log('\n=== 📊 TEST 6: History Query Performance ===');
  const h1 = Date.now(); const hist = await db.listHistory({ limit: 50 });
  console.log(`  history_list(limit:50): ${Date.now() - h1}ms (${hist.length} rows)`);

  const h2 = Date.now(); const hist2 = await db.listHistory({ method: 'GET', limit: 50 });
  console.log(`  history_list(method:GET): ${Date.now() - h2}ms (${hist2.length} rows)`);

  const h3 = Date.now(); const hist3 = await db.listHistory({ urlKeyword: 'users', limit: 50 });
  console.log(`  history_list(keyword:users): ${Date.now() - h3}ms (${hist3.length} rows)`);

  // TEST 7: Memory
  console.log('\n=== 📊 TEST 7: Memory Usage ===');
  const mem = process.memoryUsage();
  console.log(`  RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)}/${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`);

  // TEST 8: Suite-like Chained Requests
  console.log('\n=== 📊 TEST 8: Chained Requests ===');
  const chainStart = Date.now();
  for (let i = 0; i < 15; i++) await client.send({ url: '/api/users/1', method: 'GET' });
  console.log(`  15 chained: ${Date.now() - chainStart}ms`);

  // TEST 9: Max Parallel Burst
  console.log('\n=== 📊 TEST 9: Max Parallel Burst ===');
  const burstCount = 50;
  const burstStart = Date.now();
  try { await Promise.all(Array.from({ length: burstCount }, () =>
    client.send({ url: '/api/users/1', method: 'GET', timeout: 5000 })
  )); } catch {}
  console.log(`  ${burstCount} parallel burst: ${Date.now() - burstStart}ms`);

  // Summary
  console.log('\n========================================');
  console.log('📊 STRESS TEST SUMMARY');
  console.log(`  Sequential:  ${(seqCount / seqMs * 1000).toFixed(0)} req/s`);
  console.log(`  Parallel:    ${(parCount / parMs * 1000).toFixed(0)} req/s (${parCount} concurrent)`);
  console.log(`  Burst:       ${burstCount} parallel`);
  console.log(`  Latency:     P50=${p50}ms P90=${p90}ms P99=${p99}ms Avg=${avg}ms`);
  console.log(`  Memory:      ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB heap`);
  console.log('========================================');

  await ws.cleanupAll();
  await db.close();
  await mock.stop();
  try { await fs.unlink(dbPath); } catch {}
}

stressTest().catch(e => { console.error('FAIL:', e); process.exit(1); });
