const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const WebSocketServer = WebSocket.Server;
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } = require('@solana/web3.js');

function loadLocalEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    process.env[match[1]] = value;
  }
}

loadLocalEnv();

const HOST = process.env.HOST || '::';
const PORT = Number(process.env.PORT || 3000);
const FILE = path.join(__dirname, 'index.html');
const WEB3_LIB = path.join(__dirname, 'node_modules/@solana/web3.js/lib/index.iife.min.js');
const FEE_PAYER_FILE = process.env.SERVER_FEE_PAYER_KEYPAIR || path.join(__dirname, 'server-fee-payer.json');
const BET_PROGRAM_ID = 'CGU9v9Zt1PJECyZDcXVJpgzjukxy2ejAXbN1bUbGE8tq';
const SETTLE_DISCRIMINATOR = Buffer.from('6eeabd6067c3a114', 'hex');
const MATCH_DISCRIMINATOR = Buffer.from('5908b5bdb30eb1f8', 'hex');
const DEVNET = process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const TESTNET = process.env.SOLANA_TESTNET_RPC_URL || 'https://api.testnet.solana.com';
const feePayer = loadFeePayer();
const feeConnection = new Connection(DEVNET, 'confirmed');
const sponsoredRequests = new Map();
const settlingMatches = new Map();
let feeBalanceCache = null;
let feeBalanceCacheExpiresAt = 0;

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

function loadFeePayer() {
  try {
    const secret = JSON.parse(fs.readFileSync(FEE_PAYER_FILE, 'utf8'));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not load server fee payer keypair: ${error.message}`);
    const keypair = Keypair.generate();
    fs.writeFileSync(FEE_PAYER_FILE, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600, flag: 'wx' });
    console.log(`Generated Devnet fee sponsor: ${keypair.publicKey.toBase58()}`);
    console.log(`Fund it with Devnet SOL to sponsor settlement transaction fees. Key file: ${FEE_PAYER_FILE}`);
    return keypair;
  }
}

async function feeSponsorStatus(req, res) {
  try {
    if (feeBalanceCacheExpiresAt < Date.now()) {
      const rpcResponse = await fetch(DEVNET, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getBalance',
          params: [feePayer.publicKey.toBase58(), { commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(8000),
      });
      const rpcResult = await rpcResponse.json();
      if (!rpcResponse.ok || rpcResult.error) throw new Error(rpcResult.error?.message || `Devnet RPC returned HTTP ${rpcResponse.status}`);
      feeBalanceCache = rpcResult.result.value;
      feeBalanceCacheExpiresAt = Date.now() + 30000;
    }
    return sendJson(res, {
      address: feePayer.publicKey.toBase58(),
      balanceLamports: feeBalanceCache,
    });
  } catch (error) {
    feeBalanceCacheExpiresAt = Date.now() + 60000;
    console.warn(`Devnet fee sponsor balance unavailable: ${error.message}`);
    return sendJson(res, {
      address: feePayer.publicKey.toBase58(),
      balanceLamports: null,
      balanceError: 'Devnet RPC is rate-limited or temporarily unavailable.',
    });
  }
}

function allowSponsoredRequest(req) {
  const now = Date.now();
  const ip = req.socket.remoteAddress || 'unknown';
  const entries = (sponsoredRequests.get(ip) || []).filter(time => now - time < 60000);
  if (entries.length >= 10) return false;
  entries.push(now);
  sponsoredRequests.set(ip, entries);
  return true;
}

function isSameOriginRequest(req) {
  try {
    const origin = new URL(req.headers.origin || '');
    return origin.host === req.headers.host;
  } catch {
    return false;
  }
}

async function settleFromServer(matchIdText, winnerText) {
  const matchId = new PublicKey(matchIdText);
  const winner = new PublicKey(winnerText);
  const [matchState] = PublicKey.findProgramAddressSync([Buffer.from('sol_match'), matchId.toBuffer()], new PublicKey(BET_PROGRAM_ID));
  const [escrow] = PublicKey.findProgramAddressSync([Buffer.from('sol_escrow'), matchId.toBuffer()], new PublicKey(BET_PROGRAM_ID));
  const account = await feeConnection.getAccountInfo(matchState, 'confirmed');
  if (!account || !account.owner.equals(new PublicKey(BET_PROGRAM_ID))) throw new Error('No Games Hub wager found for this match ID.');
  const data = account.data;
  if (data.length < 187 || !data.subarray(0, 8).equals(MATCH_DISCRIMINATOR)) throw new Error('The on-chain match account has an invalid layout.');
  const readKey = offset => new PublicKey(data.subarray(offset, offset + 32));
  const onChainMatchId = readKey(8);
  const playerOne = readKey(40);
  const playerTwo = readKey(72);
  const referee = readKey(104);
  if (!onChainMatchId.equals(matchId)) throw new Error('Match ID does not match the on-chain account.');
  if (!referee.equals(feePayer.publicKey)) throw new Error('This match was created with a different referee; the site sponsor cannot settle it.');
  if (data[184] !== 1) throw new Error('This match is not active or has already been settled.');
  if (!winner.equals(playerOne) && !winner.equals(playerTwo)) throw new Error('Winner must be one of the two on-chain players.');

  const instruction = new TransactionInstruction({
    programId: new PublicKey(BET_PROGRAM_ID),
    keys: [
      { pubkey: matchState, isSigner: false, isWritable: true },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: winner, isSigner: false, isWritable: true },
      { pubkey: playerOne, isSigner: false, isWritable: true },
      { pubkey: feePayer.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([SETTLE_DISCRIMINATOR, winner.toBuffer()]),
  });
  const latest = await feeConnection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(instruction);
  transaction.sign(feePayer);
  const signature = await feeConnection.sendRawTransaction(transaction.serialize(), { preflightCommitment: 'confirmed', maxRetries: 3 });
  const confirmation = await feeConnection.confirmTransaction({ signature, ...latest }, 'confirmed');
  if (confirmation.value.err) throw new Error(`Settlement failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  return signature;
}

function sponsorSettlement(req, res) {
  if (!isSameOriginRequest(req)) return sendJson(res, { error: 'Settlement requests must come from this site.' }, 403);
  if (!allowSponsoredRequest(req)) return sendJson(res, { error: 'Settlement rate limit reached. Try again in a minute.' }, 429);
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 20000) req.destroy();
  });
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      if (typeof payload.matchId !== 'string' || typeof payload.winnerAddress !== 'string') {
        return sendJson(res, { error: 'A match ID and winner address are required.' }, 400);
      }
      const matchId = new PublicKey(payload.matchId).toBase58();
      if (settlingMatches.has(matchId)) {
        const signature = await settlingMatches.get(matchId);
        return sendJson(res, { signature });
      }
      const settlement = settleFromServer(matchId, payload.winnerAddress);
      settlingMatches.set(matchId, settlement);
      try {
        const signature = await settlement;
        sendJson(res, { signature });
      } finally {
        settlingMatches.delete(matchId);
      }
    } catch (error) {
      sendJson(res, { error: error.message || 'Could not sponsor settlement.' }, 400);
    }
  });
}

// Proxies JSON-RPC calls to Solana Testnet/Devnet to bypass browser CORS/rate-limits
function handleRpcProxy(req, res, url) {
  const cluster = url.searchParams.get('cluster') || 'testnet';
  if (cluster !== 'devnet' && cluster !== 'testnet') return sendJson(res, { error: 'Unsupported RPC cluster.' }, 400);
  const target = new URL(cluster === 'devnet' ? DEVNET : TESTNET);
  if (target.protocol !== 'https:') return sendJson(res, { error: 'RPC endpoint must use HTTPS.' }, 500);

  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 100000) req.destroy();
  });
  req.on('end', () => {
    const proxyReq = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
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

  if (req.method === 'GET' && url.pathname === '/api/fee-sponsor') return feeSponsorStatus(req, res);
  if (req.method === 'POST' && url.pathname === '/api/fee-sponsor/settle') return sponsorSettlement(req, res);

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
