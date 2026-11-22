/*
 * alexanderdittrich.org
 * - Quiet particle network in the hero
 * - Project videos that only play while visible
 */

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* --------------------------------------------------------------------------
 * Spiking neural network
 * Drifting neurons, connected to their neighbours by synapses. Each neuron
 * collects incoming spikes (its potential slowly leaks away); the more charged
 * it is, the likelier it fires: a short flash, then a brief rest. Its spike
 * travels along a few synapses to its neighbours. Now and then a neuron fires
 * on its own. Homeostasis keeps the overall activity calm: a neuron that just
 * fired is harder to excite for a while, and the network damps itself when busy.
 * Hebbian learning: a synapse whose spike helps a neuron fire gets stronger
 * (drawn thicker), so often-used paths stand out; unused ones fade back.
 * The cursor gently charges nearby neurons; clicking (or tapping) adds a neuron.
 * The tensegrity robot is a stimulus: neurons it touches while it moves charge up
 * and fire (the network itself just passes behind the robot).
 * Colors come from the CSS variables --net-node and --net-accent.
 * ------------------------------------------------------------------------ */

class NetworkAnimation {
  static SPONTANEOUS = 1500;   // ms between spontaneous spikes (on average)
  static MAX_PULSES = 28;      // spikes travelling at the same time
  static FAN_OUT = 2;          // synapses a firing neuron sends its spike along
  static SIGNAL_SPEED = 0.3;   // px per ms a spike travels
  static RIPPLE_TIME = 900;    // ms for the ring around a firing neuron
  static REFRACTORY = 800;     // ms a neuron rests after firing
  static LEAK = 0.985;         // the potential keeps this share per frame (60 fps)
  static GAIN = 1.45;          // input from a spike = synapse weight * GAIN
  static THRESHOLD_UP = 0.6;   // each spike raises the neuron's threshold by this much...
  static THRESHOLD_RELAX = 0.995; // ...and it relaxes back to 1 (per frame, ~3 s)
  static TARGET_RATE = 0.045;  // calm activity: spikes per neuron per second
  static W_BASE = 0.35;        // weight of an untrained synapse
  static W_LEARN = 0.5;        // share of the way to full strength gained per successful spike
  static W_DECAY = 0.9993;     // strengthened synapses relax back (per frame, ~1 min)
  static HOVER_CHARGE = 0.012; // potential the cursor adds per frame to neurons close by
  static ROBOT_CHARGE = 0.01;  // potential the moving robot adds per frame and px/step of its speed

  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.host = canvas.parentElement;
    this.particles = [];
    this.pulses = [];
    this.ripples = [];           // expanding rings around nodes that received a signal
    this.glow = new Map();       // edge key -> brightness, fades out
    this.weights = new Map();    // edge key -> synapse strength (only for strengthened synapses)
    this.fireTimes = [];         // recent spikes, for homeostasis
    this.neighbors = [];
    this.mouse = null;
    this.running = false;
    this.visible = true;
    this.nextFire = 0;
    this.frame = this.frame.bind(this);

    // Optional elements the network stays below and above (e.g. the cave ceiling and floor)
    this.belowEl = canvas.dataset.below ? document.querySelector(canvas.dataset.below) : null;
    this.aboveEl = canvas.dataset.above ? document.querySelector(canvas.dataset.above) : null;
    this.top = 0;
    this.bottom = Infinity;
    this.robot = null;           // where the robot is and how fast it moves (it reports this)

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
      this.density = this.count / (width * Math.max(Math.min(height, this.bottom) - this.top, 1));
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
          y = this.top + Math.random() * (Math.min(this.worldH, this.bottom) - this.top);
        } while (x < oldW && y < oldH && ++tries < 200);
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
      v: 0,             // membrane potential
      threshold: 1,     // rises after each spike, relaxes back to 1
      energy: 0,        // > 0 right after firing (flash)
      restUntil: 0,     // refractory: ignores input until then
      inputs: [],       // recent incoming spikes (for Hebbian learning)
      scale: 1,         // used for fading in
      born: 0,
    };
  }

  // The network stays below the cave ceiling and above the cave floor
  updateAvoid() {
    const h = this.host.getBoundingClientRect();
    if (this.belowEl) this.top = Math.max(0, this.belowEl.getBoundingClientRect().bottom - h.top);
    if (this.aboveEl) this.bottom = this.aboveEl.getBoundingClientRect().top - h.top;
  }

  seed() {
    const now = performance.now();
    this.particles = [];
    this.pulses = [];
    this.ripples = [];
    this.glow.clear();
    this.weights.clear();
    for (let i = 0; i < this.count; i++) {
      const x = Math.random() * this.width;
      const y = this.top + Math.random() * (Math.min(this.height, this.bottom) - this.top);
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
    // The robot (tensegrity.js) reports where it is and how fast it moves
    document.addEventListener('robotmove', (e) => { this.robot = e.detail; });

    this.host.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const rect = this.canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    });
    this.host.addEventListener('pointerleave', () => { this.mouse = null; });

    // Playful bit: clicking the background adds a node that says hello.
    // On touch screens only a tap does, so scrolling over the hero adds nothing.
    const point = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      const p = point(e);
      if (e.pointerType === 'mouse') this.addNode(p.x, p.y);
      else this.pendingTap = p;
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const p = point(e);
      if (this.pendingTap && Math.hypot(p.x - this.pendingTap.x, p.y - this.pendingTap.y) > 10) this.pendingTap = null;
    });
    this.canvas.addEventListener('pointerup', () => {
      if (this.pendingTap) this.addNode(this.pendingTap.x, this.pendingTap.y);
      this.pendingTap = null;
    });
    this.canvas.addEventListener('pointercancel', () => { this.pendingTap = null; }); // scrolling started

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

  weight(i, j) {
    return this.weights.get(this.edgeKey(i, j)) || NetworkAnimation.W_BASE;
  }

  // A neuron fires: flash, ring, rest, and spikes along a few of its synapses
  // (stronger synapses are chosen more often)
  fire(i, now) {
    const N = NetworkAnimation;
    const p = this.particles[i];
    p.v = 0;
    p.energy = 1;
    p.restUntil = now + N.REFRACTORY;
    p.threshold += N.THRESHOLD_UP;
    this.fireTimes.push(now);
    this.ripples.push({ node: i, start: now, progress: 0 });

    const options = (this.neighbors[i] || []).map((j) => ({ j, w: this.weight(i, j) }));
    for (let k = 0; k < N.FAN_OUT && options.length && this.pulses.length < N.MAX_PULSES; k++) {
      let r = Math.random() * options.reduce((sum, o) => sum + o.w, 0);
      const index = Math.max(0, options.findIndex((o) => (r -= o.w) <= 0));
      const { j } = options.splice(index, 1)[0];
      const q = this.particles[j];
      const duration = Math.max(250, Math.hypot(q.x - p.x, q.y - p.y) / N.SIGNAL_SPEED);
      this.pulses.push({ from: i, to: j, t: 0, start: now, duration });
    }
  }

  addNode(x, y) {
    y = Math.min(Math.max(y, this.top), this.bottom);
    const p = this.makeParticle(x, y);
    p.scale = 0;
    p.born = performance.now();
    this.particles.push(p);
    const index = this.particles.length - 1;
    // Connect it to its closest neighbours right away and let it fire: it says hello
    const maxSq = this.maxDistance * this.maxDistance;
    this.neighbors[index] = this.particles
      .map((q, j) => ({ j, d: (q.x - x) ** 2 + (q.y - y) ** 2 }))
      .filter(({ j, d }) => j !== index && d < maxSq)
      .sort((a, b) => a.d - b.d)
      .map(({ j }) => j);
    this.fire(index, performance.now());
    if (!this.running) this.draw();
  }

  update(now) {
    const N = NetworkAnimation;
    const { particles } = this;
    // Frame-rate independent decay (the constants are per frame at 60 fps)
    const frames = Math.min((now - (this.clock || now)) / 16.7, 4);
    this.clock = now;
    const leak = Math.pow(N.LEAK, frames);
    const fade = Math.pow(0.97, frames);
    const relaxThreshold = Math.pow(N.THRESHOLD_RELAX, frames);
    // Homeostasis: compare the activity of the last 3 s with the calm target
    this.fireTimes = this.fireTimes.filter((t) => now - t < 3000);
    const target = N.TARGET_RATE * particles.length * 3;
    const calm = Math.min(Math.max(target / Math.max(this.fireTimes.length, 1), 0.2), 1.5);

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > this.worldW) p.vx *= -1;
      if (p.y < this.top) p.vy = Math.abs(p.vy);
      p.x = Math.max(0, Math.min(this.worldW, p.x));
      p.y = Math.max(this.top, p.y);
      // Stay above the floor: glide back up (gently, in case the floor moved on resize)
      const floor = Math.min(this.worldH, this.bottom);
      if (p.y > floor) {
        p.y -= Math.min(1.5, p.y - floor);
        p.vy = -Math.abs(p.vy);
      }
      p.energy *= fade;
      p.v *= leak;
      p.threshold = 1 + (p.threshold - 1) * relaxThreshold;
      if (p.born) {
        const progress = Math.min(Math.max((now - p.born) / 900, 0), 1);
        p.scale = 1 - Math.pow(1 - progress, 3);
        if (progress === 1) p.born = 0;
      }
    }

    // The cursor charges neurons close to it, so hovering makes them fire
    if (this.mouse) {
      particles.forEach((p, i) => {
        if (p.born || now < p.restUntil) return;
        const d = Math.hypot(this.mouse.x - p.x, this.mouse.y - p.y);
        if (d < 70) p.v += N.HOVER_CHARGE * frames * (1 - d / 70);
        if (p.v >= p.threshold) this.fire(i, now);
      });
    }

    // The moving robot stimulates the neurons it touches
    const robot = this.robot;
    if (robot && robot.speed > 0.3) {
      particles.forEach((p, i) => {
        if (p.born || now < p.restUntil) return;
        const d = Math.hypot(robot.cx - p.x, robot.cy - p.y);
        if (d < robot.r) p.v += N.ROBOT_CHARGE * robot.speed * frames;
        if (p.v >= p.threshold) this.fire(i, now);
      });
    }

    // Now and then a neuron fires on its own
    if (now > this.nextFire) {
      const i = Math.floor(Math.random() * particles.length);
      if (!particles[i].born && now >= particles[i].restUntil) this.fire(i, now);
      this.nextFire = now + N.SPONTANEOUS * (0.5 + Math.random());
    }

    // Spikes travel along their synapse; on arrival they charge the receiving neuron
    const firing = [];
    this.pulses = this.pulses.filter((pulse) => {
      const b = particles[pulse.to];
      if (!particles[pulse.from] || !b) return false;
      pulse.t = Math.min((now - pulse.start) / pulse.duration, 1);
      if (pulse.t < 1) return true;

      this.glow.set(this.edgeKey(pulse.from, pulse.to), 1);
      if (now >= b.restUntil && !b.born) {
        b.v += this.weight(pulse.from, pulse.to) * N.GAIN;
        b.inputs.push({ from: pulse.from, time: now });
        // The closer to its threshold, the likelier it fires
        const chance = Math.pow(Math.min(b.v / b.threshold, 1), 2) * calm;
        if (Math.random() < chance) firing.push(pulse.to);
      }
      return false;
    });
    for (const j of firing) {
      const b = particles[j];
      if (now < b.restUntil) continue; // already fired this frame
      // Hebbian learning: the synapses that just delivered input helped it fire, so they get stronger
      for (const input of b.inputs) {
        if (now - input.time > 600) continue;
        const key = this.edgeKey(input.from, j);
        const w = this.weights.get(key) || N.W_BASE;
        this.weights.set(key, w + (1 - w) * N.W_LEARN);
      }
      b.inputs = [];
      this.fire(j, now);
    }
    for (const p of particles) if (p.inputs.length && now - p.inputs[0].time > 600) p.inputs = p.inputs.filter((x) => now - x.time <= 600);

    this.ripples = this.ripples.filter((r) => {
      r.progress = (now - r.start) / N.RIPPLE_TIME;
      return r.progress < 1;
    });

    for (const [key, g] of this.glow) {
      const next = g * fade;
      if (next < 0.02) this.glow.delete(key);
      else this.glow.set(key, next);
    }
    // Strengthened synapses slowly relax back to their base weight
    const relax = Math.pow(N.W_DECAY, frames);
    for (const [key, w] of this.weights) {
      const next = N.W_BASE + (w - N.W_BASE) * relax;
      if (next < N.W_BASE + 0.01) this.weights.delete(key);
      else this.weights.set(key, next);
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
        const key = this.edgeKey(i, j);
        const glow = this.glow.get(key) || 0;
        // Synapse strength: trained synapses are thicker and darker
        const strength = ((this.weights.get(key) || NetworkAnimation.W_BASE) - NetworkAnimation.W_BASE) / (1 - NetworkAnimation.W_BASE);
        ctx.strokeStyle = glow > 0.05
          ? `rgba(${accentColor}, ${(0.12 + glow * 0.35) * Math.max(closeness * 2, 0.5)})`
          : `rgba(${nodeColor}, ${closeness * (0.13 + strength * 0.3)})`;
        ctx.lineWidth = 0.8 + strength * 1.6;
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

    // Spikes: a small dot with a short fading tail, travelling along the synapse
    ctx.lineCap = 'round';
    for (const pulse of this.pulses) {
      const a = particles[pulse.from];
      const b = particles[pulse.to];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = pulse.t;
      const tail = Math.max(0, t - 18 / (Math.hypot(dx, dy) || 1));
      ctx.strokeStyle = `rgba(${accentColor}, 0.35)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x + dx * tail, a.y + dy * tail);
      ctx.lineTo(a.x + dx * t, a.y + dy * t);
      ctx.stroke();
      ctx.fillStyle = `rgba(${accentColor}, 0.85)`;
      ctx.beginPath();
      ctx.arc(a.x + dx * t, a.y + dy * t, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Rings around neurons that just fired
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

    // Neurons: grey; they warm up towards the accent colour as their potential builds,
    // flash when they fire and stay a little dim while they rest
    const now = this.clock || 0;
    for (const p of particles) {
      const resting = now < p.restUntil ? 0.7 : 1;
      const r = p.radius * p.scale * (1 + p.energy * 0.5);
      ctx.fillStyle = `rgba(${nodeColor}, ${0.42 * resting * p.scale})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      const warmth = Math.max(p.energy, Math.min(p.v / p.threshold, 1) * 0.6);
      if (warmth > 0.03) {
        ctx.fillStyle = `rgba(${accentColor}, ${warmth * 0.85 * p.scale})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
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
