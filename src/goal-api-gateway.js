// Native Desktop's WebSocket transport and guarded Goal API share one backend
// connection. This does not wrap/replace Desktop's CLI executable.
import http from 'node:http';
import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { createOwnerProxy } from './goal-owner-proxy.js';

const MAX_MESSAGE = 16 * 1024 * 1024;

export async function createGoalApiGateway({ backendUrl, token, desktopPipe, goalPipe, onUnused = () => {} }) {
  if (!/^ws:\/\/127\.0\.0\.1:\d+(?:\/rpc)?$/.test(backendUrl) || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('Goal gateway requires an authenticated loopback backend');
  }
  if (![desktopPipe, goalPipe].every(path => /^\\\\\.\\pipe\\unsnooze-[a-z0-9-]+$/i.test(path))) {
    throw new Error('Goal gateway requires private Windows named pipes');
  }
  const websocket = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
  const httpServer = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  let owner = null, stopped = false;
  const sockets = new Set();
  httpServer.on('upgrade', (request, socket, head) => {
    if (stopped || owner || request.url !== '/rpc' || request.headers.origin || request.headers.authorization) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    websocket.handleUpgrade(request, socket, head, frontend => {
      const backend = new WebSocket(backendUrl, { headers: { Authorization: `Bearer ${token}` },
        perMessageDeflate: false, maxPayload: MAX_MESSAGE, handshakeTimeout: 10_000 });
      const pending = []; let buffered = 0, closed = false;
      const proxy = createOwnerProxy({
        writeBackend: line => {
          if (backend.readyState !== WebSocket.OPEN) throw new Error('Backend connection is not ready');
          backend.send(line.trimEnd());
        },
        writeDesktop: line => { if (frontend.readyState === WebSocket.OPEN) frontend.send(line.trimEnd()); },
      });
      const connection = { proxy, frontend, backend, get ready() { return proxy.ready; } };
      owner = connection;
      const finish = () => {
        if (closed) return; closed = true;
        proxy.close(); frontend.terminate(); backend.terminate();
        if (owner === connection) owner = null;
        if (!stopped) onUnused();
      };
      backend.once('open', () => {
        for (const message of pending) proxy.fromDesktop(message);
        pending.length = 0; buffered = 0;
      });
      frontend.on('message', (data, binary) => {
        if (binary) { finish(); return; }
        const message = data.toString();
        try {
          JSON.parse(message);
          if (backend.readyState === WebSocket.OPEN) proxy.fromDesktop(message);
          else {
            buffered += data.length;
            if (buffered > MAX_MESSAGE || pending.length >= 1024) { finish(); return; }
            pending.push(message);
          }
        } catch { finish(); }
      });
      backend.on('message', (data, binary) => {
        if (binary) { finish(); return; }
        try { proxy.fromBackend(data.toString()); } catch { finish(); }
      });
      frontend.on('error', finish); backend.on('error', finish);
      frontend.on('close', finish); backend.on('close', finish);
    });
  });
  const goalServer = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(45_000, () => socket.destroy());
    let buffer = Buffer.alloc(0), handled = false;
    socket.on('data', async chunk => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (!length || length > 8192) { handled = true; socket.destroy(); return; }
      if (buffer.length < length + 4) return;
      handled = true;
      let id = null, response;
      try {
        const request = JSON.parse(buffer.subarray(4, length + 4).toString()); id = request.id;
        if (request.jsonrpc !== '2.0') throw new Error('Invalid Goal gateway request');
        let result;
        if (request.method === 'service/status') result = { protocol: 1, connected: !!owner, ready: !!owner?.ready };
        else {
          const current = owner;
          if (!current?.ready) throw new Error('Native Desktop is not connected and initialized');
          result = await current.proxy.handle(request.method, request.params);
          if (owner !== current) throw new Error('Desktop owner changed during the request');
        }
        response = { id, jsonrpc: '2.0', result };
      } catch (error) { response = { id, jsonrpc: '2.0', error: { code: -32000, message: error.message } }; }
      const body = Buffer.from(JSON.stringify(response)), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      if (!socket.destroyed) socket.end(Buffer.concat([header, body]));
    });
  });
  const listen = (server, path) => new Promise((resolve, reject) => {
    server.once('error', reject); server.listen({ path, readableAll: false, writableAll: false }, resolve);
  });
  try { await listen(httpServer, desktopPipe); await listen(goalServer, goalPipe); }
  catch (error) { httpServer.close(); goalServer.close(); throw error; }
  return {
    // Preserve the backslashes: URL normalization removes an all-slash /./ segment.
    desktopUrl: 'ws+unix:////.\\pipe\\' + desktopPipe.slice('\\\\.\\pipe\\'.length) + ':/rpc',
    status: () => ({ connected: !!owner, ready: !!owner?.ready }),
    async close() {
      stopped = true;
      owner?.proxy.close(); owner?.frontend.terminate(); owner?.backend.terminate(); owner = null;
      for (const socket of sockets) socket.destroy();
      await Promise.all([httpServer, goalServer, websocket].map(server => new Promise(resolve => server.close(resolve))));
    },
  };
}
