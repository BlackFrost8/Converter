// Drifting cyan motes: small points of light that rise slowly through the dark.
(() => {
  const canvas = document.getElementById("motes");
  const ctx = canvas.getContext("2d");
  let width = 0, height = 0, dpr = 1;
  let motes = [];

  const rand = (min, max) => min + Math.random() * (max - min);

  function makeMote(anywhere) {
    const depth = Math.random();               // 0 = far, 1 = near
    return {
      x: rand(0, width),
      y: anywhere ? rand(0, height) : height + rand(4, 40),
      r: 0.6 + depth * 1.8,                    // radius in CSS px
      speed: 6 + depth * 14,                   // px per second, upward
      alpha: 0.22 + depth * 0.6,
      swayAmp: rand(4, 16),                    // horizontal drift
      swayFreq: rand(0.05, 0.16),
      phase: rand(0, Math.PI * 2),
      twinkle: rand(0.15, 0.45),
      baseX: 0,
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const target = Math.round((width * height) / 16000);
    const count = Math.max(30, Math.min(target, 160));
    while (motes.length < count) {
      const m = makeMote(true);
      m.baseX = m.x;
      motes.push(m);
    }
    motes.length = count;
  }

  let last = performance.now();
  let clock = 0;

  function frame(now) {
    // Clamp the step so a backgrounded tab doesn't make everything jump.
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    clock += dt;

    ctx.clearRect(0, 0, width, height);
    for (const m of motes) {
      m.y -= m.speed * dt;
      if (m.y < -10) {
        Object.assign(m, makeMote(false));
        m.baseX = m.x;
      }
      const x = m.baseX + Math.sin(clock * m.swayFreq * Math.PI * 2 + m.phase) * m.swayAmp;
      const flicker = 0.75 + 0.25 * Math.sin(clock * m.twinkle * Math.PI * 2 + m.phase);
      // Fade in near the bottom edge and out near the top.
      const edge = Math.min(1, m.y / 80, (height - m.y) / 60 + 0.3);
      const a = Math.max(0, m.alpha * flicker * edge);

      // soft halo
      const halo = ctx.createRadialGradient(x, m.y, 0, x, m.y, m.r * 4);
      halo.addColorStop(0, `rgba(64, 200, 208, ${a * 0.35})`);
      halo.addColorStop(1, "rgba(64, 200, 208, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, m.y, m.r * 4, 0, Math.PI * 2);
      ctx.fill();

      // core
      ctx.fillStyle = `rgba(52, 150, 160, ${a})`;
      ctx.beginPath();
      ctx.arc(x, m.y, m.r, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame((t) => { last = t; frame(t); });
})();
