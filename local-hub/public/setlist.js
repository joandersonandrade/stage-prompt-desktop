// Roteiro do show (setlist manual) — mesma lógica da versão online.
export const ALERT_MIDI_NOTE = 99;

export function newId(prefix = "song") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function emptySong() {
  return {
    id: newId("song"),
    midiNote: null,
    repertoire: "",
    block: "",
    title: "Nova música",
    lyrics: "",
    stageNote: "",
    lyricMode: "scroll",
    durationSec: 210,
    cueNote: null,
    cues: [],
  };
}

function normalizeCues(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const note = Number(item.note);
      return {
        id: typeof item.id === "string" && item.id ? item.id : newId("cue"),
        text: String(item.text ?? ""),
        note: Number.isFinite(note) && note >= 0 && note <= 127 ? Math.trunc(note) : null,
      };
    });
}

export function normalizeSetlist(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const note = Number(item.midiNote);
      const cue = Number(item.cueNote);
      const duration = Number(item.durationSec);
      return {
        id: typeof item.id === "string" && item.id ? item.id : newId("song"),
        midiNote: Number.isFinite(note) && note >= 0 && note <= 127 ? Math.trunc(note) : null,
        repertoire: String(item.repertoire ?? ""),
        block: String(item.block ?? ""),
        title: String(item.title ?? "Sem título"),
        lyrics: String(item.lyrics ?? ""),
        stageNote: String(item.stageNote ?? ""),
        lyricMode: item.lyricMode === "cue" ? "cue" : "scroll",
        durationSec: Number.isFinite(duration) && duration > 0 ? Math.trunc(duration) : null,
        cueNote: Number.isFinite(cue) && cue >= 0 && cue <= 127 ? Math.trunc(cue) : null,
        cues: normalizeCues(item.cues),
      };
    });
}

export function findSong(setlist, id) {
  if (!id) return null;
  return setlist.find((s) => s.id === id) ?? null;
}

export function nextSong(setlist, id) {
  const index = setlist.findIndex((s) => s.id === id);
  if (index < 0) return setlist[0] ?? null;
  return setlist[index + 1] ?? null;
}

export function songByNote(setlist, note) {
  return setlist.find((s) => s.midiNote === note) ?? null;
}

/** Frases exibidas no teleprompter: cues cadastradas ou fatias da letra. */
export function songBlocks(song) {
  const cues = (song?.cues ?? []).map((cue) => String(cue.text).trim()).filter(Boolean);
  if (song?.lyricMode === "cue" && cues.length > 0) return cues;
  const text = String(song?.lyrics ?? "").trim();
  if (!text) return [];
  const byParagraph = text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  if (byParagraph.length > 1) return byParagraph;
  return text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
}

/** Índice da frase cuja nota MIDI corresponde ao sinal recebido. */
export function cueIndexByNote(song, note) {
  if (!song || song.lyricMode !== "cue") return null;
  const cues = (song.cues ?? []).filter((cue) => String(cue.text).trim());
  const index = cues.findIndex((cue) => cue.note === note);
  return index >= 0 ? index : null;
}

export function clampBlock(song, index) {
  const total = songBlocks(song).length;
  if (total === 0) return 0;
  return Math.max(0, Math.min(total - 1, Math.trunc(index) || 0));
}

export const DEFAULT_SCENE_STYLE = {
  lyricSize: 6,
  noteSize: 4,
  infoSize: 2.2,
  lyricColor: "#ffffff",
  noteColor: "#ffe600",
  infoColor: "#ffffff",
  attentionColor: "#ffe600",
  notePlacement: "top",
  showInfo: true,
};

export function normalizeSceneStyle(raw) {
  const style = { ...DEFAULT_SCENE_STYLE, ...(raw && typeof raw === "object" ? raw : {}) };
  style.lyricSize = Number(style.lyricSize) || DEFAULT_SCENE_STYLE.lyricSize;
  style.noteSize = Number(style.noteSize) || DEFAULT_SCENE_STYLE.noteSize;
  style.infoSize = Number(style.infoSize) || DEFAULT_SCENE_STYLE.infoSize;
  if (!["top", "bottom", "above-lyrics", "below-lyrics"].includes(style.notePlacement)) style.notePlacement = "top";
  style.showInfo = style.showInfo !== false;
  return style;
}

/** Baixa o repertório completo em .json. */
export function exportSetlistFile(setlist, roomCode) {
  const payload = JSON.stringify({ version: 1, room: roomCode, songs: setlist }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `repertorio-${String(roomCode).toLowerCase()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function parseSetlistFile(text) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return normalizeSetlist(parsed);
  return normalizeSetlist(parsed?.songs);
}
