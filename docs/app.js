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

function loadFFmpeg() {
  if (ffmpegReady) return ffmpegReady;
  ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => logSink && logSink(message));
  const base = new URL("./vendor/core/", import.meta.url).href;
  ffmpegReady = ffmpeg
    .load({ coreURL: base + "ffmpeg-core.js", wasmURL: base + "ffmpeg-core.wasm" })
    .catch((err) => {
      ffmpeg = null;
      ffmpegReady = null;
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
    return bytes(await runFFmpeg(file, (i) => [...trimIn(o), "-i", i, "-map", "0:v:0", "-map", "0:a:0?", ...trimOut(o), "-vf", EVEN, ...VIDEO_ARGS[fmt]], out, { trim, onProgress }));
  }
  if (AUDIO_OUT.includes(fmt)) {
    return bytes(await runFFmpeg(file, (i) => [...trimIn(o), "-i", i, "-map", "0:a:0", "-vn", ...trimOut(o), ...AUDIO_ARGS[fmt](o.bitrate)], out, { trim, onProgress }));
  }
  if (FRAME_OUT.includes(fmt)) {
    return bytes(await runFFmpeg(file, (i) => [...trimIn(o), "-i", i, "-frames:v", "1", "-update", "1", ...(fmt === "jpg" ? ["-q:v", "2"] : [])], out, { onProgress }));
  }
  throw new ConversionError(`Cannot convert .${ext} to .${fmt}.`);
}

// ------------------------------------------------------------ UI

const state = { mode: "file", file: null, ext: null, target: null, busy: false, cancel: null, objectUrl: null };

const el = {
  drop: $("drop"), fileInput: $("file-input"), dropTitle: $("drop-title"), dropSub: $("drop-sub"),
  url: $("url-input"), urlInfo: $("url-info"), urlThumb: $("url-thumb"), urlTitle: $("url-title"), urlMeta: $("url-meta"),
  server: $("server-input"), serverDot: $("server-dot"), serverHint: $("server-hint"),
  targets: $("targets"), options: $("options"), go: $("go"),
  status: $("status"), bar: $("bar-fill"), statusText: $("status-text"), cancel: $("cancel"),
  result: $("result"), download: $("download"), again: $("again"),
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

function availableTargets() {
  if (state.mode === "url") return URL_OUT;
  return state.ext ? targetsFor(state.ext) : [];
}

function renderTargets() {
  const list = availableTargets();
  el.targets.innerHTML = "";
  if (!list.length) { el.targets.hidden = true; state.target = null; return updateUI(); }
  if (!list.includes(state.target)) state.target = null;
  const groups = [
    ["Video", list.filter((f) => VIDEO_OUT.includes(f))],
    ["Audio", list.filter((f) => AUDIO_OUT.includes(f))],
    [state.mode === "file" && categoryOf(state.ext) === "video" ? "Still frame" : "Image",
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
      b.addEventListener("click", () => { state.target = f; renderTargets(); });
      chips.appendChild(b);
    }
    el.targets.appendChild(wrap);
  }
  el.targets.hidden = false;
  updateUI();
}

function updateOptions() {
  const t = state.target;
  const cat = state.mode === "url" ? "url" : categoryOf(state.ext);
  const show = {
    bitrate: LOSSY_AUDIO.includes(t),
    quality: cat === "image" && (t === "jpg" || t === "webp"),
    gif: t === "gif" && cat !== "image",
    trim: ["video", "audio", "url"].includes(cat) || (cat === "image" && state.ext === "gif" && VIDEO_OUT.includes(t)),
  };
  let any = false;
  el.options.querySelectorAll(".opt").forEach((o) => { o.hidden = !show[o.dataset.opt]; any ||= !o.hidden; });
  el.options.hidden = !t || !any;
}

function updateUI() {
  updateOptions();
  const ready = state.mode === "file" ? state.file && state.target : el.url.value.trim() && state.target;
  el.go.disabled = !ready || state.busy;
  el.go.textContent = state.target ? `Convert to ${state.target.toUpperCase()}` : "Convert";
}

function readOptions() {
  const v = (n) => el.options.querySelector(`.opt:not([hidden]) [name=${n}]`)?.value ?? "";
  const num = (n) => (v(n) === "" ? null : Number(v(n)));
  const o = {
    bitrate: v("bitrate") || "192k",
    quality: Math.min(100, Math.max(1, num("quality") ?? 90)),
    gif_fps: Math.min(50, Math.max(1, num("gif_fps") ?? 12)),
    gif_width: Math.min(1920, Math.max(0, num("gif_width") ?? 480)),
    start: num("start"),
    end: num("end"),
  };
  if ([o.start, o.end].some((x) => x != null && (!Number.isFinite(x) || x < 0)))
    throw new ConversionError("Start and End must be positive numbers of seconds.");
  if (o.start != null && o.end != null && o.end <= o.start)
    throw new ConversionError("End time must be after the start time.");
  return o;
}

// ---- file input

function setFile(file) {
  if (!file) return;
  resetResult();
  state.file = file;
  state.ext = extOf(file.name);
  el.drop.classList.add("has-file");
  el.dropTitle.textContent = file.name;
  if (!categoryOf(state.ext)) {
    el.dropSub.textContent = `.${state.ext || "?"} files are not supported`;
    state.ext = null;
  } else {
    const big = file.size > 1.5 * 1024 ** 3 ? " · very large files may exceed browser memory" : "";
    el.dropSub.textContent = `${bytesLabel(file.size)} · choose a format below${big}`;
  }
  renderTargets();
  loadFFmpeg().catch(() => {}); // warm up while the user picks a format
}

el.fileInput.addEventListener("change", () => setFile(el.fileInput.files[0]));
["dragenter", "dragover"].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add("is-over"); }));
["dragleave", "drop"].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove("is-over"); }));
el.drop.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  if (state.mode === "file" && !state.busy && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});

// ---- link server

const DEFAULT_SERVER = "http://127.0.0.1:5000";
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
el.server.value = store.get("linkServer") || DEFAULT_SERVER;
const serverBase = () => el.server.value.trim().replace(/\/+$/, "");

async function api(path, body) {
  const res = await fetch(serverBase() + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(data.error || `Link server error (${res.status}).`);
  return data;
}

let serverOk = false;
async function checkServer() {
  el.serverDot.className = "dot";
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(serverBase() + "/api/formats", { signal: ctl.signal });
    clearTimeout(timer);
    serverOk = res.ok;
  } catch {
    serverOk = false;
  }
  el.serverDot.className = "dot " + (serverOk ? "is-ok" : "is-bad");
  el.serverDot.title = serverOk ? "Link server connected" : "Link server not reachable";
  el.serverHint.hidden = serverOk;
  return serverOk;
}
el.server.addEventListener("change", () => { store.set("linkServer", serverBase()); checkServer(); });

let infoTimer = null, infoFor = "";
el.url.addEventListener("input", () => {
  resetResult();
  updateUI();
  clearTimeout(infoTimer);
  infoTimer = setTimeout(loadInfo, 700);
});

async function loadInfo() {
  const url = el.url.value.trim();
  if (!/^https?:\/\/\S+\.\S+/.test(url) || url === infoFor) { if (!url) el.urlInfo.hidden = true; return; }
  if (!serverOk && !(await checkServer())) return;
  infoFor = url;
  el.urlInfo.hidden = false;
  el.urlThumb.src = "";
  el.urlTitle.textContent = "Looking up link…";
  el.urlMeta.textContent = "";
  try {
    const data = await api("/api/url/info", { url });
    if (url !== el.url.value.trim()) return;
    el.urlThumb.src = data.thumbnail || "";
    el.urlTitle.textContent = data.title || url;
    el.urlMeta.textContent = [data.site, data.uploader, clock(data.duration)].filter(Boolean).join(" · ");
  } catch (err) {
    if (url !== el.url.value.trim()) return;
    infoFor = "";
    el.urlTitle.textContent = err.message;
  }
}

// ---- modes

document.querySelectorAll(".mode").forEach((btn) => btn.addEventListener("click", () => {
  if (state.busy) return;
  state.mode = btn.dataset.mode;
  document.querySelectorAll(".mode").forEach((b) => { b.classList.toggle("is-active", b === btn); b.setAttribute("aria-selected", b === btn); });
  document.querySelectorAll(".pane").forEach((p) => { p.hidden = p.dataset.pane !== state.mode; });
  state.target = null;
  resetResult();
  renderTargets();
  if (state.mode === "url") { el.url.focus(); checkServer(); }
}));

// ---- run

function showStatus(text, { progress = null, error = false } = {}) {
  el.status.hidden = false;
  el.status.classList.toggle("is-error", error);
  el.status.classList.toggle("is-indeterminate", progress === null && !error);
  el.bar.style.width = progress === null ? "" : `${Math.round(progress * 100)}%`;
  el.statusText.textContent = text;
}

function resetResult() {
  el.status.hidden = true;
  el.result.hidden = true;
  el.go.hidden = false;
  if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
}

function finish(href, filename, size, sameOrigin) {
  el.status.hidden = true;
  el.go.hidden = true;
  el.result.hidden = false;
  el.download.href = href;
  if (sameOrigin) el.download.download = filename; else el.download.removeAttribute("download");
  el.download.textContent = `Download ${filename}${size ? ` · ${bytesLabel(size)}` : ""}`;
}

function setBusy(busy, cancel = null) {
  state.busy = busy;
  state.cancel = cancel;
  el.cancel.hidden = !cancel;
  updateUI();
}

async function runFile() {
  const o = readOptions();
  const target = state.target;
  const stem = state.file.name.replace(/\.[^.]+$/, "") || "converted";
  let cancelled = false;
  setBusy(true, () => { cancelled = true; cancelFFmpeg(); });
  showStatus(ffmpeg ? "Converting…" : "Loading converter (first time only)…");
  try {
    await loadFFmpeg();
    if (cancelled) return;
    showStatus("Converting…");
    const blob = await convertFile(state.file, target, o, (p) => showStatus(`Converting ${Math.round(p * 100)}%`, { progress: p }));
    state.objectUrl = URL.createObjectURL(blob);
    finish(state.objectUrl, `${stem}.${target}`, blob.size, true);
  } catch (err) {
    if (cancelled) showStatus("Cancelled.", { error: true });
    else throw err;
  } finally {
    setBusy(false);
  }
}

async function runLink() {
  const o = readOptions();
  if (!(await checkServer())) throw new Error(`No link server at ${serverBase()}. Start one with "python app.py", or enter another address.`);
  const body = { url: el.url.value.trim(), target: state.target, bitrate: o.bitrate, gif_fps: o.gif_fps, gif_width: o.gif_width };
  if (o.start != null) body.start = o.start;
  if (o.end != null) body.end = o.end;
  let cancelled = false;
  setBusy(true, () => { cancelled = true; });
  showStatus("Starting…");
  try {
    const job = await api("/api/url", body);
    while (!cancelled) {
      const j = await api(`/api/jobs/${job.id}`);
      if (j.status === "done") {
        return finish(`${serverBase()}/api/jobs/${j.id}/download`, j.filename, j.size, false);
      }
      if (j.status === "error") throw new Error(j.error || "Conversion failed.");
      const verb = j.progress < 0.7 ? "Downloading" : "Converting";
      showStatus(j.status === "queued" ? "Waiting in queue…" : `${verb}${j.progress > 0 ? ` ${Math.round(j.progress * 100)}%` : "…"}`,
        { progress: j.progress > 0 ? j.progress : null });
      await new Promise((r) => setTimeout(r, 700));
    }
    showStatus("Stopped watching. The link server may still finish the job.", { error: true });
  } finally {
    setBusy(false);
  }
}

el.go.addEventListener("click", async () => {
  if (el.go.disabled) return;
  resetResult();
  if (state.mode === "url" && !el.urlThumb.getAttribute("src")) el.urlInfo.hidden = true; // avoid a duplicate error line
  try {
    await (state.mode === "file" ? runFile() : runLink());
  } catch (err) {
    const msg = err instanceof TypeError ? `Could not reach the link server at ${serverBase()}.` : err.message;
    showStatus(msg || "Conversion failed.", { error: true });
  }
});
el.cancel.addEventListener("click", () => state.cancel && state.cancel());

el.again.addEventListener("click", () => {
  resetResult();
  if (state.mode === "file") {
    state.file = null; state.ext = null; state.target = null;
    el.fileInput.value = "";
    el.drop.classList.remove("has-file");
    el.dropTitle.textContent = "Drop a file, or click to choose";
    el.dropSub.textContent = el.dropSub.dataset.default;
  }
  renderTargets();
});

el.dropSub.dataset.default = el.dropSub.textContent;
renderTargets();
