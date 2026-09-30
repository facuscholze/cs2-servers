import { writeFile } from 'node:fs/promises';

const KEY = process.env.STEAM_KEY;
if (!KEY) { console.error('Falta STEAM_KEY'); process.exit(1); }

const IPS = ['45.235.98.222', '152.233.19.133', '169.150.198.105', '169.150.198.99', '45.235.98.246'];
const servers = {};

for (const ip of IPS) {
  try {
    const filter = encodeURIComponent(`\\appid\\730\\addr\\${ip}`);
    const r = await fetch(`https://api.steampowered.com/IGameServersService/GetServerList/v1/?key=${KEY}&limit=100&filter=${filter}`);
    const j = await r.json();
    for (const s of j.response?.servers || []) {
      servers[`${ip}:${s.gameport}`] = {
        name: s.name, map: s.map,
        players: s.players,
        max: s.max_players, bots: 0
      };
    }
  } catch (e) { console.warn('Error con', ip, e.message); }
}

await writeFile('public/servers.json', JSON.stringify({ updated: Date.now(), servers }));
console.log(`OK: ${Object.keys(servers).length} servers`);