/*
 * alexanderdittrich.org
 * - Quiet particle network in the hero
 * - Project videos that only play while visible
 */

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* --------------------------------------------------------------------------
 * Particle network
 * Quiet grey nodes that drift and connect. Now and then a node sends a
 * signal: the connection lights up towards a neighbour, which answers
 * with a small ring. The lit connection fades out slowly.
 * The cursor connects to nearby nodes; clicking adds a node.
 * Colors come from the CSS variables --net-node and --net-accent.
 * ------------------------------------------------------------------------ */

class NetworkAnimation {
  static FIRE_INTERVAL = 1600; // ms between new messages (on average)
  static MAX_PULSES = 24;      // signals travelling at the same time
  static MAX_HOPS = 2;         // how many times a message can be passed on
  static SIGNAL_TIME = 380;    // ms for a signal to cross a connection
  static RIPPLE_TIME = 900;    // ms for the ring around a receiving node

  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.host = canvas.parentElement;
    this.particles = [];
    this.pulses = [];
    this.ripples = [];           // expanding rings around nodes that received a signal
    this.glow = new Map();       // edge key -> brightness, fades out
    this.neighbors = [];
    this.mouse = null;
    this.running = false;
    this.visible = true;
    this.nextFire = 0;
    this.frame = this.frame.bind(this);

    // Optional area the network keeps out of (e.g. data-avoid=".hero-robot")
    this.avoidEl = canvas.dataset.avoid ? document.querySelector(canvas.dataset.avoid) : null;
    // Optional element the network stays below (e.g. data-below=".cave-ceiling")
    this.belowEl = canvas.dataset.below ? document.querySelector(canvas.dataset.below) : null;
    this.top = 0;
    this.avoid = null;

    this.readColors();
    this.resize(true);
    this.bindEvents();
    this.updateRunning();
  }

  readColors() {
    const style = getComputedStyle(document.documentElement);
    this.nodeColor = style.getPropertyValue('--net-node').trim() || '120, 113, 108';
    this.accentColor = style.getPropertyValue('--net-accent').trim() || '47, 91, 183';
  }

  resize(force) {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = width;
    this.height = height;
    this.updateAvoid();

    if (force || !this.worldW) {
      // First layout: size and density of the network are set once
      const t = Math.min(Math.max((width - 320) / (1920 - 320), 0), 1);
      this.count = Math.round(22 + t * 43);
      this.maxDistance = Math.round(120 + t * 110);
      this.density = this.count / (width * Math.max(height - this.top, 1));
      this.worldW = width;
      this.worldH = height;
      this.seed();
    } else if (width > this.worldW || height > this.worldH) {
      // The window grew beyond anything seen so far: extend the network into
      // the new space only. Existing nodes keep their positions and scale.
      const oldW = this.worldW, oldH = this.worldH;
      this.worldW = Math.max(oldW, width);
      this.worldH = Math.max(oldH, height);
      const extra = Math.round(this.density * (this.worldW * this.worldH - oldW * oldH));
      const now = performance.now();
      for (let i = 0; i < extra; i++) {
        let x, y, tries = 0;
        do {
          x = Math.random() * this.worldW;
          y = this.top + Math.random() * (this.worldH - this.top);
        } while ((x < oldW && y < oldH) || (this.inAvoid(x, y) && ++tries < 50));
        const p = this.makeParticle(x, y);
        p.scale = 0;
        p.born = now; // new nodes fade in
        this.particles.push(p);
      }
    }
    // When the window shrinks nothing changes: nodes outside the view are just not visible

    this.draw(); // redraw right away (resizing clears the canvas)
  }

  makeParticle(x, y) {
    return {
      x, y,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      radius: 2 + Math.random() * 2.2,
      energy: 0,  // > 0 right after receiving a pulse
      scale: 1,   // used for fading in
      born: 0,
    };
  }

  // The avoided area is a circle around the element (a round "clearing")
  updateAvoid() {
    if (this.belowEl) {
      const b = this.belowEl.getBoundingClientRect();
      const h = this.host.getBoundingClientRect();
      this.top = Math.max(0, b.bottom - h.top);
    }
    if (!this.avoidEl) return;
    const r = this.avoidEl.getBoundingClientRect();
    const h = this.host.getBoundingClientRect();
    this.avoid = r.width && r.height
      ? { cx: r.left - h.left + r.width / 2, cy: r.top - h.top + r.height / 2, r: Math.min(r.width, r.height) / 2 + 20 }
      : null;
  }

  inAvoid(x, y) {
    const a = this.avoid;
    return a && Math.hypot(x - a.cx, y - a.cy) < a.r;
  }

  // Does the segment a-b pass through the clearing?
  crossesAvoid(ax, ay, bx, by) {
    const a = this.avoid;
    if (!a) return false;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((a.cx - ax) * dx + (a.cy - ay) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(ax + t * dx - a.cx, ay + t * dy - a.cy) < a.r;
  }

  seed() {
    const now = performance.now();
    this.particles = [];
    this.pulses = [];
    this.ripples = [];
    this.glow.clear();
    for (let i = 0; i < this.count; i++) {
      let x, y, tries = 0;
      do {
        x = Math.random() * this.width;
        y = this.top + Math.random() * (this.height - this.top);
      } while (this.inAvoid(x, y) && ++tries < 50);
      const p = this.makeParticle(x, y);
      p.scale = 0;
      p.born = now + Math.random() * 1200; // gentle fade-in on load
      this.particles.push(p);
    }
    this.nextFire = now + 2000;
  }

  bindEvents() {
    window.addEventListener('resize', () => this.resize(false));
    window.addEventListener('load', () => this.updateAvoid()); // layout can shift once fonts load

    this.host.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const rect = this.canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    });
    this.host.addEventListener('pointerleave', () => { this.mouse = null; });

    // Playful bit: clicking the background adds a node that says hello
    this.canvas.addEventListener('pointerdown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.addNode(e.clientX - rect.left, e.clientY - rect.top);
    });

    new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.updateRunning();
    }).observe(this.host);
    document.addEventListener('visibilitychange', () => this.updateRunning());
    reduceMotion.addEventListener('change', () => this.updateRunning());

    // Follow light/dark mode changes (system setting or the toggle button)
    document.addEventListener('themechange', () => {
      this.readColors();
      if (!this.running) this.draw();
    });
  }

  updateRunning() {
    const shouldRun = this.visible && !document.hidden && !reduceMotion.matches;
    if (shouldRun && !this.running) {
      this.running = true;
      requestAnimationFrame(this.frame);
    } else if (!shouldRun) {
      this.running = false;
      if (reduceMotion.matches) this.particles.forEach((p) => { p.scale = 1; p.born = 0; });
      this.draw(); // leave a still frame behind
    }
  }

  frame() {
    if (!this.running) return;
    this.update(performance.now());
    this.draw();
    requestAnimationFrame(this.frame);
  }

  edgeKey(i, j) {
    return i < j ? i * 4096 + j : j * 4096 + i;
  }

  // A signal lights up the connection from one node to another
  sendPulse(from, to, hops) {
    if (this.pulses.length >= NetworkAnimation.MAX_PULSES) return;
    const source = this.particles[from];
    if (source) source.energy = 1; // the sender flashes
    this.pulses.push({ from, to, t: 0, start: this.clock || performance.now(), hops });
  }

  // Pick up to `count` different neighbours of node i, skipping some nodes
  pickNeighbors(i, count, exclude = []) {
    const options = (this.neighbors[i] || []).filter((j) => !exclude.includes(j) && this.particles[j].energy < 0.5);
    const picked = [];
    while (picked.length < count && options.length) {
      picked.push(options.splice(Math.floor(Math.random() * options.length), 1)[0]);
    }
    return picked;
  }

  addNode(x, y) {
    y = Math.max(y, this.top);
    const p = this.makeParticle(x, y);
    p.scale = 0;
    p.born = performance.now();
    p.energy = 1;
    this.particles.push(p);
    const index = this.particles.length - 1;
    // Greet up to two nearby nodes
    const maxSq = this.maxDistance * this.maxDistance;
    this.particles
      .map((q, j) => ({ j, d: (q.x - x) ** 2 + (q.y - y) ** 2 }))
      .filter(({ j, d }) => j !== index && d < maxSq)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .forEach(({ j }) => this.sendPulse(index, j, 1));
    if (!this.running) this.draw();
  }

  update(now) {
    const { particles } = this;
    this.clock = now;

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > this.worldW) p.vx *= -1;
      if (p.y < this.top || p.y > this.worldH) p.vy *= -1;
      p.x = Math.max(0, Math.min(this.worldW, p.x));
      p.y = Math.max(this.top, Math.min(this.worldH, p.y));
      if (this.inAvoid(p.x, p.y)) {
        // Glide out of the clearing (gently, so nodes never jump) and bounce off its edge
        const a = this.avoid;
        const d = Math.hypot(p.x - a.cx, p.y - a.cy) || 1;
        const nx = (p.x - a.cx) / d;
        const ny = (p.y - a.cy) / d;
        const push = Math.min(2, a.r + 0.5 - d);
        p.x += nx * push;
        p.y += ny * push;
        const dot = p.vx * nx + p.vy * ny;
        if (dot < 0) {
          p.vx -= 2 * dot * nx;
          p.vy -= 2 * dot * ny;
        }
      }
      p.energy *= 0.97;
      if (p.born) {
        const progress = Math.min(Math.max((now - p.born) / 900, 0), 1);
        p.scale = 1 - Math.pow(1 - progress, 3);
        if (progress === 1) p.born = 0;
      }
    }

    // Now and then a node sends a message to up to two neighbours
    if (now > this.nextFire) {
      const i = Math.floor(Math.random() * particles.length);
      if (!particles[i].born) {
        for (const j of this.pickNeighbors(i, 2)) this.sendPulse(i, j, NetworkAnimation.MAX_HOPS);
      }
      this.nextFire = now + NetworkAnimation.FIRE_INTERVAL * (0.5 + Math.random());
    }

    const forwarded = [];

    this.pulses = this.pulses.filter((pulse) => {
      const a = particles[pulse.from];
      const b = particles[pulse.to];
      if (!a || !b) return false;
      pulse.t = Math.min((now - pulse.start) / NetworkAnimation.SIGNAL_TIME, 1);
      if (pulse.t < 1) return true;

      // Arrival: the receiver flashes and sends out a ring; the connection stays lit for a while
      b.energy = 1;
      this.ripples.push({ node: pulse.to, start: now, progress: 0 });
      this.glow.set(this.edgeKey(pulse.from, pulse.to), 1);
      // Usually the message is passed on, to one or sometimes two neighbours
      if (pulse.hops > 0 && Math.random() < 0.75) {
        const count = Math.random() < 0.35 ? 2 : 1;
        for (const j of this.pickNeighbors(pulse.to, count, [pulse.from])) {
          forwarded.push([pulse.to, j, pulse.hops - 1]);
        }
      }
      return false;
    });
    // Send forwarded messages after the loop (adding them while filtering would lose them)
    for (const [from, to, hops] of forwarded) this.sendPulse(from, to, hops);

    this.ripples = this.ripples.filter((r) => {
      r.progress = (now - r.start) / NetworkAnimation.RIPPLE_TIME;
      return r.progress < 1;
    });

    for (const [key, g] of this.glow) {
      const next = g * 0.97;
      if (next < 0.02) this.glow.delete(key);
      else this.glow.set(key, next);
    }
  }

  draw() {
    const { ctx, particles, maxDistance, nodeColor, accentColor } = this;
    const maxSq = maxDistance * maxDistance;
    ctx.clearRect(0, 0, this.width, this.height);

    // Connections
    this.neighbors = particles.map(() => []);
    ctx.lineWidth = 1;
    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      for (let j = i + 1; j < particles.length; j++) {
        const b = particles[j];
        const dSq = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        if (dSq >= maxSq || this.crossesAvoid(a.x, a.y, b.x, b.y)) continue;
        this.neighbors[i].push(j);
        this.neighbors[j].push(i);

        const closeness = (1 - Math.sqrt(dSq) / maxDistance) * Math.min(a.scale, b.scale);
        const glow = this.glow.get(this.edgeKey(i, j)) || 0;
        ctx.strokeStyle = glow > 0.05
          ? `rgba(${accentColor}, ${0.15 + glow * 0.45})`
          : `rgba(${nodeColor}, ${closeness * 0.16})`;
        ctx.lineWidth = glow > 0.05 ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Cursor connections
    if (this.mouse) {
      for (const p of particles) {
        const d = Math.hypot(this.mouse.x - p.x, this.mouse.y - p.y);
        if (d < maxDistance && !this.crossesAvoid(p.x, p.y, this.mouse.x, this.mouse.y)) {
          ctx.strokeStyle = `rgba(${nodeColor}, ${(1 - d / maxDistance) * 0.18})`;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(this.mouse.x, this.mouse.y);
          ctx.stroke();
        }
      }
    }

    // Signals: the connection lights up from sender to receiver
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(${accentColor}, 0.65)`;
    for (const pulse of this.pulses) {
      const a = particles[pulse.from];
      const b = particles[pulse.to];
      if (!a || !b) continue;
      const t = 1 - Math.pow(1 - pulse.t, 2); // fast start, gentle arrival
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      ctx.stroke();
    }

    // Rings around nodes that just received a signal
    ctx.lineWidth = 1;
    for (const r of this.ripples) {
      const p = particles[r.node];
      if (!p) continue;
      const eased = 1 - Math.pow(1 - r.progress, 3);
      ctx.strokeStyle = `rgba(${accentColor}, ${0.5 * (1 - r.progress)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius + 3 + eased * 14, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Nodes: grey, briefly tinted after receiving a pulse
    for (const p of particles) {
      const color = p.energy > 0.05 ? accentColor : nodeColor;
      ctx.fillStyle = `rgba(${color}, ${(0.4 + p.energy * 0.4) * p.scale})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius * p.scale * (1 + p.energy * 0.4), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* --------------------------------------------------------------------------
 * Videos that play only while on screen
 * ------------------------------------------------------------------------ */

function initVideos() {
  const videos = document.querySelectorAll('video.autoplay-when-visible');
  if (!videos.length) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target;
      if (entry.isIntersecting && !reduceMotion.matches) {
        video.play().catch(() => {}); // autoplay can be blocked; the poster stays
      } else {
        video.pause();
      }
    }
  }, { threshold: 0.25 });

  videos.forEach((v) => observer.observe(v));
}

/* --------------------------------------------------------------------------
 * Light/dark toggle
 * Without a saved choice the page follows the system setting.
 * Animations listen for the "themechange" event to update their colours.
 * ------------------------------------------------------------------------ */

function initThemeToggle() {
  const button = document.querySelector('.theme-toggle');
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const current = () => root.dataset.theme || (system.matches ? 'dark' : 'light');

  const render = () => {
    const dark = current() === 'dark';
    if (button) {
      button.innerHTML = `<i class="fa-solid fa-${dark ? 'sun' : 'moon'}" aria-hidden="true"></i>`;
      const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    // Browser UI colour (e.g. the address bar on phones)
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => { meta.content = bg; });
    document.dispatchEvent(new Event('themechange'));
  };

  if (button) {
    button.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (e) { /* private mode: not remembered */ }
      render();
    });
  }
  system.addEventListener('change', render);
  render();
}

/* --------------------------------------------------------------------------
 * Hero links: hide the separator dot at the end of each wrapped line
 * ------------------------------------------------------------------------ */

function initLinkSeparators() {
  const lists = document.querySelectorAll('.hero-links');
  const update = () => {
    lists.forEach((list) => {
      const items = Array.from(list.children);
      items.forEach((li, i) => {
        const next = items[i + 1];
        li.classList.toggle('line-end', !!next && next.offsetTop > li.offsetTop);
      });
    });
  };
  update();
  let pending = false;
  window.addEventListener('resize', () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; update(); });
  });
  if (document.fonts) document.fonts.ready.then(update); // widths change once the web font loads
}

/* --------------------------------------------------------------------------
 * Start
 * ------------------------------------------------------------------------ */

const canvas = document.getElementById('network-canvas');
if (canvas && canvas.getContext) new NetworkAnimation(canvas);
initVideos();
initThemeToggle();
initLinkSeparators();
