/**
 * PTT Signaling Server
 * Minimal WebSocket server — ΜΟΝΟ για WebRTC handshake
 * Ο ήχος ΔΕΝ περνά από εδώ (peer-to-peer απευθείας)
 */

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Health check για Render.com
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('PTT Server OK');
});

const wss = new WebSocketServer({ server });

// rooms: Map<roomId, Map<clientId, ws>>
const rooms = new Map();
let nextId = 1;

wss.on('connection', (ws) => {
  const id = String(nextId++);
  let roomId = null;

  const send = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  const broadcast = (obj, exceptSelf = true) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.forEach((client, cid) => {
      if (exceptSelf && cid === id) return;
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj));
    });
  };

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {

      case 'join': {
        roomId = String(msg.room || 'default').slice(0, 64);

        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        rooms.get(roomId).set(id, ws);

        const peers = rooms.get(roomId).size;

        send({ type: 'joined', id, peers });
        broadcast({ type: 'peer_joined', peers });
        break;
      }

      // WebRTC signaling — απλή αναμετάδοση
      case 'offer':
      case 'answer':
      case 'ice':
        broadcast(msg);
        break;

      // PTT state — αναμετάδοση σε όλους
      case 'ptt':
        broadcast({ type: 'ptt', active: !!msg.active, from: id });
        break;
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.delete(id);
    const peers = room.size;
    if (peers === 0) {
      rooms.delete(roomId);
    } else {
      broadcast({ type: 'peer_left', peers });
    }
  });

  ws.on('error', () => {});

  // Keep-alive ping
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(ping);
  }, 25000);
});

server.listen(PORT, () => {
  console.log(`PTT server running on port ${PORT}`);
});
