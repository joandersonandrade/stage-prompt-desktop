import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { networkInterfaces } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, createReadStream, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";
import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 8787);
const securePort = Number(process.env.HTTPS_PORT || 8788);
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
// Quando empacotado (Electron/instalador), a pasta do app pode ser somente leitura
// (dentro do .app no Mac, ou Program Files no Windows). Nesse caso, o processo que
// importa este módulo define STAGE_HUB_DATA_DIR (uma pasta de dados do usuário,
// sempre gravável) antes do import. Fora do empacotamento, mantém o comportamento
// original (grava ao lado do próprio server.mjs).
const storePath = process.env.STAGE_HUB_DATA_DIR
  ? new URL("stage-hub-state.json", `file://${process.env.STAGE_HUB_DATA_DIR.replace(/\/?$/, "/")}`)
  : new URL("./stage-hub-state.json", import.meta.url);

/** Último estado de cada sala (tela) + histórico de recados da equipe. */
let state = {};
let crew = {};
let rooms = {};
try {
  const saved = JSON.parse(await readFile(storePath, "utf8"));
  state = saved.state ?? saved ?? {};
  crew = saved.crew ?? {};
  rooms = saved.rooms ?? {};
} catch {
  state = {};
  crew = {};
}

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await writeFile(storePath, JSON.stringify({ state, crew, rooms }, null, 2));
    } catch {
      /* disco cheio / somente leitura: seguir em memória */
    }
  }, 400);
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function handleRequest(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/api/room" && request.method === "GET") {
    const requested = String(url.searchParams.get("sala") ?? "").trim().toUpperCase();
    const room = rooms[requested] ? requested : Object.keys(rooms).find((code) => rooms[code]?.teamPin === requested) ?? "";
    const admin = String(url.searchParams.get("admin") ?? "").trim().toUpperCase();
    response.setHeader("Content-Type", mime[".json"]);
    if (!room || !rooms[room]) {
      response.statusCode = 404;
      response.end(JSON.stringify({ ok: false }));
      return;
    }
    response.end(JSON.stringify({ ok: true, room, teamPin: rooms[room].teamPin, authorized: Boolean(admin && rooms[room].adminCode === admin) }));
    return;
  }
  if (url.pathname === "/api/room" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 8_192) request.destroy(); });
    request.on("end", () => {
      response.setHeader("Content-Type", mime[".json"]);
      try {
        const input = JSON.parse(body || "{}");
        const room = String(input.room ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
        const adminCode = String(input.adminCode ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
        const currentCode = String(input.currentCode ?? "").trim().toUpperCase();
        if (room.length < 3 || adminCode.length < 6) throw new Error("invalid");
        if (rooms[room] && rooms[room].adminCode !== currentCode) {
          response.statusCode = 403;
          response.end(JSON.stringify({ ok: false, error: "Código administrativo incorreto." }));
          return;
        }
        const usedPins = new Set(Object.values(rooms).map((entry) => entry.teamPin));
        let teamPin = rooms[room]?.teamPin;
        while (!teamPin || usedPins.has(teamPin) && rooms[room]?.teamPin !== teamPin) teamPin = String(Math.floor(100000 + Math.random() * 900000));
        rooms[room] = { adminCode, teamPin, createdAt: rooms[room]?.createdAt ?? Date.now() };
        persist();
        response.end(JSON.stringify({ ok: true, room, adminCode, teamPin }));
      } catch {
        response.statusCode = 400;
        response.end(JSON.stringify({ ok: false, error: "Dados inválidos." }));
      }
    });
    return;
  }
  if (url.pathname === "/api/hosts") {
    // Detecta automaticamente os IPs desta máquina na rede local do evento.
    const addresses = Object.values(networkInterfaces())
      .flat()
      .filter((entry) => entry?.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);
    response.setHeader("Content-Type", mime[".json"]);
    response.end(JSON.stringify({ ok: true, port, hosts: addresses, urls: addresses.map((ip) => `http://${ip}:${port}`), securePort, secureUrls: addresses.map((ip) => `https://${ip}:${securePort}`) }));
    return;
  }
  if (url.pathname === "/status") {
    response.setHeader("Content-Type", mime[".json"]);
    response.end(JSON.stringify({ ok: true, service: "Stage Prompt Local Hub", port, rooms: Object.keys(state) }));
    return;
  }
  let path = decodeURIComponent(url.pathname);
  if (path === "/") path = "/index.html";
  if (!extname(path)) path += ".html";
  const file = join(publicDir, normalize(path).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(publicDir) || !existsSync(file) || !statSync(file).isFile()) {
    response.statusCode = 404;
    response.setHeader("Content-Type", mime[".html"]);
    response.end("<h1>404</h1><p><a href=\"/\">Voltar ao início</a></p>");
    return;
  }
  response.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
  response.setHeader("Cache-Control", "no-cache");
  createReadStream(file).pipe(response);
}

const server = createServer(handleRequest);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
});

// HTTPS local (certificado próprio): navegadores só liberam microfone/câmera em https.
let secureServer = null;
try {
  const key = await readFile(new URL("./certs/key.pem", import.meta.url));
  const cert = await readFile(new URL("./certs/cert.pem", import.meta.url));
  secureServer = createSecureServer({ key, cert }, handleRequest);
  secureServer.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
} catch {
  secureServer = null;
}

function send(socket, data) {
  if (socket.readyState === 1) socket.send(JSON.stringify(data));
}

function timestamp(value, fallback) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeScreenEnvelope(envelope, advanceToNow = false) {
  const now = Date.now();
  const copy = structuredClone(envelope);
  const payload = copy.payload ?? (copy.payload = {});
  const timer = payload.timer;
  if (timer?.running && timer.startedAt) {
    const sentAt = timestamp(copy.sentAt, now);
    const startedAt = timestamp(timer.startedAt, sentAt);
    const delta = Math.max(0, (advanceToNow ? now : sentAt) - startedAt);
    if (typeof timer.accumulatedMs === "number" || typeof timer.startedAt === "string") {
      timer.accumulatedMs = Number(timer.accumulatedMs || 0) + delta;
      timer.startedAt = new Date(now).toISOString();
    } else {
      timer.elapsedMs = Number(timer.elapsedMs || 0) + delta;
      timer.startedAt = now;
    }
  }
  payload.appearance ??= {};
  if (timer?.color && !payload.appearance.color) payload.appearance.color = timer.color;
  if (payload.appearance.color && timer && !timer.color) timer.color = payload.appearance.color;
  if (payload.background && !payload.appearance.background) payload.appearance.background = payload.background;
  if (payload.appearance.background && !payload.background) payload.background = payload.appearance.background;
  if (payload.alert?.id) {
    payload.appearance.alert = true;
    payload.appearance.alertId = payload.alert.id;
  } else if (payload.appearance.alert) {
    payload.alert = { id: payload.appearance.alertId || `alert-${copy.sentAt ?? now}`, at: now };
  } else if (payload.appearance.alert === false) {
    payload.alert = null;
  }
  copy.sentAt = now;
  return copy;
}

function broadcastCrewPresence(room, topic = "crew") {
  const key = `${room}:${topic}`;
  const members = [];
  for (const client of wss.clients) {
    const identity = client.identities?.get(key);
    if (client.readyState !== 1 || !client.subscriptions?.has(key) || !identity?.id) continue;
    members.push(identity);
  }
  const envelope = { room, topic, payload: { kind: "presence", members }, sentAt: Date.now() };
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.subscriptions?.has(key)) send(client, envelope);
  }
}

function canReceiveCrew(socket, key, envelope) {
  const targetId = envelope.payload?.targetId;
  if (!targetId) return true;
  const identity = socket.identities?.get(key);
  return identity?.id === targetId || identity?.id === envelope.payload?.senderId;
}

wss.on("connection", (socket) => {
  socket.subscriptions = new Set();
  socket.identities = new Map();
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });
  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    const room = String(data.room ?? "").toUpperCase();
    const topic = data.topic;
    if (!room || !["screen", "crew", "voice"].includes(topic)) return;
    const key = `${room}:${topic}`;

    if (data.type === "join") {
      socket.subscriptions.add(key);
      if (data.identity && topic === "screen") socket.identities.set(key, data.identity);
      if (topic === "screen" && state[key]) {
        state[key] = normalizeScreenEnvelope(state[key], true);
        send(socket, state[key]);
      }
      if (topic === "crew" || topic === "voice") {
        if (data.identity?.id) socket.identities.set(key, data.identity);
        if (topic === "crew") {
          for (const message of crew[key] ?? []) {
            if (canReceiveCrew(socket, key, message)) send(socket, message);
          }
        }
        broadcastCrewPresence(room, topic);
      }
      return;
    }

    if (data.type === "leave") {
      socket.subscriptions.delete(key);
      socket.identities.delete(key);
      if (topic === "crew" || topic === "voice") broadcastCrewPresence(room, topic);
      return;
    }

    if (data.type === "identify" && (topic === "crew" || topic === "voice")) {
      if (data.identity?.id) socket.identities.set(key, data.identity);
      else socket.identities.delete(key);
      broadcastCrewPresence(room, topic);
      return;
    }

    if (topic === "screen") {
      if (rooms[room] && socket.identities?.get(key)?.adminCode !== rooms[room].adminCode) return;
      const normalized = normalizeScreenEnvelope(data);
      state[key] = normalized;
      data = normalized;
    } else if (topic === "voice") {
      // Sinalização WebRTC: nunca é guardada, só repassada na hora.
      const text = JSON.stringify(data);
      const to = data.payload?.to;
      for (const client of wss.clients) {
        if (client === socket || client.readyState !== 1 || !client.subscriptions?.has(key)) continue;
        if (to && client.identities?.get(key)?.id !== to) continue;
        client.send(text);
      }
      return;
    } else {
      const log = crew[key] ?? (crew[key] = []);
      if (data.payload?.id && log.some((entry) => entry.payload?.id === data.payload.id)) return;
      log.push(data);
      if (log.length > 200) log.splice(0, log.length - 200);
    }
    persist();
    const text = JSON.stringify(data);
    for (const client of wss.clients) {
      if (
        client !== socket && client.readyState === 1 && client.subscriptions?.has(key) &&
        (topic !== "crew" || canReceiveCrew(client, key, data))
      ) client.send(text);
    }
  });
  socket.on("close", () => {
    for (const key of socket.subscriptions ?? []) {
      if (key.endsWith(":crew")) broadcastCrewPresence(key.slice(0, -5), "crew");
      else if (key.endsWith(":voice")) broadcastCrewPresence(key.slice(0, -6), "voice");
    }
  });
});

// Wi-Fi de show cai: derruba conexões mortas para o cliente reconectar sozinho.
setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 15_000);

// Resolve quando o servidor HTTP principal já está aceitando conexões — usado
// pelo processo Electron (main.js) para saber a hora certa de abrir a janela,
// em vez de adivinhar com um setTimeout fixo. Não afeta o uso via linha de comando.
let resolveReady;
export const ready = new Promise((resolve) => { resolveReady = resolve; });

server.listen(port, "0.0.0.0", () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry?.family === "IPv4" && !entry.internal);
  console.log("Stage Prompt — central local pronta (funciona SEM internet).");
  console.log("Abra no celular/tablet/tela, no mesmo Wi-Fi:");
  for (const address of addresses) console.log(`  http://${address.address}:${port}`);
  resolveReady({ port, addresses: addresses.map((a) => a.address) });
  if (secureServer) {
    secureServer.listen(securePort, "0.0.0.0", () => {
      console.log("Para usar microfone/voz ao vivo no celular, abra em HTTPS (aceite o aviso de certificado):");
      for (const address of addresses) console.log(`  https://${address.address}:${securePort}`);
    });
  }
});
