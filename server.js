const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const WebSocketServer = WebSocket.Server;

const HOST = process.env.HOST || '::';
const PORT = Number(process.env.PORT || 3000);
const FILE = path.join(__dirname, 'index.html');
const WEB3_LIB = path.join(__dirname, 'node_modules/@solana/web3.js/lib/index.iife.min.js');

const waiting = [];
const rooms = new Map();
const clients = new Set();
const pollingClients = new Map();

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

// Proxies JSON-RPC calls to Solana Testnet/Devnet to bypass browser CORS/rate-limits
function handleRpcProxy(req, res, url) {
  const cluster = url.searchParams.get('cluster') || 'testnet';
  const targetHost = cluster === 'devnet' ? 'api.devnet.solana.com' : 'api.testnet.solana.com';

  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 100000) req.destroy();
  });
  req.on('end', () => {
    const proxyReq = https.request({
      hostname: targetHost,
      port: 443,
      path: '/',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'user-agent': 'blockduel-tetris/1.0',
      },
      timeout: 10000,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      sendJson(res, { error: 'RPC proxy request failed', details: err.message }, 502);
    });

    proxyReq.write(body);
    proxyReq.end();
  });
}

function createPollingClient() {
  const id = randomUUID();
  const messages = [];
  const handlers = {};
  const client = {
    id,
    room: null,
    role: -1,
    readyState: WebSocket.OPEN,
    send(raw) { messages.push(JSON.parse(raw)); },
    on(event, handler) { handlers[event] = handler; },
    emit(event, value) { if (handlers[event]) handlers[event](value); },
    messages,
  };
  pollingClients.set(id, client);
  attachClient(client);
  return client;
}

function closePollingClient(id) {
  const client = pollingClients.get(id);
  if (!client) return;
  pollingClients.delete(id);
  client.readyState = WebSocket.CLOSED;
  client.emit('close');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  if (req.method === 'GET' && (url.pathname === '/solanaWeb3.js' || url.pathname === '/solana-web3.js')) {
    if (fs.existsSync(WEB3_LIB)) {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=86400',
      });
      return fs.createReadStream(WEB3_LIB).pipe(res);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/solana-rpc') {
    return handleRpcProxy(req, res, url);
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, { status: 'ok', clients: clients.size, waiting: waiting.length, matches: rooms.size });
  }

  if (req.method === 'POST' && url.pathname === '/api/connect') {
    const client = createPollingClient();
    return sendJson(res, { clientId: client.id });
  }

  if (req.method === 'GET' && url.pathname === '/api/poll') {
    const client = pollingClients.get(url.searchParams.get('id'));
    if (!client) return sendJson(res, { error: 'Connection expired. Reconnect.' }, 404);
    return sendJson(res, { messages: client.messages.splice(0) });
  }

  if (req.method === 'POST' && url.pathname === '/api/send') {
    const client = pollingClients.get(url.searchParams.get('id'));
    if (!client) return sendJson(res, { error: 'Connection expired. Reconnect.' }, 404);
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const message = JSON.parse(body);
        client.emit('message', JSON.stringify(message));
        sendJson(res, { ok: true });
      } catch {
        sendJson(res, { error: 'Invalid message.' }, 400);
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/disconnect') {
    closePollingClient(url.searchParams.get('id'));
    res.writeHead(204, { 'cache-control': 'no-store' });
    return res.end();
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
    });
    fs.createReadStream(FILE).pipe(res);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });
const W = 10, H = 20;
const SHAPES = [
  [[1,1,1,1]], [[1,1],[1,1]], [[0,1,0],[1,1,1]],
  [[1,0,0],[1,1,1]], [[0,0,1],[1,1,1]],
  [[0,1,1],[1,1,0]], [[1,1,0],[0,1,1]],
];
const COLORS = ['#49dff0','#ffd34f','#a776ff','#4b83ff','#ff9f43','#5cdda4','#ff668c'];

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function piece() {
  const i = Math.floor(Math.random() * SHAPES.length);
  return { shape: SHAPES[i].map(row => row.slice()), color: COLORS[i] };
}
function board() {
  const b = { grid: Array.from({length:H}, () => Array(W).fill(null)), piece:null, x:0, y:0, score:0, lines:0, level:1, lastDrop:Date.now(), soft:false, over:false };
  spawn(b);
  return b;
}
function collides(b, x, y, shape) {
  for (let py=0; py<shape.length; py++) for (let px=0; px<shape[py].length; px++) if (shape[py][px]) {
    const gx=x+px, gy=y+py;
    if (gx<0 || gx>=W || gy>=H || (gy>=0 && b.grid[gy][gx])) return true;
  }
  return false;
}
function spawn(b) {
  b.piece = piece(); b.x = 4; b.y = 0;
  if (collides(b,b.x,b.y,b.piece.shape)) b.over = true;
}
function clearLines(b) {
  let count=0;
  for (let y=H-1; y>=0; y--) if (b.grid[y].every(Boolean)) { b.grid.splice(y,1); b.grid.unshift(Array(W).fill(null)); count++; y++; }
  if (count) { b.lines += count; b.score += [0,100,300,500,800][count] * b.level; b.level = 1 + Math.floor(b.lines/10); }
}
function lock(b) {
  for (let py=0; py<b.piece.shape.length; py++) for (let px=0; px<b.piece.shape[py].length; px++) if (b.piece.shape[py][px]) {
    const gy=b.y+py;
    if (gy<0) { b.over=true; return; }
    b.grid[gy][b.x+px]=b.piece.color;
  }
  clearLines(b); spawn(b); b.lastDrop=Date.now();
}
function move(b,dx,dy) {
  if (!collides(b,b.x+dx,b.y+dy,b.piece.shape)) { b.x+=dx; b.y+=dy; return true; }
  if (dy>0) lock(b);
  return false;
}
function rotate(b) {
  const a=b.piece.shape, r=a[0].map((_,i)=>a.map(row=>row[i]).reverse());
  for (const kick of [0,-1,1,-2,2]) if (!collides(b,b.x+kick,b.y,r)) { b.x+=kick; b.piece.shape=r; return; }
}
function snapshot(room) {
  return { type:'state', roomId:room.id, players:room.players.map(p=>({
    name:p.name, grid:p.board.grid, piece:p.board.piece, x:p.board.x, y:p.board.y,
    score:p.board.score, lines:p.board.lines, level:p.board.level,
  })) };
}
function broadcast(room, data=snapshot(room)) { room.players.forEach(p=>send(p.ws,data)); }
function finish(room, winnerIndex, reason) {
  if (!room || room.ended) return;
  room.ended=true; clearInterval(room.timer); rooms.delete(room.id);
  const winner=room.players[winnerIndex];
  room.players.forEach(p=>send(p.ws,{type:'ended',winner:winner ? winner.name : null,winnerIndex,reason,final:snapshot(room)}));
}
function removeWaiting(ws) { const i=waiting.findIndex(p=>p.ws===ws); if(i>=0) waiting.splice(i,1); }
function joinQueue(ws, name) {
  if (ws.room && !ws.room.ended) return send(ws,{type:'error',message:'You are already in a match.'});
  removeWaiting(ws); ws.room=null;
  const opponent=waiting.findIndex(p=>p.ws.readyState===WebSocket.OPEN);
  if (opponent<0) { waiting.push({ws,name}); send(ws,{type:'queued',message:'Searching for an opponent...'}); return; }
  const first=waiting.splice(opponent,1)[0];
  const room={id:randomUUID(),ended:false,players:[{ws:first.ws,name:first.name,board:board()},{ws,name,board:board()}],lastSent:0,timer:null};
  room.players.forEach((p,i)=>{p.ws.room=room;p.ws.role=i;});
  rooms.set(room.id,room);
  room.players.forEach((p,i)=>send(p.ws,{type:'paired',roomId:room.id,role:i,opponent:room.players[1-i].name}));
  broadcast(room);
  room.timer=setInterval(()=>{
    const now=Date.now();
    for(let i=0;i<2;i++) {
      const b=room.players[i].board;
      if(b.over) { finish(room,1-i,'topout'); return; }
      const interval=b.soft?70:Math.max(110,850-(b.level-1)*65);
      if(now-b.lastDrop>=interval) { move(b,0,1); b.lastDrop=now; if(b.over) {finish(room,1-i,'topout');return;} }
    }
    if(now-room.lastSent>=80) { room.lastSent=now; broadcast(room); }
  },35);
}
function attachClient(ws) {
  clients.add(ws);
  ws.room=null; ws.role=-1; send(ws,{type:'connected'});
  ws.on('message', raw => {
    let msg; try { msg=JSON.parse(raw.toString()); } catch { return send(ws,{type:'error',message:'Invalid message.'}); }
    if(msg.type==='queue') return joinQueue(ws,String(msg.name||'Player').trim().slice(0,16)||'Player');
    if(msg.type==='cancel_queue') { removeWaiting(ws); return send(ws,{type:'cancelled'}); }
    const room=ws.room;
    if(!room || room.ended || ws.role<0) return;
    if(msg.type==='quit') return finish(room,1-ws.role,'forfeit');
    const b=room.players[ws.role].board;
    if(b.over || msg.type!=='input') return;
    switch(msg.action) {
      case 'left': move(b,-1,0); break;
      case 'right': move(b,1,0); break;
      case 'soft': b.soft=true; move(b,0,1); b.score++; break;
      case 'soft_off': b.soft=false; break;
      case 'rotate': rotate(b); break;
      case 'drop': while(!collides(b,b.x,b.y+1,b.piece.shape)){b.y++;b.score+=2;} lock(b); break;
      default: return;
    }
    if(b.over) finish(room,1-ws.role,'topout');
    else broadcast(room);
  });
  ws.on('close',()=>{
    clients.delete(ws);
    removeWaiting(ws);
    if(ws.room && !ws.room.ended) finish(ws.room,1-ws.role,'disconnect');
  });
}
wss.on('connection', attachClient);
server.listen(PORT,HOST,()=>console.log('BLOCK DUEL server listening on port '+PORT));