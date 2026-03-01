/**
 * PTT Signaling Server
 * Αυστηρά 2 συσκευές ανά room — αν είναι γεμάτο, η 3η περιμένει
 */

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = 2; // Αλλάξτο σε 4 αν θέλετε group call

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('PTT Server OK');
});

const wss = new WebSocketServer({ server });

// rooms: Map<roomId, { active: Map<id,ws>, queue: Map<id,ws> }>
const rooms = new Map();
let nextId = 1;

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { active: new Map(), queue: new Map() });
  }
  return rooms.get(roomId);
}

function cleanRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.active.size === 0 && room.queue.size === 0) {
    rooms.delete(roomId);
  }
}

function broadcastActive(roomId, obj, exceptId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.active.forEach((ws, cid) => {
    if (cid === exceptId) return;
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  });
}

function sendTo(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  let roomId = null;
  let inQueue = false;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {

      case 'join': {
        roomId = String(msg.room || 'default').slice(0, 64);
        const room = getRoom(roomId);

        if (room.active.size < MAX_PER_ROOM) {
          // Μπαίνει κανονικά
          room.active.set(id, ws);
          inQueue = false;
          const peers = room.active.size;
          sendTo(ws, { type: 'joined', id, peers, status: 'active' });
          broadcastActive(roomId, { type: 'peer_joined', peers }, id);
          console.log(`[+] Room "${roomId}": ${peers} active`);
        } else {
          // Το room είναι γεμάτο — βάλε σε αναμονή
          room.queue.set(id, ws);
          inQueue = true;
          sendTo(ws, {
            type: 'joined',
            id,
            peers: room.active.size,
            status: 'waiting',         // Ενημέρωσε τον client ότι περιμένει
            queuePos: room.queue.size
          });
          console.log(`[~] Room "${roomId}": ${id} in queue (${room.queue.size} waiting)`);
        }
        break;
      }

      // WebRTC signaling — μόνο μεταξύ active (όχι queue)
      case 'offer':
      case 'answer':
      case 'ice':
        if (!inQueue) broadcastActive(roomId, msg, id);
        break;

      // PTT — μόνο active
      case 'ptt':
        if (!inQueue) broadcastActive(roomId, { type: 'ptt', active: !!msg.active, from: id }, id);
        break;

      case 'ping':
        sendTo(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (inQueue) {
      // Απλά φύγε από queue
      room.queue.delete(id);
      console.log(`[-] Room "${roomId}": ${id} left queue`);
    } else {
      // Έφυγε ένας active
      room.active.delete(id);
      const remaining = room.active.size;
      console.log(`[-] Room "${roomId}": ${remaining} active left`);

      // Ειδοποίησε τους υπόλοιπους active
      broadcastActive(roomId, { type: 'peer_left', peers: remaining });

      // Αν υπάρχει κάποιος στη queue, βάλτον μέσα τώρα
      if (room.queue.size > 0 && remaining < MAX_PER_ROOM) {
        const [nextQueueId, nextWs] = room.queue.entries().next().value;
        room.queue.delete(nextQueueId);
        room.active.set(nextQueueId, nextWs);

        const newPeers = room.active.size;
        // Ενημέρωσε αυτόν που μπήκε
        sendTo(nextWs, { type: 'joined', id: nextQueueId, peers: newPeers, status: 'active' });
        // Ενημέρωσε τους υπόλοιπους active
        broadcastActive(roomId, { type: 'peer_joined', peers: newPeers }, nextQueueId);
        console.log(`[→] Room "${roomId}": ${nextQueueId} promoted from queue`);
      }
    }

    cleanRoom(roomId);
  });

  ws.on('error', () => {});

  // Keep-alive
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(ping);
  }, 25000);
});

server.listen(PORT, () => {
  console.log(`PTT server running on port ${PORT}`);
  console.log(`Max per room: ${MAX_PER_ROOM}`);
});
