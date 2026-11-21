// Converter, static edition: files are converted in the browser with ffmpeg.wasm;
// links are handed to a link server (the Python app in this repo), because browsers
// are not allowed to download YouTube media directly.
import { FFmpeg } from "./vendor/ffmpeg/index.js";

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ formats (mirrors converter/formats.py)

const VIDEO_IN = ["mp4", "mkv", "mov", "avi", "webm", "flv", "m4v", "wmv", "mpeg", "3gp", "ts"];
const AUDIO_IN = ["mp3", "wav", "aac", "m4a", "ogg", "flac", "opus", "wma", "aiff", "amr"];
const IMAGE_IN = ["jpg", "png", "webp", "bmp", "tiff", "gif", "ico"];
const VIDEO_OUT = ["mp4", "webm", "mkv", "mov", "avi", "gif"];
const AUDIO_OUT = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "aiff"];
const IMAGE_OUT = ["png", "jpg", "webp", "bmp", "tiff", "gif", "ico", "pdf"];
const FRAME_OUT = ["png", "jpg"];
const URL_OUT = ["mp3", "m4a", "wav", "flac", "ogg", "opus", "mp4", "webm", "mkv", "gif"];
const LOSSY_AUDIO = ["mp3", "m4a", "aac", "ogg", "opus"];
const ALIASES = { jpeg: "jpg", tif: "tiff", aif: "aiff", oga: "ogg", mpg: "mpeg" };
const MIME = {
  mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime", avi: "video/x-msvideo",
  gif: "image/gif", mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac",
  ogg: "audio/ogg", opus: "audio/ogg", aiff: "audio/aiff", png: "image/png", jpg: "image/jpeg",
  webp: "image/webp", bmp: "image/bmp", tiff: "image/tiff", ico: "image/x-icon", pdf: "application/pdf",
};

const extOf = (name) => {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  const e = m ? m[1].toLowerCase() : "";
  return ALIASES[e] || e;
};
const categoryOf = (ext) =>
  VIDEO_IN.includes(ext) ? "video" : AUDIO_IN.includes(ext) ? "audio" : IMAGE_IN.includes(ext) ? "image" : null;

function targetsFor(ext) {
  const cat = categoryOf(ext);
  let out = [];
  if (cat === "video") out = [...VIDEO_OUT, ...AUDIO_OUT, ...FRAME_OUT];
  else if (cat === "audio") out = [...AUDIO_OUT];
  else if (cat === "image") out = ext === "gif" ? [...IMAGE_OUT, "mp4", "webm"] : [...IMAGE_OUT];
  return [...new Set(out)].filter((f) => f !== ext);
}

// ------------------------------------------------------------ ffmpeg.wasm

let ffmpeg = null;
let ffmpegReady = null;
let logSink = null;
let wasmBlobUrl = null;     // kept across cancels so a restart doesn't download again
let loadProgress = 0;       // 0..1 of the engine download
let onLoadProgress = null;  // set by whoever is currently showing a progress bar

// Exact size of vendor/core/ffmpeg-core.wasm. Used instead of Content-Length, which is the
// compressed size when the host gzips the file.
const WASM_BYTES = 32232419;

async function fetchWithProgress(url, expected, report) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = expected || Number(res.headers.get("Content-Length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) report(Math.min(got / total, 1));
  }
  report(1);
  return URL.createObjectURL(new Blob(chunks, { type: "application/wasm" }));
}

function loadFFmpeg() {
  if (ffmpegReady) return ffmpegReady;
  ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => logSink && logSink(message));
  const base = new URL("./vendor/core/", import.meta.url).href;
  const instance = ffmpeg;
  ffmpegReady = (async () => {
    if (!wasmBlobUrl) {
      wasmBlobUrl = await fetchWithProgress(base + "ffmpeg-core.wasm", WASM_BYTES, (p) => {
        loadProgress = p;
        onLoadProgress && onLoadProgress(p);
      });
    }
    await instance.load({ coreURL: base + "ffmpeg-core.js", wasmURL: wasmBlobUrl });
  })().catch((err) => {
    if (ffmpeg === instance) { ffmpeg = null; ffmpegReady = null; }
    throw new Error("Could not start the converter in this browser: " + (err?.message || err));
  });
  return ffmpegReady;
}

function cancelFFmpeg() {
  if (ffmpeg) ffmpeg.terminate(); // kills the worker; the next run loads a fresh one
  ffmpeg = null;
  ffmpegReady = null;
}

class ConversionError extends Error {}

// ffmpeg 6+ says "Output file is empty". The 5.x build inside ffmpeg.wasm only reports 0 kB written,
// which tiny real outputs also show (kB is rounded down), so it also needs zero frames / zero time.
const EMPTY_MESSAGE = /Output file is empty|nothing was encoded/i;
const ZERO_KB = /video:0kB audio:0kB/;

const parseTs = (t) => t.split(":").reduce((acc, v) => acc * 60 + parseFloat(v), 0);

function friendly(logs) {
  const text = logs.join("\n");
  if (EMPTY_MESSAGE.test(text) || /Nothing to convert/.test(text))
    return "Nothing to convert: the chosen Start/End range is past the end of the file.";
  if (/matches no streams|does not contain any stream|Output file .* does not contain/i.test(text))
    return "The file has no stream of the type needed for that format (for example, a video with no audio track).";
  if (/Invalid data found|could not find codec parameters|moov atom not found/i.test(text))
    return "The file could not be read. It may be corrupt or not really the format its name says.";
  if (/Cannot allocate memory|out of memory|OOM/i.test(text))
    return "The browser ran out of memory. Try a smaller file or trim it with Start/End.";
  const tail = logs.filter((l) => l.trim() && !/^\s*(frame=|size=)/.test(l)).slice(-3);
  return "Conversion failed: " + (tail.join(" | ") || "unknown error");
}

/** Run ffmpeg on `file` with the given args builder. Returns the output bytes. */
async function runFFmpeg(file, buildArgs, outName, { trim = null, onProgress } = {}) {
  await loadFFmpeg();
  const logs = [];
  let duration = null, lastFrame = null, lastTime = null;
  logSink = (line) => {
    const f = /frame=\s*(\d+)/.exec(line);
    if (f) lastFrame = Number(f[1]);
    logs.push(line);
    if (logs.length > 400) logs.shift();
    const d = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(line);
    if (d && duration === null) duration = parseTs(d[1]);
    const t = /time=\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(line);
    if (t) lastTime = parseTs(t[1]);
    if (t && onProgress) {
      let total = duration;
      if (total && trim?.start) total = Math.max(total - trim.start, 0.01);
      if (trim?.length) total = total ? Math.min(total, trim.length) : trim.length;
      if (total) onProgress(Math.min(parseTs(t[1]) / total, 0.99));
    }
  };

  // Mount the File read-only instead of copying it into wasm memory where supported.
  const dir = "/in-" + Math.random().toString(36).slice(2);
  let input;
  try {
    await ffmpeg.createDir(dir);
    await ffmpeg.mount("WORKERFS", { files: [file] }, dir);
    input = `${dir}/${file.name}`;
  } catch {
    input = "input." + (extOf(file.name) || "bin");
    await ffmpeg.writeFile(input, new Uint8Array(await file.arrayBuffer()));
  }

  try {
    const code = await ffmpeg.exec(["-hide_banner", "-y", ...buildArgs(input), outName]);
    const empty = logs.some((l) => EMPTY_MESSAGE.test(l)) ||
      (logs.some((l) => ZERO_KB.test(l)) && (lastFrame === 0 || (lastFrame === null && lastTime === 0)));
    if (empty) throw new ConversionError("Nothing to convert: the chosen Start/End range is past the end of the file.");
    if (code !== 0) throw new ConversionError(friendly(logs));
    const data = await ffmpeg.readFile(outName);
    if (!data || !data.length) throw new ConversionError(friendly(logs));
    onProgress && onProgress(1);
    return data;
  } finally {
    logSink = null;
    await ffmpeg?.deleteFile(outName).catch(() => {});
    if (input.startsWith(dir)) {
      await ffmpeg?.unmount(dir).catch(() => {});
      await ffmpeg?.deleteDir(dir).catch(() => {});
    } else {
      await ffmpeg?.deleteFile(input).catch(() => {});
    }
  }
}

const EVEN = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
const AUDIO_ARGS = {
  mp3: (br) => ["-c:a", "libmp3lame", "-b:a", br],
  wav: () => ["-c:a", "pcm_s16le"],
  aiff: () => ["-c:a", "pcm_s16be"],
  flac: () => ["-c:a", "flac"],
  m4a: (br) => ["-c:a", "aac", "-b:a", br],
  aac: (br) => ["-c:a", "aac", "-b:a", br],
  ogg: (br) => ["-c:a", "libvorbis", "-b:a", br],
  opus: (br) => ["-c:a", "libopus", "-b:a", br],
};
const H264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k"];
const VIDEO_ARGS = {
  mp4: [...H264, "-movflags", "+faststart"],
  mov: H264,
  mkv: H264,
  webm: ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-crf", "10", "-b:v", "2M",
    "-c:a", "libopus", "-b:a", "128k"],
  avi: ["-c:v", "mpeg4", "-q:v", "4", "-c:a", "libmp3lame", "-b:a", "192k"],
};

function trimIn(o) { return o.start ? ["-ss", String(o.start)] : []; }
function trimOut(o) {
  const len = o.end != null ? o.end - (o.start || 0) : null;
  return len ? ["-t", String(len)] : [];
}

// ------------------------------------------------------------ images via canvas

async function decodeImage(blob) {
  try { return await createImageBitmap(blob); } catch { return null; }
}

function canvasBlob(bitmap, type, quality, flatten) {
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  const g = c.getContext("2d");
  if (flatten) { g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(bitmap, 0, 0);
  return new Promise((res) => c.toBlob(res, type, quality));
}

/** Minimal one-page PDF wrapping a JPEG at 96 dpi. */
async function jpegToPdf(jpegBlob, w, h) {
  const jpg = new Uint8Array(await jpegBlob.arrayBuffer());
  const pw = (w * 0.75).toFixed(2), ph = (h * 0.75).toFixed(2);
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (chunk) => { const b = typeof chunk === "string" ? enc.encode(chunk) : chunk; parts.push(b); size += b.length; };
  const obj = (n, body) => { offsets[n] = size; push(`${n} 0 obj\n`); body(); push("\nendobj\n"); };
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => {
    push(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    push(jpg);
    push("\nendstream");
  });
  obj(5, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  const xref = size;
  push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}

// ------------------------------------------------------------ conversion router

async function convertFile(file, fmt, o, onProgress) {
  const ext = extOf(file.name);
  const cat = categoryOf(ext);
  const out = "output." + fmt;
  const bytes = (data) => new Blob([data], { type: MIME[fmt] });
  const trim = { start: o.start, length: o.end != null ? o.end - (o.start || 0) : null };

  if (cat === "image" && IMAGE_OUT.includes(fmt)) {
    // Animated GIF -> animated WebP needs ffmpeg; everything else that canvas can do, canvas does.
    if (!(ext === "gif" && fmt === "webp") && ["png", "jpg", "webp", "pdf"].includes(fmt)) {
      let bitmap = await decodeImage(file);
      if (!bitmap) { // e.g. TIFF in Chrome: let ffmpeg decode it to PNG first
        const png = await runFFmpeg(file, (i) => ["-i", i, "-frames:v", "1", "-update", "1"], "decoded.png");
        bitmap = await decodeImage(new Blob([png], { type: "image/png" }));
      }
      if (!bitmap) throw new ConversionError("The image could not be read. It may be corrupt or an unsupported variant.");
      const q = o.quality / 100;
      let blob;
      if (fmt === "pdf") blob = await jpegToPdf(await canvasBlob(bitmap, "image/jpeg", 0.92, true), bitmap.width, bitmap.height);
      else blob = await canvasBlob(bitmap, MIME[fmt], q, fmt === "jpg");
      if (blob && blob.type === MIME[fmt]) { onProgress(1); return blob; }
      // Browser can't encode this type (Safari + WebP): fall through to ffmpeg.
    }
    const still = ["-frames:v", "1", "-update", "1"];
    const build = {
      png: (i) => ["-i", i, ...still],
      jpg: (i) => ["-i", i, ...still, "-q:v", String(Math.round(31 - (o.quality / 100) * 29))],
      webp: (i) => ext === "gif"
        ? ["-i", i, "-c:v", "libwebp_anim", "-loop", "0", "-quality", String(o.quality)]
        : ["-i", i, ...still, "-quality", String(o.quality)],
      bmp: (i) => ["-i", i, ...still],
      tiff: (i) => ["-i", i, ...still, "-compression_algo", "lzw"],
      gif: (i) => ["-i", i, "-frames:v", "1", "-filter_complex", "split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse"],
      ico: (i) => ["-i", i, "-frames:v", "1",
        "-vf", "scale='min(256,iw)':'min(256,ih)':force_original_aspect_ratio=decrease"],
    }[fmt];
    if (!build) throw new ConversionError(`Cannot convert .${ext} to .${fmt} in the browser.`);
    return bytes(await runFFmpeg(file, build, out, { onProgress }));
  }

  if (fmt === "gif") {
    const scale = o.gif_width ? `,scale='min(${o.gif_width},iw)':-1:flags=lanczos` : ""; // never upscale
    const graph = `[0:v]fps=${o.gif_fps}${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`;
    return bytes(await runFFmpeg(file, (i) => [...trimIn(o), "-i", i, ...trimOut(o), "-filter_complex", graph, "-an", "-loop", "0"], out, { trim, onProgress }));
  }
  if (VIDEO_OUT.includes(fmt)) {
    const scale = o.max_height ? `scale=-2:'trunc(min(ih,${o.max_height})/2)*2'` : EVEN; // never upscales
    return bytes(await runFFmpeg(file, (i) => [...trimIn(o), "-i", i, "-map", "0:v:0", "-map", "0:a:0?", ...trimOut(o), "-vf", scale, ...VIDEO_ARGS[fmt]], out, { trim, onProgress }));
  }
  if (AUDIO_OUT.includes(fmt)) {
    return bytes(await runFFmpeg(file, (i) => [...trimIn(o), "-i", i, "-map", "0:a:0", "-vn", ...trimOut(o), ...AUDIO_ARGS[fmt](o.bitrate)], out, { trim, onProgress }));
  }
  if (FRAME_OUT.includes(fmt)) {
    return bytes(await runFFmpeg(file, (i) => [...trimIn(o), "-i", i, "-frames:v", "1", "-update", "1", ...(fmt === "jpg" ? ["-q:v", "2"] : [])], out, { onProgress }));
  }
  throw new ConversionError(`Cannot convert .${ext} to .${fmt}.`);
}


// ------------------------------------------------------------ zip (store only, for "Download all")

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build an uncompressed ZIP (media files don't compress further anyway). */
async function makeZip(entries) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [], used = new Set();
  let offset = 0;
  for (const { name, blob } of entries) {
    let unique = name;
    for (let i = 1; used.has(unique); i++) unique = name.replace(/(\.[^.]*)?$/, ` (${i})$1`);
    used.add(unique);
    const nameBytes = enc.encode(unique);
    const data = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(data);
    if (offset + data.length > 0xfffffffe) throw new Error("Too large for one zip. Download the files one by one.");

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local, nameBytes, data);

    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true); head.setUint16(4, 20, true); head.setUint16(6, 20, true);
    head.setUint16(8, 0x0800, true); head.setUint16(12, time, true); head.setUint16(14, date, true);
    head.setUint32(16, crc, true); head.setUint32(20, data.length, true); head.setUint32(24, data.length, true);
    head.setUint16(28, nameBytes.length, true); head.setUint32(42, offset, true);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

// ------------------------------------------------------------ UI

const state = {
  mode: "file",
  items: [],        // { id, file, ext, status: idle|running|done|error, progress, blob, url, name, error }
  target: null,
  busy: false,
  cancel: null,
  zipUrl: null,
  heights: null,    // available video heights for the current link
};
let nextId = 1;

const el = {
  drop: $("drop"), fileInput: $("file-input"), dropTitle: $("drop-title"), dropSub: $("drop-sub"), queue: $("queue"),
  url: $("url-input"), urlInfo: $("url-info"), urlThumb: $("url-thumb"), urlTitle: $("url-title"), urlMeta: $("url-meta"),
  server: $("server-input"), serverDot: $("server-dot"), serverHint: $("server-hint"), advanced: $("advanced"),
  targets: $("targets"), options: $("options"), res: $("res-select"), go: $("go"),
  status: $("status"), bar: $("bar-fill"), statusText: $("status-text"), statusPct: $("status-pct"),
  statusDetail: $("status-detail"), cancel: $("cancel"),
  result: $("result"), preview: $("preview"), resultNote: $("result-note"), download: $("download"), again: $("again"),
};

const bytesLabel = (n) => {
  if (n == null) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const clock = (s) => {
  if (!s && s !== 0) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(sec).padStart(2, "0");
};
const stemOf = (name) => name.replace(/\.[^.]+$/, "") || "converted";

// ---- targets & options

function availableTargets() {
  if (state.mode === "url") return URL_OUT;
  if (!state.items.length) return [];
  // Formats every queued file can become.
  return state.items.map((it) => targetsFor(it.ext)).reduce((a, b) => a.filter((f) => b.includes(f)));
}

function renderTargets() {
  const list = availableTargets();
  el.targets.innerHTML = "";
  if (!list.length) {
    state.target = null;
    if (state.mode === "file" && state.items.length > 1) {
      el.targets.innerHTML = '<p class="hint">These files have no format in common. Remove some, or convert them in separate batches.</p>';
      el.targets.hidden = false;
    } else {
      el.targets.hidden = true;
    }
    return updateUI();
  }
  if (!list.includes(state.target)) state.target = null;
  const cats = new Set(state.items.map((it) => categoryOf(it.ext)));
  const groups = [
    ["Video", list.filter((f) => VIDEO_OUT.includes(f))],
    ["Audio", list.filter((f) => AUDIO_OUT.includes(f))],
    [state.mode === "file" && cats.size === 1 && cats.has("video") ? "Still frame" : "Image",
      list.filter((f) => !VIDEO_OUT.includes(f) && !AUDIO_OUT.includes(f))],
  ];
  for (const [label, formats] of groups) {
    if (!formats.length) continue;
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="group-label">${label}</div><div class="chips"></div>`;
    const chips = wrap.querySelector(".chips");
    for (const f of formats) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (f === state.target ? " is-selected" : "");
      b.textContent = f;
      b.setAttribute("aria-pressed", f === state.target);
      b.addEventListener("click", () => { if (!state.busy) { state.target = f; renderTargets(); } });
      chips.appendChild(b);
    }
    el.targets.appendChild(wrap);
  }
  el.targets.hidden = false;
  updateUI();
}

function renderResolution() {
  const keep = el.res.value;
  const heights = state.mode === "url" && state.heights?.length
    ? [...state.heights].reverse().filter((h) => h >= 144 && h <= 2160)
    : [1080, 720, 480, 360];
  const top = state.mode === "url" ? "Best available" : "Original";
  el.res.innerHTML = `<option value="0">${top}</option>` +
    [...new Set(heights)].map((h) => `<option value="${h}">${h}p</option>`).join("");
  if ([...el.res.options].some((o) => o.value === keep)) el.res.value = keep;
}

function updateOptions() {
  const t = state.target;
  const cats = state.mode === "url" ? new Set(["url"]) : new Set(state.items.map((it) => categoryOf(it.ext)));
  const fromGif = state.items.some((it) => it.ext === "gif");
  const show = {
    bitrate: LOSSY_AUDIO.includes(t),
    quality: cats.has("image") && (t === "jpg" || t === "webp"),
    gif: t === "gif" && !cats.has("image"),
    res: VIDEO_OUT.includes(t) && t !== "gif",
    trim: cats.has("video") || cats.has("audio") || cats.has("url") || (fromGif && VIDEO_OUT.includes(t)),
  };
  let any = false;
  el.options.querySelectorAll(".opt").forEach((o) => { o.hidden = !show[o.dataset.opt]; any ||= !o.hidden; });
  el.options.hidden = !t || !any;
  const resLabel = el.options.querySelector('[data-opt="res"] .opt-label');
  if (resLabel) resLabel.textContent = state.mode === "url" ? "Video quality" : "Resolution";
}

function updateUI() {
  updateOptions();
  const n = state.items.length;
  const ready = state.mode === "file" ? n && state.target : el.url.value.trim() && state.target;
  el.go.disabled = !ready || state.busy;
  const what = state.mode === "file" && n > 1 ? `Convert ${n} files` : "Convert";
  el.go.textContent = state.target ? `${what} to ${state.target.toUpperCase()}` : what;
}

function readOptions() {
  const v = (n) => el.options.querySelector(`.opt:not([hidden]) [name=${n}]`)?.value ?? "";
  const num = (n) => (v(n) === "" ? null : Number(v(n)));
  const o = {
    bitrate: v("bitrate") || "192k",
    quality: Math.min(100, Math.max(1, num("quality") ?? 90)),
    gif_fps: Math.min(50, Math.max(1, num("gif_fps") ?? 12)),
    gif_width: Math.min(1920, Math.max(0, num("gif_width") ?? 480)),
    max_height: num("max_height") || 0,
    start: num("start"),
    end: num("end"),
  };
  if ([o.start, o.end].some((x) => x != null && (!Number.isFinite(x) || x < 0)))
    throw new ConversionError("Start and End must be positive numbers of seconds.");
  if (o.start != null && o.end != null && o.end <= o.start)
    throw new ConversionError("End time must be after the start time.");
  return o;
}

// ---- file queue

function releaseItem(it) {
  if (it.url) URL.revokeObjectURL(it.url);
  it.url = null; it.blob = null;
}

function addFiles(files) {
  if (state.busy) return;
  resetResult();
  let skipped = 0;
  for (const file of files) {
    const ext = extOf(file.name);
    if (!categoryOf(ext)) { skipped++; continue; }
    state.items.push({ id: nextId++, file, ext, status: "idle", progress: 0, blob: null, url: null, name: null, error: null });
  }
  renderQueue();
  renderTargets();
  el.dropSub.textContent = skipped
    ? `Skipped ${skipped} unsupported file${skipped > 1 ? "s" : ""}.`
    : el.dropSub.dataset.default;
  if (state.items.length) loadFFmpeg().catch(() => {}); // warm up while the user picks a format
}

function removeItem(id) {
  if (state.busy) return;
  const i = state.items.findIndex((it) => it.id === id);
  if (i < 0) return;
  releaseItem(state.items[i]);
  state.items.splice(i, 1);
  resetResult();
  renderQueue();
  renderTargets();
}

function renderQueue() {
  const n = state.items.length;
  el.queue.hidden = !n;
  el.drop.classList.toggle("is-compact", n > 0);
  el.dropTitle.textContent = n ? "Add more files" : "Drop files, or click to choose";
  el.queue.innerHTML = "";
  for (const it of state.items) {
    const li = document.createElement("li");
    li.className = `item is-${it.status}`;
    li.dataset.id = it.id;
    li.innerHTML = `
      <div class="item-main">
        <span class="item-name"></span>
        <span class="item-meta"></span>
      </div>
      <div class="item-side">
        <span class="item-state"></span>
        <a class="item-dl" hidden>Download</a>
        <button class="item-remove" type="button" aria-label="Remove">×</button>
      </div>
      <div class="item-bar"><span></span></div>
      <div class="item-error" hidden></div>`;
    li.querySelector(".item-name").textContent = it.file.name;
    li.querySelector(".item-meta").textContent = `${bytesLabel(it.file.size)} · ${it.ext.toUpperCase()}`;
    li.querySelector(".item-remove").addEventListener("click", () => removeItem(it.id));
    el.queue.appendChild(li);
    paintItem(it);
  }
}

function paintItem(it) {
  const li = el.queue.querySelector(`[data-id="${it.id}"]`);
  if (!li) return;
  li.className = `item is-${it.status}`;
  const stateText = { idle: "", running: `${Math.round(it.progress * 100)}%`, done: bytesLabel(it.blob?.size), error: "Failed" }[it.status];
  li.querySelector(".item-state").textContent = it.status === "running" && it.progress === 0 ? "Starting" : stateText;
  li.querySelector(".item-bar span").style.width = `${Math.round((it.status === "done" ? 1 : it.progress) * 100)}%`;
  const dl = li.querySelector(".item-dl");
  dl.hidden = !(it.status === "done" && it.url) || state.items.length === 1; // single file: the big button covers it
  if (it.url) { dl.href = it.url; dl.download = it.name; }
  const err = li.querySelector(".item-error");
  err.hidden = it.status !== "error";
  err.textContent = it.error || "";
  li.querySelector(".item-remove").hidden = state.busy;
}

el.fileInput.addEventListener("change", () => { addFiles([...el.fileInput.files]); el.fileInput.value = ""; });
["dragenter", "dragover"].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add("is-over"); }));
["dragleave", "drop"].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove("is-over"); }));
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  el.drop.classList.remove("is-over");
  if (!e.dataTransfer.files.length || state.busy) return;
  if (state.mode !== "file") switchMode("file");
  addFiles([...e.dataTransfer.files]);
});

// Paste a link anywhere to convert it; paste an image or file to queue it.
window.addEventListener("paste", (e) => {
  if (state.busy) return;
  const t = e.target;
  const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    if (state.mode !== "file") switchMode("file");
    addFiles(files.map((f, i) => (f.name && f.name !== "image.png") ? f
      : new File([f], `pasted-${Date.now()}${i ? "-" + i : ""}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type })));
    return;
  }
  if (typing) return;
  const text = (e.clipboardData?.getData("text") || "").trim();
  if (/^https?:\/\/\S+$/.test(text)) {
    e.preventDefault();
    if (state.mode !== "url") switchMode("url");
    el.url.value = text;
    el.url.dispatchEvent(new Event("input"));
  }
});

// ---- link service

// Where links are sent. Order: the visitor's own override (Link service settings),
// the site's own origin when app.py serves the page, config.js, then a local app.py.
const CONFIG = window.CONVERTER_CONFIG || {};
function defaultServer() {
  if (CONFIG.servedByApp) return location.origin;  // app.py serves its own config.js with this flag
  if (CONFIG.linkServer) return CONFIG.linkServer;
  return "http://127.0.0.1:5000";
}
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
el.server.value = store.get("linkServer") || defaultServer();
el.server.placeholder = defaultServer();
const serverBase = () => el.server.value.trim().replace(/\/+$/, "");
const isLocalServer = () => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(serverBase());

async function api(path, body) {
  const res = await fetch(serverBase() + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(data.error || `Link service error (${res.status}).`);
  return data;
}

let serverOk = false;
async function checkServer(timeoutMs = 5000) {
  el.serverDot.className = "dot";
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(serverBase() + "/healthz", { signal: ctl.signal, cache: "no-store" });
    clearTimeout(timer);
    serverOk = res.ok;
  } catch {
    serverOk = false;
  }
  el.serverDot.className = "dot " + (serverOk ? "is-ok" : "is-bad");
  el.serverDot.title = serverOk ? "Link service connected" : "Link service not reachable";
  el.serverHint.hidden = serverOk;
  return serverOk;
}
el.server.addEventListener("change", () => {
  const v = serverBase();
  if (!v || v === defaultServer()) { el.server.value = defaultServer(); store.del("linkServer"); }
  else store.set("linkServer", v);
  infoFor = "";
  checkServer();
});

/** Make sure the link service is up, waiting for a sleeping free-tier host to wake. */
// Free hosts (Render) sleep when idle and take a minute or two to start again. While starting,
// requests can fail quickly or hang, so keep retrying instead of trusting a single attempt.
const WAKE_LIMIT_MS = 150000;
let waking = null;

function waitForServer(onTick) {
  if (isLocalServer()) return checkServer(5000);
  if (!waking) {
    waking = (async () => {
      const start = Date.now();
      while (Date.now() - start < WAKE_LIMIT_MS) {
        if (await checkServer(15000)) return true;
        await new Promise((r) => setTimeout(r, 3000));
      }
      return false;
    })().finally(() => { waking = null; });
  }
  const started = Date.now();
  const timer = onTick ? setInterval(() => onTick(Math.round((Date.now() - started) / 1000)), 1000) : null;
  return waking.finally(() => timer && clearInterval(timer));
}

/** Make sure the link service is up, waiting for a sleeping free-tier host to wake. */
async function ensureServer() {
  if (await checkServer(8000)) return;
  if (isLocalServer()) {
    el.advanced.open = true;
    throw new Error('No link service is running on this computer. Start one with "python app.py", or set a link service below.');
  }
  const tell = (secs) => showStatus("Waking up the link service", {
    detail: `It sleeps when nobody has used it for a while. Usually ready within a minute${secs ? ` · ${secs}s` : ""}.`,
  });
  tell(0);
  if (await waitForServer(tell)) return;
  el.advanced.open = true;
  throw new Error("The link service didn't respond after 2½ minutes. It may be down; try again later.");
}

let infoTimer = null, infoFor = "";
el.url.addEventListener("input", () => {
  resetResult();
  updateUI();
  clearTimeout(infoTimer);
  infoTimer = setTimeout(loadInfo, 600);
});

async function loadInfo() {
  const url = el.url.value.trim();
  if (!/^https?:\/\/\S+\.\S+/.test(url)) {
    if (!url) { el.urlInfo.hidden = true; state.heights = null; renderResolution(); }
    return;
  }
  if (url === infoFor) return;
  if (!serverOk) {
    el.urlInfo.hidden = false;
    el.urlInfo.classList.add("is-loading");
    el.urlThumb.removeAttribute("src");
    el.urlMeta.textContent = "";
    const tell = (secs) => { el.urlTitle.textContent = `Waking up the link service…${secs ? ` ${secs}s` : ""}`; };
    tell(0);
    const ok = await waitForServer(tell);
    el.urlInfo.classList.remove("is-loading");
    if (url !== el.url.value.trim()) return;
    if (!ok) { el.urlTitle.textContent = "The link service isn't responding right now."; return; }
  }
  infoFor = url;
  el.urlInfo.hidden = false;
  el.urlInfo.classList.add("is-loading");
  el.urlThumb.removeAttribute("src");
  el.urlTitle.textContent = "Looking up link…";
  el.urlMeta.textContent = "";
  try {
    const data = await api("/api/url/info", { url });
    if (url !== el.url.value.trim()) return;
    if (data.thumbnail) el.urlThumb.src = data.thumbnail;
    el.urlTitle.textContent = data.title || url;
    el.urlMeta.textContent = [data.site, data.uploader, clock(data.duration)].filter(Boolean).join(" · ");
    state.heights = data.heights || null;
    renderResolution();
  } catch (err) {
    if (url !== el.url.value.trim()) return;
    infoFor = "";
    el.urlTitle.textContent = err.message;
  } finally {
    el.urlInfo.classList.remove("is-loading");
  }
}

// ---- modes

function switchMode(mode) {
  if (state.busy) return;
  state.mode = mode;
  document.querySelectorAll(".mode").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", on);
  });
  document.querySelectorAll(".pane").forEach((p) => { p.hidden = p.dataset.pane !== mode; });
  state.target = null;
  resetResult();
  renderResolution();
  renderTargets();
  if (mode === "url") {
    el.url.focus();
    if (!serverOk) waitForServer();
  }
}
document.querySelectorAll(".mode").forEach((btn) => btn.addEventListener("click", () => switchMode(btn.dataset.mode)));

// ---- status panel

// Percentage readout eases toward the real value so it counts up smoothly between updates.
let shownPct = 0, targetPct = 0, pctRaf = 0;
function tickPct() {
  shownPct += (targetPct - shownPct) * 0.18;
  if (Math.abs(targetPct - shownPct) < 0.4) shownPct = targetPct;
  el.statusPct.textContent = `${Math.round(shownPct)}%`;
  pctRaf = shownPct === targetPct ? 0 : requestAnimationFrame(tickPct);
}

function showStatus(label, { progress = null, detail = "", error = false } = {}) {
  if (el.status.hidden) {
    el.status.hidden = false;
    el.status.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  el.status.classList.toggle("is-error", error);
  el.status.classList.toggle("is-indeterminate", progress === null && !error);
  el.statusText.textContent = label;
  el.statusDetail.textContent = detail || "";
  if (progress === null || error) {
    el.bar.style.width = "";
    el.statusPct.textContent = "";
    shownPct = targetPct = 0;
    cancelAnimationFrame(pctRaf); pctRaf = 0;
    return;
  }
  const pct = Math.max(0, Math.min(100, progress * 100));
  if (pct < targetPct - 0.5) shownPct = pct; // new stage started: jump back instead of counting down
  targetPct = pct;
  el.bar.style.width = `${pct}%`;
  if (!pctRaf) pctRaf = requestAnimationFrame(tickPct);
}

function resetResult() {
  el.status.hidden = true;
  el.result.hidden = true;
  el.go.hidden = false;
  el.preview.innerHTML = "";
  el.preview.hidden = true;
  if (state.zipUrl) { URL.revokeObjectURL(state.zipUrl); state.zipUrl = null; }
}

function setBusy(busy, cancel = null) {
  state.busy = busy;
  state.cancel = cancel;
  el.cancel.hidden = !cancel;
  el.drop.classList.toggle("is-disabled", busy);
  if (busy) el.go.hidden = true;                    // the progress panel takes the button's place
  else if (el.result.hidden) el.go.hidden = false;  // error / cancel: offer the button again
  state.items.forEach(paintItem);
  updateUI();
}

function showPreview(src, fmt) {
  const type = MIME[fmt] || "";
  let node = null;
  if (type.startsWith("audio/")) {
    node = document.createElement("audio");
    node.controls = true;
  } else if (type.startsWith("video/") && fmt !== "avi" && fmt !== "mkv") {
    node = document.createElement("video");
    node.controls = true; node.muted = true; node.playsInline = true; node.preload = "metadata";
  } else if (type.startsWith("image/") && fmt !== "tiff") {
    node = document.createElement("img");
    node.alt = "Preview of the converted file";
  }
  el.preview.innerHTML = "";
  if (!node) { el.preview.hidden = true; return; }
  node.src = src;
  node.addEventListener("error", () => { el.preview.hidden = true; }); // e.g. a format this browser can't play
  el.preview.appendChild(node);
  el.preview.hidden = false;
}

function finish({ href, filename, size, sameOrigin, previewSrc, fmt, note = "" }) {
  el.status.hidden = true;
  el.go.hidden = true;
  el.result.hidden = false;
  el.download.href = href;
  if (sameOrigin) el.download.download = filename; else el.download.removeAttribute("download");
  el.download.textContent = `Download ${filename}${size ? ` · ${bytesLabel(size)}` : ""}`;
  el.resultNote.textContent = note;
  el.resultNote.hidden = !note;
  if (previewSrc) showPreview(previewSrc, fmt); else { el.preview.hidden = true; el.preview.innerHTML = ""; }
}

// ---- run: files

async function runFiles() {
  const o = readOptions();
  const target = state.target;
  const items = state.items;
  const n = items.length;
  items.forEach((it) => { releaseItem(it); it.status = "idle"; it.progress = 0; it.error = null; });
  let cancelled = false;
  setBusy(true, () => { cancelled = true; cancelFFmpeg(); });

  const showLoad = (p) => showStatus("Loading converter", { progress: p, detail: "First run only · 31 MB, cached afterwards" });
  try {
    if (!wasmBlobUrl) { showLoad(loadProgress); onLoadProgress = showLoad; }
    else if (!ffmpeg) showStatus("Starting converter");
    await loadFFmpeg();
    onLoadProgress = null;

    for (let i = 0; i < n && !cancelled; i++) {
      const it = items[i];
      const label = n > 1 ? `Converting ${i + 1} of ${n}` : "Converting";
      const detail = `${it.file.name} → ${target.toUpperCase()}`;
      it.status = "running";
      paintItem(it);
      showStatus(label, { progress: i / n, detail });
      try {
        if (!ffmpeg) await loadFFmpeg(); // restarted after a failure
        const blob = await convertFile(it.file, target, o, (p) => {
          it.progress = p;
          paintItem(it);
          showStatus(label, { progress: (i + p) / n, detail });
        });
        it.blob = blob;
        it.name = `${stemOf(it.file.name)}.${target}`;
        it.url = URL.createObjectURL(blob);
        it.status = "done";
      } catch (err) {
        if (cancelled) break;
        it.status = "error";
        it.error = err.message || "Conversion failed.";
      }
      it.progress = it.status === "done" ? 1 : it.progress;
      paintItem(it);
    }
  } finally {
    onLoadProgress = null;
    setBusy(false);
  }

  if (cancelled) {
    items.forEach((it) => { if (it.status === "running") { it.status = "idle"; it.progress = 0; } paintItem(it); });
    return showStatus("Cancelled.", { error: true });
  }
  const done = items.filter((it) => it.status === "done");
  const failed = n - done.length;
  if (!done.length) {
    throw new Error(n === 1 ? items[0].error : `None of the ${n} files could be converted. See the errors above.`);
  }
  if (n === 1) {
    const it = done[0];
    return finish({ href: it.url, filename: it.name, size: it.blob.size, sameOrigin: true, previewSrc: it.url, fmt: target });
  }
  const zip = await makeZip(done.map((it) => ({ name: it.name, blob: it.blob })));
  state.zipUrl = URL.createObjectURL(zip);
  finish({
    href: state.zipUrl, filename: `converted-${target}.zip`, size: zip.size, sameOrigin: true,
    note: failed ? `${done.length} converted · ${failed} failed` : `${done.length} files converted`,
  });
  el.download.textContent = `Download all (.zip) · ${bytesLabel(zip.size)}`;
}

// ---- run: links

async function runLink() {
  const o = readOptions();
  const target = state.target;
  const body = { url: el.url.value.trim(), target, bitrate: o.bitrate, gif_fps: o.gif_fps, gif_width: o.gif_width, max_height: o.max_height };
  if (o.start != null) body.start = o.start;
  if (o.end != null) body.end = o.end;
  let cancelled = false, jobId = null;
  setBusy(true, () => {
    cancelled = true;
    if (jobId) api(`/api/jobs/${jobId}/cancel`, {}).catch(() => {}); // stop the work on the server too
  });
  showStatus("Connecting");
  try {
    await ensureServer();
    if (cancelled) return showStatus("Cancelled.", { error: true });
    const job = await api("/api/url", body);
    jobId = job.id;
    while (!cancelled) {
      const j = await api(`/api/jobs/${job.id}`);
      if (j.status === "done") {
        const base = `${serverBase()}/api/jobs/${j.id}/download`;
        return finish({ href: base, filename: j.filename, size: j.size, sameOrigin: false, previewSrc: `${base}?inline=1`, fmt: target });
      }
      if (j.status === "error") throw new Error(j.error || "Conversion failed.");
      if (j.status === "queued") showStatus("Waiting in queue", { detail: "Other conversions are running." });
      else if (j.progress === 0) showStatus("Fetching video info");
      else showStatus(j.progress < 0.7 ? "Downloading" : "Converting", { progress: j.progress, detail: j.detail || "" });
      await new Promise((r) => setTimeout(r, 700));
    }
    showStatus("Cancelled.", { error: true });
  } finally {
    setBusy(false);
  }
}

el.go.addEventListener("click", async () => {
  if (el.go.disabled) return;
  resetResult();
  if (state.mode === "url" && !el.urlThumb.getAttribute("src")) el.urlInfo.hidden = true; // avoid a duplicate error line
  try {
    await (state.mode === "file" ? runFiles() : runLink());
  } catch (err) {
    const msg = err instanceof TypeError ? "Lost connection to the link service. Try again." : err.message;
    showStatus(msg || "Conversion failed.", { error: true });
  }
});
el.cancel.addEventListener("click", () => state.cancel && state.cancel());

el.again.addEventListener("click", () => {
  resetResult();
  if (state.mode === "file") {
    state.items.forEach(releaseItem);
    state.items = [];
    state.target = null;
    renderQueue();
    el.dropSub.textContent = el.dropSub.dataset.default;
  } else {
    el.url.value = "";
    el.urlInfo.hidden = true;
    infoFor = "";
    state.heights = null;
    renderResolution();
    el.url.focus();
  }
  renderTargets();
});

// ---- boot

el.dropSub.dataset.default = el.dropSub.textContent;
renderResolution();
renderQueue();
renderTargets();
// Quietly wake a sleeping hosted link service early, so links are fast when needed.
// (Not for a local one: pinging localhost on page load makes Chrome show a permission prompt.)
if (!isLocalServer()) waitForServer();
