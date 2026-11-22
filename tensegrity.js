/*
 * Interactive tensegrity robot
 * A 6-strut tensegrity icosahedron resting on the ground under gravity.
 * Struts are rigid; cables are elastic springs that can only pull, never push,
 * so the structure gives a little when it lands or is pulled.
 * Simulated in 3D with position-based dynamics, drawn with a fixed camera.
 *
 * It rests on the bottom edge of its canvas (the hero) and can be dragged, rolled
 * or thrown across the full width; the page edges act as walls. The camera follows
 * it sideways, so it looks the same everywhere.
 * Interaction: drag a node to pull the structure around, or throw it.
 * The canvas is transparent and ignores the pointer, so whatever lies behind it
 * stays clickable; the robot listens on the canvas's parent instead.
 * Colors come from the CSS variables --net-node and --net-accent.
 */

class TensegrityRobot {
  static PHI = (1 + Math.sqrt(5)) / 2;
  static STRUT_LENGTH = 2 * TensegrityRobot.PHI;
  static CABLE_REST = 1.72;       // shorter than the geometric 2.0 -> pretension
  static CABLE_SPRING = 0.15;     // spring strength of the cables (lower = softer, more give)
  static DRAG_FOLLOW = 0.06;      // how quickly a dragged node follows the pointer (per iteration)
  static STEP = 1000 / 60;        // fixed simulation step in ms, independent of screen refresh rate
  static ITERATIONS = 12;
  static DAMPING = 0.96;
  static AIR_DAMPING = 0.995;      // while fully in the air (drop-in or thrown): almost no air resistance
  static DROP_SIDE = -1.3;         // it starts above the top edge, this far to the left of its resting spot
  static DROP_DELAY = 350;         // ms before it starts falling
  static LANDING = 0.3;            // share of the sideways speed kept at the drop-in touchdown
  static SETTLE_DAMPING = 0.88;    // extra damping right after a thrown robot touches down
  static SETTLE_STEPS = 70;        // ...for this many steps (~1 s)
  static MAX_THROW = 0.1;          // top speed of a thrown robot (model units per step), keeps it near the screen
  static DROP_SPIN = 0.015;        // slow spin around the vertical axis while falling (rad per step)
  static GRAVITY = 0.0015;        // model units per step^2 (low = slow, calm tipping)
  static FRICTION = 0.35;         // share of sliding velocity removed on ground contact
  static GRIP = 1;                // static friction: feet on the ground stay exactly in place
  static CAMERA = 9;              // camera distance in model units
  static YAW = 0.55;
  static PITCH = -0.14;           // camera looks slightly down onto the ground
  static MAX_SCALE = 64;          // pixels per model unit: the robot's fixed on-screen size
  static DEPTH = 2.4;             // the ground is a narrow strip: nodes stay within +-DEPTH front to back
  static GROUND_GAP = 22;         // px between the canvas bottom and the middle of the ground strip:
                                  // the back of the strip meets the sketched floor line (.hero-floor),
                                  // the front nodes stand a little lower, on the shaded floor

  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dragged = null;
    this.hoverNode = -1;
    this.visible = true;
    this.running = false;
    this.frame = this.frame.bind(this);

    this.host = canvas.parentElement;
    this.hint = this.host.querySelector('.robot-hint');
    // Element marking where the robot rests at first (e.g. data-home=".hero-robot")
    this.homeEl = canvas.dataset.home ? document.querySelector(canvas.dataset.home) : null;
    this.cx = 0;                 // the robot's centre along the ground (the camera follows it)
    this.minX = -Infinity;       // walls at the canvas edges, set in resize()
    this.maxX = Infinity;

    this.readColors();
    this.build();
    this.resize();
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) this.dropIn();
    else this.moveBy(this.homeX(), 0);
    this.bindEvents();
    this.updateRunning();
  }

  /* ---------- geometry ---------- */

  build() {
    const PHI = TensegrityRobot.PHI;
    this.nodes = [];
    const add = (x, y, z, family, end, side) =>
      this.nodes.push({ p: [x, y, z], q: [x, y, z], family, end, side });
    // Three families of parallel strut pairs, along z, x and y
    for (const s of [-1, 1]) {
      for (const e of [-1, 1]) {
        add(0, s, e * PHI, 0, e, s);
        add(e * PHI, 0, s, 1, e, s);
        add(s, e * PHI, 0, 2, e, s);
      }
    }

    this.struts = [];
    this.cables = [];
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const a = this.nodes[i], b = this.nodes[j];
        if (a.family === b.family && a.side === b.side && a.end !== b.end) {
          this.struts.push({ a: i, b: j });
        } else if (Math.abs(this.dist(a.p, b.p) - 2) < 1e-6 && !(a.family === b.family && a.end === b.end)) {
          this.cables.push({ a: i, b: j });
        }
      }
    }

    // Tilt it a little, drop it onto the ground and let it settle before showing it
    const tilt = 0.35;
    for (const n of this.nodes) {
      const [x, y, z] = n.p;
      n.p = [x, Math.cos(tilt) * y - Math.sin(tilt) * z, Math.sin(tilt) * y + Math.cos(tilt) * z];
    }
    const minY = Math.min(...this.nodes.map((n) => n.p[1]));
    for (const n of this.nodes) {
      n.p[1] += 0.3 - minY;
      n.q = n.p.slice();
    }
    for (let k = 0; k < 500; k++) this.step();

    // Centre it
    const cx = this.nodes.reduce((sum, n) => sum + n.p[0], 0) / this.nodes.length;
    const cz = this.nodes.reduce((sum, n) => sum + n.p[2], 0) / this.nodes.length;
    this.moveBy(-cx, -cz);
  }

  // Shift the whole robot along the ground (rigidly, keeping its motion)
  moveBy(dx, dz) {
    for (const n of this.nodes) {
      n.p[0] += dx; n.q[0] += dx;
      n.p[2] += dz; n.q[2] += dz;
    }
    this.cx += dx;
  }

  // Resting spot along the ground: below the middle of the home element
  homeX() {
    if (!this.homeEl || !this.scale) return 0;
    const r = this.homeEl.getBoundingClientRect();
    const c = this.canvas.getBoundingClientRect();
    return (r.left + r.width / 2 - c.left - this.width / 2) / this.scale;
  }

  // Lift the settled robot above the top edge (a little to the left of its resting spot) so it
  // flies in on an arc at page load, spinning slowly around its vertical axis, and lands on its
  // elastic cables
  dropIn() {
    const T = TensegrityRobot;
    this.moveBy(this.homeX() + T.DROP_SIDE, 0);
    const cx = this.cx;
    const cz = this.nodes.reduce((sum, n) => sum + n.p[2], 0) / this.nodes.length;
    const height = this.originY / this.scale + 0.3; // lowest node starts just above the top edge
    // sideways speed so that the arc ends at the resting spot
    const fallSteps = Math.sqrt((2 * height) / T.GRAVITY);
    const vx = -T.DROP_SIDE / fallSteps;
    for (const n of this.nodes) {
      n.p[1] += height;
      const rx = n.p[0] - cx, rz = n.p[2] - cz;
      // previous position set so that the node already moves sideways and along the spin
      n.q = [n.p[0] + T.DROP_SPIN * rz - vx, n.p[1], n.p[2] - T.DROP_SPIN * rx];
    }
    this.dropping = true;
    this.dropAt = performance.now() + T.DROP_DELAY;
  }

  dist(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  /* ---------- physics ---------- */

  step() {
    const T = TensegrityRobot;

    // Feet touching the ground at the start of the step (for static friction)
    const feet = this.nodes.filter((n) => n.p[1] < 0.001).map((n) => ({ n, x: n.p[0], z: n.p[2] }));

    // Verlet integration with gravity
    // In the air it falls freely (same gravity feel as the drop-in); on the ground or while
    // held, the stronger damping keeps tipping and dragging calm
    const airborne = this.dropping || (!this.dragged && feet.length === 0);
    // Touching down after a throw: settle with the same soft landing as after the drop-in
    if (!airborne && !this.dragged && this.airSteps > 15) this.settleSteps = T.SETTLE_STEPS;
    this.airSteps = airborne && !this.dropping ? (this.airSteps || 0) + 1 : 0;
    const damping = airborne ? T.AIR_DAMPING : this.settleSteps > 0 ? T.SETTLE_DAMPING : T.DAMPING;
    if (this.settleSteps > 0) this.settleSteps--;
    for (const n of this.nodes) {
      const v = [0, 1, 2].map((k) => (n.p[k] - n.q[k]) * damping);
      n.q = n.p.slice();
      n.p = [n.p[0] + v[0], n.p[1] + v[1] - T.GRAVITY, n.p[2] + v[2]];
    }

    // Cables: elastic springs that pull only when stretched (applied once per step,
    // so they can stretch under load instead of being forced back to length)
    for (const c of this.cables) {
      const a = this.nodes[c.a].p, b = this.nodes[c.b].p;
      const d = this.dist(a, b);
      if (d <= T.CABLE_REST) continue;
      const pull = ((d - T.CABLE_REST) / d) * T.CABLE_SPRING * 0.5;
      for (let k = 0; k < 3; k++) {
        const delta = (b[k] - a[k]) * pull;
        a[k] += delta;
        b[k] -= delta;
      }
    }

    for (let it = 0; it < T.ITERATIONS; it++) {
      // Struts: rigid length
      for (const s of this.struts) {
        const a = this.nodes[s.a].p, b = this.nodes[s.b].p;
        const d = this.dist(a, b) || 1e-6;
        const corr = ((d - T.STRUT_LENGTH) / d) * 0.5;
        for (let k = 0; k < 3; k++) {
          const delta = (b[k] - a[k]) * corr;
          a[k] += delta;
          b[k] -= delta;
        }
      }
      // The dragged node follows the pointer
      if (this.dragged) {
        const n = this.nodes[this.dragged.index];
        for (let k = 0; k < 3; k++) n.p[k] += (this.dragged.target[k] - n.p[k]) * T.DRAG_FOLLOW;
      }
      // Ground (flat), the page edges as walls, and the narrow ground strip front to back
      for (const n of this.nodes) {
        if (n.p[1] < 0) n.p[1] = 0;
        n.p[0] = Math.min(Math.max(n.p[0], this.minX), this.maxX);
        n.p[2] = Math.min(Math.max(n.p[2], -T.DEPTH), T.DEPTH);
      }
      // Static friction: feet that stay on the ground do not slide
      for (const f of feet) {
        if (f.n.p[1] > 0.001) continue; // lifted off, e.g. while tipping over
        f.n.p[0] += (f.x - f.n.p[0]) * T.GRIP;
        f.n.p[2] += (f.z - f.n.p[2]) * T.GRIP;
      }
    }

    // The camera follows the robot's centre; front to back it is gently kept in the middle
    // of the ground strip (a rigid shift, so the structure is not squeezed)
    this.cx = this.nodes.reduce((sum, n) => sum + n.p[0], 0) / this.nodes.length;
    const cz = this.nodes.reduce((sum, n) => sum + n.p[2], 0) / this.nodes.length;
    for (const n of this.nodes) { n.p[2] -= cz * 0.02; n.q[2] -= cz * 0.02; }

    // Drop-in: at touchdown the fall simply ends and the elastic cables take the impact
    // (the robot squashes and springs back). Only the body's sideways drift is braked,
    // so it does not roll away.
    if (this.dropping && this.nodes.some((n) => n.p[1] <= 0.001)) {
      this.dropping = false;
      const v = [0, 2].map((k) => this.nodes.reduce((sum, n) => sum + n.p[k] - n.q[k], 0) / this.nodes.length);
      for (const n of this.nodes) {
        n.q[0] += v[0] * (1 - T.LANDING);
        n.q[2] += v[1] * (1 - T.LANDING);
      }
    }

    // Friction for nodes touching the ground
    for (const n of this.nodes) {
      if (n.p[1] < 0.001) {
        n.q[0] += (n.p[0] - n.q[0]) * T.FRICTION;
        n.q[2] += (n.p[2] - n.q[2]) * T.FRICTION;
      }
    }
  }

  /* ---------- camera ---------- */

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // One fixed size; only very narrow screens get a slightly smaller robot
    this.scale = Math.min(this.width / 7.3, TensegrityRobot.MAX_SCALE);
    this.originY = this.height - TensegrityRobot.GROUND_GAP; // the ground line
    // Walls at the canvas edges (nodes keep a small margin, so they never get cut off)
    const half = (this.width / 2 - 20) / this.scale;
    this.minX = -half;
    this.maxX = half;
    // After the window got narrower, push the robot back inside
    const cx = this.nodes.reduce((sum, n) => sum + n.p[0], 0) / this.nodes.length;
    if (Math.abs(cx) > half - 1.9) this.moveBy(Math.sign(cx) * (half - 1.9) - cx, 0);
    this.draw(); // redraw right away (resizing clears the canvas)
  }

  toView(p) {
    const T = TensegrityRobot;
    const cy = Math.cos(T.YAW), sy = Math.sin(T.YAW), cp = Math.cos(T.PITCH), sp = Math.sin(T.PITCH);
    const x = p[0], y = p[1] - 1.5, z = p[2]; // look at a point 1.5 units above the ground
    const x1 = cy * x + sy * z;
    const z1 = -sy * x + cy * z;
    return [x1, cp * y - sp * z1, sp * y + cp * z1];
  }

  fromView(v) {
    const T = TensegrityRobot;
    const cy = Math.cos(T.YAW), sy = Math.sin(T.YAW), cp = Math.cos(T.PITCH), sp = Math.sin(T.PITCH);
    const y1 = cp * v[1] + sp * v[2];
    const z1 = -sp * v[1] + cp * v[2];
    return [cy * v[0] - sy * z1, y1 + 1.5, sy * v[0] + cy * z1];
  }

  // The camera moves along with the robot: perspective is taken around the robot's
  // centre, and that centre maps linearly onto the screen
  project(p) {
    const v = this.toView([p[0] - this.cx, p[1], p[2]]);
    const s = this.scale * TensegrityRobot.CAMERA / (TensegrityRobot.CAMERA - v[2]);
    const centerY = this.originY - 1.5 * this.scale * Math.cos(TensegrityRobot.PITCH);
    return { x: this.width / 2 + this.cx * this.scale + v[0] * s, y: centerY - v[1] * s, z: v[2], s };
  }

  unproject(x, y, z) {
    const s = this.scale * TensegrityRobot.CAMERA / (TensegrityRobot.CAMERA - z);
    const centerY = this.originY - 1.5 * this.scale * Math.cos(TensegrityRobot.PITCH);
    const p = this.fromView([(x - this.width / 2 - this.cx * this.scale) / s, -(y - centerY) / s, z]);
    p[0] += this.cx;
    p[1] = Math.max(0, p[1]);
    return p;
  }

  /* ---------- drawing ---------- */

  readColors() {
    const style = getComputedStyle(document.documentElement);
    // Strut colour = the page's text colour token (read directly, so a colour transition does not interfere)
    const hex = style.getPropertyValue('--text').trim().replace('#', '');
    const text = hex.length === 6 ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) : [28, 25, 23];
    this.palette = {
      strut: text.join(', '),
      cable: style.getPropertyValue('--net-node').trim() || '120, 113, 108',
      accent: style.getPropertyValue('--net-accent').trim() || '155, 28, 34',
    };
  }

  draw() {
    const { ctx, palette, nodes, struts, cables } = this;
    ctx.clearRect(0, 0, this.width, this.height);
    // Fade in at the start of the drop-in (softens the entry where the canvas has an edge)
    ctx.globalAlpha = this.dropAt ? Math.min(Math.max((performance.now() - this.dropAt) / 400, 0), 1) : 1;
    const pts = nodes.map((n) => this.project(n.p));
    const depthAlpha = (z) => 0.5 + 0.5 * Math.min(Math.max((z + 3) / 6, 0), 1);
    ctx.lineCap = 'round';

    // Everything else back to front
    const items = [];
    cables.forEach((c, i) => items.push({ type: 'cable', i, z: (pts[c.a].z + pts[c.b].z) / 2 }));
    struts.forEach((s, i) => items.push({ type: 'strut', i, z: (pts[s.a].z + pts[s.b].z) / 2 }));
    nodes.forEach((n, i) => items.push({ type: 'node', i, z: pts[i].z + 0.01 }));
    items.sort((a, b) => a.z - b.z);

    for (const item of items) {
      const alpha = depthAlpha(item.z);
      if (item.type === 'cable') {
        const c = cables[item.i];
        const a = pts[c.a], b = pts[c.b];
        // Highlight stretch beyond the resting (pre-tensioned) length of about 2.0
        const extra = Math.max(0, this.dist(nodes[c.a].p, nodes[c.b].p) - 2.0) / 2.0;
        const tension = Math.min(extra * 6, 1);
        ctx.strokeStyle = tension > 0.15
          ? `rgba(${palette.accent}, ${(0.25 + tension * 0.5) * alpha})`
          : `rgba(${palette.cable}, ${0.55 * alpha})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      } else if (item.type === 'strut') {
        const s = struts[item.i];
        const a = pts[s.a], b = pts[s.b];
        ctx.strokeStyle = `rgba(${palette.strut}, ${0.9 * alpha})`;
        ctx.lineWidth = Math.max(3, 0.075 * (a.s + b.s) / 2);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      } else {
        const p = pts[item.i];
        const r = Math.max(5, 0.12 * p.s); // large end caps, like on the real robot
        const active = item.i === this.hoverNode || (this.dragged && this.dragged.index === item.i);
        ctx.fillStyle = active ? `rgba(${palette.accent}, 1)` : `rgba(${palette.strut}, ${alpha})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, active ? r * 1.4 : r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    this.report(pts);
  }

  // Tell the page where the robot is: the hint floats above it, and the network
  // (main.js) lets the neurons it touches fire while it moves ("robotmove" event)
  report(pts) {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    const y = (Math.min(...ys) + Math.max(...ys)) / 2;
    const r = Math.max(...pts.map((p) => Math.hypot(p.x - x, p.y - y)));
    // speed in px per step (average over the nodes, so rolling and wobbling count too)
    const speed = (this.nodes.reduce((sum, n) => sum + this.dist(n.p, n.q), 0) / this.nodes.length) * this.scale;
    const top = Math.min(...ys);
    if (this.reported && Math.abs(this.reported.x - x) + Math.abs(this.reported.y - y) + Math.abs(this.reported.r - r) < 0.5) {
      if (this.reported.speed > 0.3 && speed <= 0.3) this.reportSpeed(x, y, r, speed); // came to rest
      return;
    }
    this.reported = { x, y, r, speed };
    if (this.hint) {
      // the bubble's tail ends just above the robot's highest node
      this.hint.style.transform = `translate(${Math.round(x)}px, ${Math.round(top - 16)}px) translate(-50%, -100%)`;
      // appears once the robot has landed, and goes away for good after the first drag
      this.hint.classList.toggle('shown', !this.dropping && !this.wasDragged);
    }
    this.reportSpeed(x, y, r, speed);
  }

  reportSpeed(x, y, r, speed) {
    this.reported.speed = speed;
    const detail = { cx: x + this.canvas.offsetLeft, cy: y + this.canvas.offsetTop, r, speed };
    document.dispatchEvent(new CustomEvent('robotmove', { detail }));
  }

  /* ---------- interaction ---------- */

  pointer(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  findNode(x, y) {
    let best = -1, bestD = 18;
    this.nodes.forEach((n, i) => {
      const p = this.project(n.p);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  // When a node is let go, cap the speed of the whole body so a flick throws it
  // up a little instead of off the screen (its spin is kept)
  limitThrow() {
    const T = TensegrityRobot;
    const v = [0, 1, 2].map((k) => this.nodes.reduce((sum, n) => sum + n.p[k] - n.q[k], 0) / this.nodes.length);
    const speed = Math.hypot(...v);
    if (speed <= T.MAX_THROW) return;
    const cut = 1 - T.MAX_THROW / speed;
    for (const n of this.nodes) for (let k = 0; k < 3; k++) n.q[k] += v[k] * cut;
  }

  bindEvents() {
    const host = this.host;
    const local = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    // The canvas itself ignores the pointer (so the network and the links behind it stay
    // clickable); the robot listens on its parent and only reacts near one of its nodes.
    // Capture phase, so a grab on a node does not also reach the network.
    host.addEventListener('pointerdown', (e) => {
      const { x, y } = local(e);
      const n = this.findNode(x, y);
      if (n < 0) return;
      e.stopPropagation();
      try { host.setPointerCapture(e.pointerId); } catch (err) { /* keep dragging even if capture is not possible */ }
      this.dragged = { index: n, depth: this.project(this.nodes[n].p).z, target: this.nodes[n].p.slice() };
      host.classList.add('robot-dragging');
      this.wasDragged = true;
      if (this.hint) this.hint.classList.remove('shown');
      this.wake();
    }, true);

    // Touch: let normal swipes scroll the page. Only a touch that starts right on a
    // node grabs it (we block scrolling for that touch).
    host.addEventListener('touchstart', (e) => {
      const { x, y } = local(e.touches[0]);
      if (this.findNode(x, y) >= 0) e.preventDefault();
    }, { passive: false, capture: true });

    host.addEventListener('pointermove', (e) => {
      const { x, y } = local(e);
      if (this.dragged) {
        this.dragged.target = this.unproject(x, y, this.dragged.depth);
        return;
      }
      if (e.pointerType !== 'mouse') return;
      const hover = this.findNode(x, y);
      if (hover === this.hoverNode) return;
      this.hoverNode = hover;
      host.classList.toggle('robot-pointing', hover >= 0);
      if (!this.running) this.draw();
    });

    const release = (thrown) => {
      if (!this.dragged) return;
      if (thrown) this.limitThrow();
      this.dragged = null;
      host.classList.remove('robot-dragging');
    };
    host.addEventListener('pointerup', () => release(true));
    host.addEventListener('pointercancel', () => release(false));
    host.addEventListener('pointerleave', () => {
      if (this.hoverNode < 0) return;
      this.hoverNode = -1;
      host.classList.remove('robot-pointing');
      if (!this.running) this.draw();
    });

    window.addEventListener('resize', () => this.resize());
    document.addEventListener('themechange', () => {
      this.readColors();
      if (!this.running) this.draw();
    });

    new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.updateRunning();
    }).observe(this.canvas);
    document.addEventListener('visibilitychange', () => this.updateRunning());
  }

  /* ---------- loop: runs while visible, sleeps once the robot is at rest ---------- */

  wake() {
    this.restFrames = 0;
    this.updateRunning();
  }

  updateRunning() {
    const shouldRun = this.visible && !document.hidden;
    if (shouldRun && !this.running) {
      this.running = true;
      this.restFrames = 0;
      this.lastTime = 0;
      this.accumulator = 0;
      requestAnimationFrame(this.frame);
    } else if (!shouldRun) {
      this.running = false;
    }
  }

  frame(time) {
    if (!this.running) return;
    const before = this.nodes.map((n) => n.p.slice());

    // Advance the simulation in fixed steps so it runs at the same speed on 60 Hz and 120 Hz screens
    const now = performance.now();
    this.lastTime = this.lastTime || now;
    this.accumulator = Math.min((this.accumulator || 0) + (now - this.lastTime), 100);
    this.lastTime = now;
    while (this.accumulator >= TensegrityRobot.STEP) {
      if (!this.dropAt || now >= this.dropAt) this.step(); // hold in the air until the drop starts
      this.accumulator -= TensegrityRobot.STEP;
    }
    this.draw();

    // Stop the loop when nothing moves any more (saves battery)
    const motion = Math.max(...this.nodes.map((n, i) => this.dist(n.p, before[i])));
    const busy = this.dragged || this.dropping;
    this.restFrames = motion < 0.0004 && !busy ? this.restFrames + 1 : 0;
    if (this.restFrames > 60) {
      this.running = false;
      return;
    }
    requestAnimationFrame(this.frame);
  }
}
