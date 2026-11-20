(() => {
  const $ = (id) => document.getElementById(id);
  const VIDEO = ["mp4", "webm", "mkv", "mov", "avi", "gif"];
  const AUDIO = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "aiff"];
  const LOSSY_AUDIO = ["mp3", "m4a", "aac", "ogg", "opus"];

  const state = { mode: "file", file: null, ext: null, target: null, registry: null, job: null };

  const el = {
    drop: $("drop"), fileInput: $("file-input"), dropTitle: $("drop-title"), dropSub: $("drop-sub"),
    url: $("url-input"), urlInfo: $("url-info"), urlThumb: $("url-thumb"), urlTitle: $("url-title"), urlMeta: $("url-meta"),
    targets: $("targets"), options: $("options"), go: $("go"),
    status: $("status"), bar: $("bar-fill"), statusText: $("status-text"),
    result: $("result"), download: $("download"), again: $("again"),
  };

  const extOf = (name) => {
    const m = /\.([a-z0-9]+)$/i.exec(name || "");
    if (!m) return "";
    const e = m[1].toLowerCase();
    return { jpeg: "jpg", tif: "tiff", aif: "aiff", oga: "ogg", mpg: "mpeg" }[e] || e;
  };
  const categoryOf = (ext) => {
    const inputs = state.registry?.inputs || {};
    return Object.keys(inputs).find((k) => inputs[k].includes(ext)) || null;
  };
  const bytes = (n) => {
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

  // ------------------------------------------------------------ targets & options

  function availableTargets() {
    if (!state.registry) return [];
    if (state.mode === "url") return state.registry.url;
    return state.ext ? state.registry.targets[state.ext] || [] : [];
  }

  function renderTargets() {
    const list = availableTargets();
    el.targets.innerHTML = "";
    if (!list.length) {
      el.targets.hidden = true;
      state.target = null;
      return updateUI();
    }
    if (!list.includes(state.target)) state.target = null;

    const groups = [
      ["Video", list.filter((f) => VIDEO.includes(f))],
      ["Audio", list.filter((f) => AUDIO.includes(f))],
      [state.mode === "file" && categoryOf(state.ext) === "video" ? "Still frame" : "Image",
        list.filter((f) => !VIDEO.includes(f) && !AUDIO.includes(f))],
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
      trim: (cat === "video" || cat === "audio" || cat === "url") || (cat === "image" && state.ext === "gif" && VIDEO.includes(t)),
    };
    let any = false;
    el.options.querySelectorAll(".opt").forEach((o) => {
      o.hidden = !show[o.dataset.opt];
      any ||= !o.hidden;
    });
    el.options.hidden = !t || !any;
  }

  function updateUI() {
    updateOptions();
    const ready = state.mode === "file" ? state.file && state.target : el.url.value.trim() && state.target;
    el.go.disabled = !ready || !!state.job;
    el.go.textContent = state.target ? `Convert to ${state.target.toUpperCase()}` : "Convert";
  }

  // ------------------------------------------------------------ inputs

  function setFile(file) {
    if (!file) return;
    const ext = extOf(file.name);
    resetResult();
    state.file = file;
    state.ext = ext;
    el.drop.classList.add("has-file");
    el.dropTitle.textContent = file.name;
    if (!categoryOf(ext)) {
      el.dropSub.textContent = `.${ext || "?"} files are not supported`;
      state.ext = null;
    } else {
      el.dropSub.textContent = `${bytes(file.size)} · choose a format below`;
    }
    renderTargets();
  }

  el.fileInput.addEventListener("change", () => setFile(el.fileInput.files[0]));
  ["dragenter", "dragover"].forEach((ev) => el.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    el.drop.classList.add("is-over");
  }));
  ["dragleave", "drop"].forEach((ev) => el.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    el.drop.classList.remove("is-over");
  }));
  el.drop.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));
  // Allow dropping anywhere on the page without the browser opening the file.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (state.mode === "file" && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });

  let infoTimer = null;
  let infoFor = "";
  el.url.addEventListener("input", () => {
    resetResult();
    updateUI();
    clearTimeout(infoTimer);
    infoTimer = setTimeout(loadInfo, 700);
  });

  async function loadInfo() {
    const url = el.url.value.trim();
    if (!/^https?:\/\/\S+\.\S+/.test(url) || url === infoFor) {
      if (!url) el.urlInfo.hidden = true;
      return;
    }
    infoFor = url;
    el.urlInfo.hidden = false;
    el.urlThumb.src = "";
    el.urlTitle.textContent = "Looking up link…";
    el.urlMeta.textContent = "";
    try {
      const res = await fetch("/api/url/info", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (url !== el.url.value.trim()) return;
      if (!res.ok) throw new Error(data.error || "Could not read that link.");
      el.urlThumb.src = data.thumbnail || "";
      el.urlTitle.textContent = data.title || url;
      el.urlMeta.textContent = [data.site, data.uploader, clock(data.duration)].filter(Boolean).join(" · ");
    } catch (err) {
      if (url !== el.url.value.trim()) return;
      el.urlTitle.textContent = err.message;
      el.urlMeta.textContent = "";
    }
  }

  document.querySelectorAll(".mode").forEach((btn) => btn.addEventListener("click", () => {
    if (state.job) return;
    state.mode = btn.dataset.mode;
    document.querySelectorAll(".mode").forEach((b) => {
      b.classList.toggle("is-active", b === btn);
      b.setAttribute("aria-selected", b === btn);
    });
    document.querySelectorAll(".pane").forEach((p) => { p.hidden = p.dataset.pane !== state.mode; });
    state.target = null;
    resetResult();
    renderTargets();
    if (state.mode === "url") el.url.focus();
  }));

  // ------------------------------------------------------------ conversion

  function collectOptions() {
    const out = {};
    el.options.querySelectorAll(".opt:not([hidden]) [name]").forEach((i) => {
      if (i.value !== "") out[i.name] = i.value;
    });
    return out;
  }

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
  }

  el.go.addEventListener("click", async () => {
    if (el.go.disabled) return;
    const opts = collectOptions();
    let res;
    el.go.disabled = true;
    try {
      if (state.mode === "file") {
        const form = new FormData();
        form.append("file", state.file);
        form.append("target", state.target);
        Object.entries(opts).forEach(([k, v]) => form.append(k, v));
        showStatus("Uploading…", { progress: 0 });
        res = await upload(form);
      } else {
        showStatus("Starting…");
        const r = await fetch("/api/url", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: el.url.value.trim(), target: state.target, ...opts }),
        });
        res = { ok: r.ok, data: await r.json() };
      }
      if (!res.ok) throw new Error(res.data.error || "Request failed.");
      state.job = res.data.id;
      poll();
    } catch (err) {
      showStatus(err.message, { error: true });
      state.job = null;
      updateUI();
    }
  });

  function upload(form) {
    // XHR for upload progress, which fetch can't report.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/convert");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) showStatus(`Uploading… ${Math.round((e.loaded / e.total) * 100)}%`, { progress: e.loaded / e.total });
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { data = { error: `Server error (${xhr.status}).` }; }
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, data });
      };
      xhr.onerror = () => reject(new Error("Upload failed. Check your connection."));
      xhr.send(form);
    });
  }

  async function poll() {
    const id = state.job;
    try {
      const r = await fetch(`/api/jobs/${id}`);
      if (!r.ok) throw new Error("The job was lost. Try again.");
      const job = await r.json();
      if (job.status === "done") {
        state.job = null;
        el.status.hidden = true;
        el.go.hidden = true;
        el.result.hidden = false;
        el.download.href = `/api/jobs/${id}/download`;
        el.download.textContent = `Download ${job.filename}${job.size ? ` · ${bytes(job.size)}` : ""}`;
        return updateUI();
      }
      if (job.status === "error") throw new Error(job.error || "Conversion failed.");
      const verb = state.mode === "url" ? (job.progress < 0.7 ? "Downloading" : "Converting") : "Converting";
      const pct = job.progress > 0 ? ` ${Math.round(job.progress * 100)}%` : "…";
      showStatus(job.status === "queued" ? "Waiting in queue…" : verb + pct, { progress: job.progress > 0 ? job.progress : null });
      setTimeout(poll, 700);
    } catch (err) {
      state.job = null;
      showStatus(err.message, { error: true });
      updateUI();
    }
  }

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

  // ------------------------------------------------------------ boot

  el.dropSub.dataset.default = el.dropSub.textContent;
  fetch("/api/formats").then((r) => r.json()).then((reg) => {
    state.registry = reg;
    renderTargets();
  });
  updateUI();
})();
