import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

export class MockServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private port: number;

  constructor(port = 8080) {
    this.port = port;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.setupWebSocket();
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const method = req.method;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'GET' && url.pathname === '/api/users/1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1, name: 'Alice', role: 'admin' }));
      return;
    }

    if (method === 'POST' && url.pathname === '/api/login') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          let parsed: any = {};
          if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
            const params = new URLSearchParams(body);
            parsed = Object.fromEntries(params.entries());
          } else {
            parsed = JSON.parse(body);
          }

          if (parsed.username === 'admin' && parsed.password === 'secret') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token: 'mock-jwt-token-xyz', expires_in: 3600 }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid credentials' }));
          }
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Malformed body: ' + err.message }));
        }
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/secure/data') {
      const auth = req.headers['authorization'];
      if (auth === 'Bearer mock-jwt-token-xyz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: 'sensitive-secret', status: 'authorized' }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
      return;
    }

    // Default 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  private setupWebSocket() {
    this.server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
      if (pathname === '/ws') {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (message) => {
        const msgStr = message.toString('utf8');
        if (msgStr === 'get-time') {
          ws.send(JSON.stringify({ time: new Date().toISOString() }));
        } else {
          ws.send(`echo: ${msgStr}`);
        }
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`Mock server running at http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((err1) => {
        this.server.close((err2) => {
          if (err1 || err2) reject(err1 || err2);
          else resolve();
        });
      });
    });
  }
}
