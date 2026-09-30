import http from 'node:http';
import dgram from 'node:dgram';

const KEY = process.env.STEAM_KEY;
const PORT = process.env.PORT || 3000;
const API = 'https://api.steampowered.com';

const SERVERS = [
  '45.235.98.222:27017', '45.235.98.222:27018', '45.235.98.222:27019', '45.235.98.222:27020',
  '45.235.98.222:27021', '45.235.98.222:27022', '45.235.98.222:27023', '45.235.98.222:27024',
  '152.233.19.133:28039', '152.233.19.133:28026',
  '169.150.198.105:26809', '169.150.198.105:26038',
  '169.150.198.105:26265', '169.150.198.99:26506', '169.150.198.99:26845',
  '45.235.98.246:27251'
];
const FRIENDS = ['76561199019042615', 'matias-c', '76561199019122494', '76561198451811119', '76561199012835217', '76561199151945480', '76561199790007682', '76561198791834306', '76561198892150618', 'Beltra420', '76561199064895508', '76561199161755956', '76561199067515979'];
const IPS = [...new Set(SERVERS.map(s => s.split(':')[0]))];

const H = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
const vanity = {};
const validIp = ip => ip && !ip.startsWith('0.0.0.0');
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const sameName = (inGame, steamName) => {
  const a = norm(inGame), b = norm(steamName);
  return a === b || (b.length >= 3 && a.includes(b));
};

// ---------- Lista de jugadores de un server (A2S_PLAYER por UDP) ----------
function a2sPlayers(addr, timeout = 1500) {
  const [host, port] = addr.split(':');
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    let finished = false;
    const done = v => {
      if (finished) return; finished = true;
      clearTimeout(t); try { sock.close(); } catch {}
      resolve(v);
    };
    const t = setTimeout(() => done(null), timeout);
    const send = ch => sock.send(Buffer.concat([Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0x55]), ch]), +port, host);
    sock.on('error', () => done(null));
    sock.on('message', msg => {
      if (msg.length < 6 || msg.readInt32LE(0) !== -1) return done(null);
      const type = msg[4];
      if (type === 0x41) return send(msg.subarray(5, 9)); // challenge
      if (type !== 0x44) return done(null);
      const n = msg[5]; let o = 6; const names = [];
      for (let i = 0; i < n && o < msg.length; i++) {
        o++; // index
        const end = msg.indexOf(0, o); if (end < 0) break;
        names.push(msg.toString('utf8', o, end));
        o = end + 1 + 8; // score + duration
      }
      done(names);
    });
    send(Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]));
  });
}

// ---------- Steam ----------
async function resolveId(id) {
  if (/^\d{17}$/.test(id)) return id;
  if (vanity[id]) return vanity[id];
  const r = await fetch(`${API}/ISteamUser/ResolveVanityURL/v1/?key=${KEY}&vanityurl=${encodeURIComponent(id)}`);
  const j = await r.json();
  return j.response?.success === 1 ? (vanity[id] = j.response.steamid) : null;
}

async function getServers() {
  const out = {};
  await Promise.all(IPS.map(async ip => {
    try {
      const f = encodeURIComponent(`\\appid\\730\\addr\\${ip}`);
      const r = await fetch(`${API}/IGameServersService/GetServerList/v1/?key=${KEY}&limit=200&filter=${f}`);
      const j = await r.json();
      for (const s of j.response?.servers || []) {
        const addr = `${ip}:${s.gameport}`;
        if (SERVERS.includes(addr)) out[addr] = { name: s.name, map: s.map, players: s.players, max: s.max_players };
      }
    } catch (e) { console.warn('Steam error', ip, e.message); }
  }));
  return out;
}

async function getFriends(servers) {
  const ids = (await Promise.all(FRIENDS.map(f => resolveId(f).catch(() => null)))).filter(Boolean);
  if (!ids.length) return [];
  const r = await fetch(`${API}/ISteamUser/GetPlayerSummaries/v2/?key=${KEY}&steamids=${ids.join(',')}`);
  const list = (await r.json()).response?.players || [];

  // Solo consultamos los servers si algun amigo esta en CS2 sin server conocido
  const rosters = {};
  if (list.some(p => p.gameid === '730' && !validIp(p.gameserverip))) {
    const targets = SERVERS.filter(a => servers[a] && servers[a].players > 0);
    const res = await Promise.all(targets.map(a => a2sPlayers(a)));
    targets.forEach((a, i) => { if (res[i]) rosters[a] = res[i]; });
  }

  return list.map(p => {
    let server = null;
    if (p.gameid === '730') {
      if (validIp(p.gameserverip)) server = p.gameserverip;
      else for (const [a, names] of Object.entries(rosters))
        if (names.some(n => sameName(n, p.personaname))) { server = a; break; }
    }
    return {
      id: p.steamid, name: p.personaname, avatar: p.avatarmedium, url: p.profileurl,
      state: p.personastate, game: p.gameextrainfo || null, inCS2: p.gameid === '730', server
    };
  });
}

// ---------- HTTP ----------
let cache = { t: 0, body: null }, pending = null;

async function build() {
  const servers = await getServers();
  const players = await getFriends(servers).catch(e => { console.error(e); return []; });
  return JSON.stringify({ updated: Date.now(), servers, players });
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, H); return res.end(); }
  if (!KEY) { res.writeHead(500, H); return res.end('{"error":"Falta STEAM_KEY"}'); }
  try {
    if (!cache.body || Date.now() - cache.t > 8000) {
      pending ??= build().then(b => { cache = { t: Date.now(), body: b }; }).finally(() => { pending = null; });
      await pending;
    }
    res.writeHead(200, H); res.end(cache.body);
  } catch (e) {
    res.writeHead(500, H); res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => console.log('API lista en puerto', PORT));
