// Voz ao vivo (walkie-talkie) na rede local: sinalização pelo hub, áudio P2P na LAN.
import { connect } from "/hub.js";

const RTC_CONFIG = { iceServers: [] };

/** Microfone com antirruído (porta de ruído) igual ao app online. */
async function getCleanMic() {
  const raw = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    return { stream: raw, setGate: () => {}, stop: () => raw.getTracks().forEach((t) => t.stop()) };
  }
  const src = ctx.createMediaStreamSource(raw);
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 110;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 7800;
  const compressor = ctx.createDynamicsCompressor();
  const gain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const dest = ctx.createMediaStreamDestination();
  src.connect(highpass).connect(lowpass).connect(compressor);
  compressor.connect(analyser);
  compressor.connect(gain).connect(dest);

  let gateOn = true;
  let openUntil = 0;
  const buf = new Float32Array(analyser.fftSize);
  const tick = () => {
    if (!gateOn) {
      gain.gain.value = 1;
    } else {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (rms > 0.015) openUntil = now + 400;
      gain.gain.value = now < openUntil ? 1 : 0;
    }
    raf = requestAnimationFrame(tick);
  };
  let raf = requestAnimationFrame(tick);

  return {
    stream: dest.stream,
    setGate: (value) => { gateOn = value; },
    stop: () => {
      cancelAnimationFrame(raf);
      raw.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
    analyser,
  };
}

function silentTrack() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
}

/**
 * @param {{room:string, selfId:string, getName:()=>string, getTargetId:()=>string|null, onState:(s:any)=>void}} opts
 */
export function createVoice(opts) {
  const peers = new Map();
  let channel = null;
  let mic = null;
  let silent = null;
  let mode = "ptt";
  let talking = false;
  let ptt = false;
  let gate = true;
  let joined = false;
  let vox = null;

  const emit = () => opts.onState({
    joined,
    mode,
    talking,
    ptt,
    gate,
    peers: [...peers.entries()].map(([id, p]) => ({ id, name: p.name, speaking: p.speaking })),
  });

  const transmitting = () => {
    if (mode === "open") return true;
    if (mode === "mute") return false;
    if (mode === "ptt") return ptt;
    return talking;
  };

  const apply = () => {
    const track = mic?.stream.getAudioTracks()[0] ?? null;
    const target = opts.getTargetId();
    for (const [id, peer] of peers) {
      if (!peer.sender) continue;
      const addressed = !target || target === id;
      const want = transmitting() && addressed ? track : silent;
      if (want && peer.sender.track !== want) peer.sender.replaceTrack(want).catch(() => {});
    }
    emit();
  };

  const setTalking = (value) => {
    if (talking === value) return;
    talking = value;
    apply();
  };

  const startVox = () => {
    if (vox || !mic?.analyser) return;
    const buf = new Float32Array(mic.analyser.fftSize);
    let last = 0;
    const loop = () => {
      if (!vox) return;
      mic.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (rms > 0.02) { last = now; setTalking(true); }
      else if (talking && now - last > 700) setTalking(false);
      vox.raf = requestAnimationFrame(loop);
    };
    vox = { raf: requestAnimationFrame(loop) };
  };
  const stopVox = () => {
    if (vox) cancelAnimationFrame(vox.raf);
    vox = null;
  };

  const signal = (payload) => channel?.send(payload);

  const closePeer = (id) => {
    const peer = peers.get(id);
    if (!peer) return;
    peers.delete(id);
    try { peer.pc.close(); } catch { /* já fechada */ }
    peer.audio?.remove();
    emit();
  };

  const ensurePeer = (id, name) => {
    const existing = peers.get(id);
    if (existing) {
      if (name && existing.name !== name) { existing.name = name; emit(); }
      return existing;
    }
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer = { pc, name: name || "Equipe", polite: opts.selfId < id, makingOffer: false, ignoreOffer: false, sender: null, audio: null, speaking: false };
    peers.set(id, peer);
    if (!silent) silent = silentTrack();
    peer.sender = pc.addTrack(silent, new MediaStream());

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        signal({ kind: "desc", from: opts.selfId, to: id, desc: pc.localDescription.toJSON() });
      } catch { /* renegocia depois */ }
      peer.makingOffer = false;
    };
    pc.onicecandidate = (ev) => signal({ kind: "ice", from: opts.selfId, to: id, candidate: ev.candidate?.toJSON() ?? null });
    pc.ontrack = (ev) => {
      if (!peer.audio) {
        const audio = new Audio();
        audio.autoplay = true;
        audio.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
        peer.audio = audio;
        audio.play().catch(() => {});
      }
      ev.track.onunmute = () => { peer.speaking = true; emit(); };
      ev.track.onmute = () => { peer.speaking = false; emit(); };
    };
    peer.retries = 0;
    const retryIce = () => {
      if (peer.retries >= 4 || !peers.has(id)) return;
      if (pc.connectionState === "connected" || pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") return;
      peer.retries += 1;
      try { pc.restartIce(); } catch { /* navegador antigo */ }
      setTimeout(retryIce, 5000);
    };
    setTimeout(retryIce, 6000);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "closed") closePeer(id);
      else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") retryIce();
    };

    emit();
    apply();
    return peer;
  };

  const handleSignal = async (payload) => {
    if (!payload || payload.from === opts.selfId || (payload.to && payload.to !== opts.selfId)) return;
    const peer = ensurePeer(payload.from, "");
    const pc = peer.pc;
    try {
      if (payload.kind === "desc") {
        const collision = payload.desc.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(payload.desc);
        if (payload.desc.type === "offer") {
          await pc.setLocalDescription();
          signal({ kind: "desc", from: opts.selfId, to: payload.from, desc: pc.localDescription.toJSON() });
        }
      } else if (payload.kind === "ice" && payload.candidate) {
        await pc.addIceCandidate(payload.candidate);
      }
    } catch { /* sinalização fora de ordem */ }
  };

  return {
    async join() {
      if (joined) return null;
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
        return "Este navegador bloqueia o microfone em endereço http:// — use os áudios gravados.";
      }
      try {
        mic = await getCleanMic();
      } catch {
        return "Não foi possível abrir o microfone neste aparelho.";
      }
      mic.setGate(gate);
      if (!silent) silent = silentTrack();
      channel = connect(opts.room, "voice", (payload) => {
        if (payload?.kind === "presence") {
          const ids = new Set();
          for (const member of payload.members || []) {
            if (member.id === opts.selfId) continue;
            ids.add(member.id);
            ensurePeer(member.id, member.name);
          }
          for (const id of [...peers.keys()]) if (!ids.has(id)) closePeer(id);
          return;
        }
        handleSignal(payload);
      }, null, { id: opts.selfId, name: opts.getName() });
      joined = true;
      emit();
      return null;
    },
    leave() {
      stopVox();
      for (const id of [...peers.keys()]) closePeer(id);
      channel?.close();
      channel = null;
      mic?.stop();
      mic = null;
      silent?.stop();
      silent = null;
      joined = false;
      talking = false;
      ptt = false;
      emit();
    },
    setMode(next) {
      mode = next;
      if (next === "vox") startVox(); else stopVox();
      if (next === "open") talking = true;
      else if (next === "mute" || next === "ptt") talking = false;
      apply();
    },
    setGate(value) {
      gate = value;
      mic?.setGate(value);
      emit();
    },
    pressPtt() { ptt = true; apply(); },
    releasePtt() { ptt = false; apply(); },
    toggleTalk() { setTalking(!talking); },
    identify(name) { channel?.identify({ id: opts.selfId, name }); },
    retarget: apply,
  };
}
