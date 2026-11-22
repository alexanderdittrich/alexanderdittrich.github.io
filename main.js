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
  static FIRE_INTERVAL = 2600; // ms between pulses (on average)
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
    this.lastWidth = 0;
    this.nextFire = 0;
    this.frame = this.frame.bind(this);

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

    // Mobile browsers fire "resize" when the address bar shows or hides.
    // Only reseed when the width actually changes.
    if (force || width !== this.lastWidth) {
      this.lastWidth = width;
      const t = Math.min(Math.max((width - 320) / (1920 - 320), 0), 1);
      this.count = Math.round(22 + t * 43);
      this.maxDistance = Math.round(120 + t * 110);
      this.seed();
    } else {
      this.particles.forEach((p) => { p.y = Math.min(p.y, height); });
    }

    if (!this.running) this.draw();
  }

  makeParticle(x, y) {
    return {
      x, y,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      radius: 1.2 + Math.random() * 1.8,
      energy: 0,  // > 0 right after receiving a pulse
      scale: 1,   // used for fading in
      born: 0,
    };
  }

  seed() {
    const now = performance.now();
    this.particles = [];
    this.pulses = [];
    this.ripples = [];
    this.glow.clear();
    for (let i = 0; i < this.count; i++) {
      const p = this.makeParticle(Math.random() * this.width, Math.random() * this.height);
      p.scale = 0;
      p.born = now + Math.random() * 1200; // gentle fade-in on load
      this.particles.push(p);
    }
    this.nextFire = now + 2000;
  }

  bindEvents() {
    window.addEventListener('resize', () => this.resize(false));

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

    // Follow light/dark mode changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
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
    if (this.pulses.length >= 12) return;
    const source = this.particles[from];
    if (source) source.energy = 1; // the sender flashes
    this.pulses.push({ from, to, t: 0, start: performance.now(), hops });
  }

  addNode(x, y) {
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
      .forEach(({ j }) => this.sendPulse(index, j, 0));
    if (!this.running) this.draw();
  }

  update(now) {
    const { particles } = this;

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > this.width) p.vx *= -1;
      if (p.y < 0 || p.y > this.height) p.vy *= -1;
      p.x = Math.max(0, Math.min(this.width, p.x));
      p.y = Math.max(0, Math.min(this.height, p.y));
      p.energy *= 0.97;
      if (p.born) {
        const progress = Math.min(Math.max((now - p.born) / 900, 0), 1);
        p.scale = 1 - Math.pow(1 - progress, 3);
        if (progress === 1) p.born = 0;
      }
    }

    // Occasionally a node sends a pulse to one neighbour
    if (now > this.nextFire) {
      const i = Math.floor(Math.random() * particles.length);
      const options = this.neighbors[i] || [];
      if (options.length && !particles[i].born) {
        this.sendPulse(i, options[Math.floor(Math.random() * options.length)], 1);
      }
      this.nextFire = now + NetworkAnimation.FIRE_INTERVAL * (0.5 + Math.random());
    }

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
      // Sometimes the message is passed on once more
      if (pulse.hops > 0 && Math.random() < 0.5) {
        const next = (this.neighbors[pulse.to] || []).filter((j) => j !== pulse.from);
        if (next.length) this.sendPulse(pulse.to, next[Math.floor(Math.random() * next.length)], pulse.hops - 1);
      }
      return false;
    });

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
        if (dSq >= maxSq) continue;
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
        if (d < maxDistance) {
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
 * Start
 * ------------------------------------------------------------------------ */

const canvas = document.getElementById('network-canvas');
if (canvas && canvas.getContext) new NetworkAnimation(canvas);
initVideos();
