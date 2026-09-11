// Cliente do hub local: WebSocket puro, sem internet, sem login.
export function roomFromUrl(fallback = "PALCO") {
  const url = new URL(location.href);
  const code = (url.searchParams.get("sala") || localStorage.getItem("hub:sala") || fallback).toUpperCase();
  localStorage.setItem("hub:sala", code);
  return code;
}

export function setRoom(code) {
  localStorage.setItem("hub:sala", code.toUpperCase());
}

export function cleanRoom(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

export function codeToPin(code) {
  const clean = cleanRoom(code);
  if (clean.length < 3) return "";
  let number = 0n;
  for (const char of clean) number = number * 36n + BigInt(parseInt(char, 36));
  return number.toString();
}

export function pinToCode(pin) {
  const digits = String(pin ?? "").replace(/\D/g, "");
  if (!digits) return "";
  try {
    let number = BigInt(digits);
    let code = "";
    while (number > 0n) {
      code = Number(number % 36n).toString(36).toUpperCase() + code;
      number /= 36n;
    }
    return cleanRoom(code);
  } catch { return ""; }
}

export function resolveRoom(value) {
  const raw = String(value ?? "").trim();
  return /^\d+$/.test(raw) ? pinToCode(raw) : cleanRoom(raw);
}

export function adminCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(8));
  return Array.from({ length: 8 }, (_, index) => alphabet[(bytes?.[index] ?? Math.floor(Math.random() * 256)) % alphabet.length]).join("");
}

export function connect(room, topic, onMessage, onStatus, identity = null) {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  let socket = null;
  let closed = false;
  const queue = [];

  const open = () => {
    if (closed) return;
    onStatus?.("connecting");
    socket = new WebSocket(url);
    socket.onopen = () => {
      onStatus?.("connected");
      socket.send(JSON.stringify({ type: "join", room, topic, identity }));
      while (queue.length && socket.readyState === 1) socket.send(queue.shift());
    };
    socket.onmessage = (event) => {
      try {
        const envelope = JSON.parse(event.data);
        if (envelope.room === room && envelope.topic === topic) onMessage(envelope.payload, envelope.sentAt);
      } catch {
        /* pacote inválido */
      }
    };
    socket.onclose = () => {
      onStatus?.("offline");
      if (!closed) setTimeout(open, 1500);
    };
    socket.onerror = () => socket.close();
  };
  open();

  return {
    send(payload) {
      const text = JSON.stringify({ room, topic, payload, sentAt: Date.now() });
      if (socket?.readyState === 1) socket.send(text);
      else queue.push(text);
    },
    identify(nextIdentity) {
      identity = nextIdentity;
      if (socket?.readyState === 1) socket.send(JSON.stringify({ type: "identify", room, topic, identity }));
    },
    close() {
      closed = true;
      socket?.close();
    },
  };
}

export function formatClock(ms) {
  const negative = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  const body = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return negative ? `-${body}` : body;
}

export function parseDuration(text) {
  const clean = String(text).trim().toLowerCase();
  if (!clean) return 0;
  if (/^\d+\s*s$/.test(clean)) return parseInt(clean) * 1000;
  if (/^\d+\s*m$/.test(clean)) return parseInt(clean) * 60_000;
  if (/^\d+\s*h$/.test(clean)) return parseInt(clean) * 3_600_000;
  const parts = clean.split(":").map((p) => parseInt(p || "0", 10) || 0);
  if (parts.length === 1) return parts[0] * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
}

// Tempo restante/decorrido calculado sem depender do relógio dos aparelhos estarem iguais.
export function timerMs(timer, offset = 0) {
  const accumulated = Number(timer.accumulatedMs ?? timer.elapsedMs ?? 0);
  const startedAt = typeof timer.startedAt === "number" ? timer.startedAt : Date.parse(String(timer.startedAt ?? ""));
  const base = timer.running && Number.isFinite(startedAt)
    ? accumulated + Math.max(0, Date.now() - offset - startedAt)
    : accumulated;
  // Estourou o tempo: segue contando no negativo.
  return timer.mode === "down" ? timer.durationMs - base : base;
}

/** UUID que funciona em http://IP (contexto não seguro do celular). */
export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
