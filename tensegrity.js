/*
 * Interactive tensegrity robot
 * A 6-strut tensegrity icosahedron resting on the ground under gravity.
 * Struts are rigid; cables are elastic and can only pull, never push.
 * Simulated in 3D with position-based dynamics, drawn with a fixed camera.
 *
 * Interaction: drag a node to pull the structure; click a cable to
 * "actuate" it (a motor shortens it briefly), which can tip the robot over.
 * The canvas is transparent, so it can sit on top of other backgrounds.
 * Colors come from the CSS variables --net-node and --net-accent.
 */

class TensegrityRobot {
  static PHI = (1 + Math.sqrt(5)) / 2;
  static STRUT_LENGTH = 2 * TensegrityRobot.PHI;
  static CABLE_REST = 1.72;       // shorter than the geometric 2.0 -> pretension
  static CABLE_STIFFNESS = 0.18;  // fraction of the stretch corrected per iteration
  static ACTUATED_REST = 1.15;    // a "motor" pulls the cable this short
  static ACTUATION_TIME = 2200;   // ms
  static ACTUATION_EASE = 0.025;  // how quickly a cable follows its motor (per step)
  static DRAG_FOLLOW = 0.06;      // how quickly a dragged node follows the pointer (per iteration)
  static STEP = 1000 / 60;        // fixed simulation step in ms, independent of screen refresh rate
  static ITERATIONS = 12;
  static DAMPING = 0.96;
  static GRAVITY = 0.0015;        // model units per step^2 (low = slow, calm tipping)
  static FRICTION = 0.35;         // share of sliding velocity removed on ground contact
  static GRIP = 1;                // static friction: feet on the ground stay exactly in place
  static CAMERA = 9;              // camera distance in model units
  static YAW = 0.55;
  static PITCH = -0.32;           // camera looks slightly down onto the ground
  static FLOOR_RADIUS = 3.2;      // the visible floor disc; the robot stays on it
  static BOWL = 0.06;            // the floor is a very shallow bowl, so the robot rolls back to the middle

  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dragged = null;
    this.hoverNode = -1;
    this.hoverCable = -1;
    this.visible = true;
    this.running = false;
    this.frame = this.frame.bind(this);

    this.readColors();
    this.build();
    this.resize();
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
          this.cables.push({ a: i, b: j, rest: TensegrityRobot.CABLE_REST, actuatedAt: 0 });
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
    let t = 0;
    for (let k = 0; k < 500; k++) this.step((t += 16.7));

    // Centre it horizontally
    const cx = this.nodes.reduce((sum, n) => sum + n.p[0], 0) / this.nodes.length;
    const cz = this.nodes.reduce((sum, n) => sum + n.p[2], 0) / this.nodes.length;
    for (const n of this.nodes) {
      n.p[0] -= cx; n.q[0] -= cx;
      n.p[2] -= cz; n.q[2] -= cz;
    }
  }

  dist(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  // Height of the (very shallow, bowl-shaped) floor at a point
  groundAt(p) {
    return TensegrityRobot.BOWL * (p[0] * p[0] + p[2] * p[2]);
  }

  /* ---------- physics ---------- */

  step(now) {
    const T = TensegrityRobot;

    // Feet touching the ground at the start of the step (for static friction)
    const feet = this.nodes.filter((n) => n.p[1] < this.groundAt(n.p) + 0.001).map((n) => ({ n, x: n.p[0], z: n.p[2] }));

    // Verlet integration with gravity
    for (const n of this.nodes) {
      const v = [0, 1, 2].map((k) => (n.p[k] - n.q[k]) * T.DAMPING);
      n.q = n.p.slice();
      n.p = [n.p[0] + v[0], n.p[1] + v[1] - T.GRAVITY, n.p[2] + v[2]];
    }

    // Actuated cables ease towards the short length and back
    for (const c of this.cables) {
      if (!c.actuatedAt) { c.rest += (T.CABLE_REST - c.rest) * T.ACTUATION_EASE; continue; }
      const t = (now - c.actuatedAt) / T.ACTUATION_TIME;
      if (t >= 1 || t < 0) { c.actuatedAt = 0; continue; }
      c.rest += ((t < 0.6 ? T.ACTUATED_REST : T.CABLE_REST) - c.rest) * T.ACTUATION_EASE;
    }

    for (let it = 0; it < T.ITERATIONS; it++) {
      // Cables: pull only when stretched
      for (const c of this.cables) {
        const a = this.nodes[c.a].p, b = this.nodes[c.b].p;
        const d = this.dist(a, b);
        if (d <= c.rest) continue;
        const corr = ((d - c.rest) / d) * T.CABLE_STIFFNESS * 0.5;
        for (let k = 0; k < 3; k++) {
          const delta = (b[k] - a[k]) * corr;
          a[k] += delta;
          b[k] -= delta;
        }
      }
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
      // Ground (a shallow bowl)
      for (const n of this.nodes) {
        const ground = this.groundAt(n.p);
        if (n.p[1] < ground) n.p[1] = ground;
      }
      // Static friction: feet that stay on the ground do not slide
      for (const f of feet) {
        if (f.n.p[1] > this.groundAt(f.n.p) + 0.001) continue; // lifted off, e.g. while tipping over
        f.n.p[0] += (f.x - f.n.p[0]) * T.GRIP;
        f.n.p[2] += (f.z - f.n.p[2]) * T.GRIP;
      }
    }

    // Keep the robot on its floor disc: if its centre drifts too far out,
    // move the whole body back (rigidly, so the structure is not squeezed)
    const cx = this.nodes.reduce((sum, n) => sum + n.p[0], 0) / this.nodes.length;
    const cz = this.nodes.reduce((sum, n) => sum + n.p[2], 0) / this.nodes.length;
    const offset = Math.hypot(cx, cz);
    const maxOffset = T.FLOOR_RADIUS - 1.9; // safety net: the robot (radius ~1.9) never hangs over the floor edge
    if (offset > maxOffset) {
      const shiftX = cx * (1 - maxOffset / offset);
      const shiftZ = cz * (1 - maxOffset / offset);
      for (const n of this.nodes) {
        n.p[0] -= shiftX; n.q[0] -= shiftX;
        n.p[2] -= shiftZ; n.q[2] -= shiftZ;
      }
    }

    // Friction for nodes touching the ground
    for (const n of this.nodes) {
      if (n.p[1] < this.groundAt(n.p) + 0.001) {
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
    // Fit the whole floor disc in the width (with a little margin for perspective)
    this.scale = Math.min(this.width / (2 * TensegrityRobot.FLOOR_RADIUS + 0.9), this.height / 4.9);
    this.originY = this.height * 0.8; // where the ground under the robot appears
    if (!this.running) this.draw();
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

  project(p) {
    const v = this.toView(p);
    const s = this.scale * TensegrityRobot.CAMERA / (TensegrityRobot.CAMERA - v[2]);
    const centerY = this.originY - 1.5 * this.scale * Math.cos(TensegrityRobot.PITCH);
    return { x: this.width / 2 + v[0] * s, y: centerY - v[1] * s, z: v[2], s };
  }

  unproject(x, y, z) {
    const s = this.scale * TensegrityRobot.CAMERA / (TensegrityRobot.CAMERA - z);
    const centerY = this.originY - 1.5 * this.scale * Math.cos(TensegrityRobot.PITCH);
    const p = this.fromView([(x - this.width / 2) / s, -(y - centerY) / s, z]);
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
    const pts = nodes.map((n) => this.project(n.p));
    const depthAlpha = (z) => 0.5 + 0.5 * Math.min(Math.max((z + 3) / 6, 0), 1);
    ctx.lineCap = 'round';

    // Ground: a faint floor disc in perspective, a bit darker towards the centre
    const R = TensegrityRobot.FLOOR_RADIUS;
    for (const [radius, alpha] of [[R, 0.035], [R * 0.72, 0.035], [R * 0.48, 0.04]]) {
      ctx.fillStyle = `rgba(${palette.cable}, ${alpha})`;
      ctx.beginPath();
      for (let k = 0; k <= 48; k++) {
        const angle = (k / 48) * Math.PI * 2;
        const g = this.project([Math.cos(angle) * radius, TensegrityRobot.BOWL * radius * radius, Math.sin(angle) * radius]);
        if (k === 0) ctx.moveTo(g.x, g.y);
        else ctx.lineTo(g.x, g.y);
      }
      ctx.fill();
    }

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
        const active = c.actuatedAt || item.i === this.hoverCable;
        ctx.strokeStyle = active
          ? `rgba(${palette.accent}, ${0.9 * alpha})`
          : tension > 0.15
            ? `rgba(${palette.accent}, ${(0.25 + tension * 0.5) * alpha})`
            : `rgba(${palette.cable}, ${0.55 * alpha})`;
        ctx.lineWidth = active ? 2 : 1.2;
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
        const r = Math.max(3, 0.06 * p.s);
        const active = item.i === this.hoverNode || (this.dragged && this.dragged.index === item.i);
        ctx.fillStyle = active ? `rgba(${palette.accent}, 1)` : `rgba(${palette.strut}, ${alpha})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, active ? r * 1.4 : r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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

  findCable(x, y) {
    let best = -1, bestD = 9;
    this.cables.forEach((c, i) => {
      const a = this.project(this.nodes[c.a].p), b = this.project(this.nodes[c.b].p);
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(a.x + t * dx - x, a.y + t * dy - y);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  actuate(i) {
    this.cables[i].actuatedAt = performance.now();
    this.wake();
  }

  bindEvents() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => {
      const { x, y } = this.pointer(e);
      const n = this.findNode(x, y);
      if (n >= 0) {
        c.setPointerCapture(e.pointerId);
        this.dragged = { index: n, depth: this.project(this.nodes[n].p).z, target: this.nodes[n].p.slice() };
        c.classList.add('dragging');
        this.wake();
        return;
      }
      const cable = this.findCable(x, y);
      if (cable >= 0) this.actuate(cable);
    });

    c.addEventListener('pointermove', (e) => {
      const { x, y } = this.pointer(e);
      if (this.dragged) {
        this.dragged.target = this.unproject(x, y, this.dragged.depth);
        return;
      }
      if (e.pointerType !== 'mouse') return;
      this.hoverNode = this.findNode(x, y);
      this.hoverCable = this.hoverNode < 0 ? this.findCable(x, y) : -1;
      c.classList.toggle('pointing', this.hoverNode >= 0 || this.hoverCable >= 0);
      if (!this.running) this.draw();
    });

    const release = () => {
      this.dragged = null;
      c.classList.remove('dragging');
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);
    c.addEventListener('pointerleave', () => {
      this.hoverNode = -1;
      this.hoverCable = -1;
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
    }).observe(c);
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
      this.step(now);
      this.accumulator -= TensegrityRobot.STEP;
    }
    this.draw();

    // Stop the loop when nothing moves any more (saves battery)
    const motion = Math.max(...this.nodes.map((n, i) => this.dist(n.p, before[i])));
    const busy = this.dragged || this.cables.some((c) => c.actuatedAt);
    this.restFrames = motion < 0.0004 && !busy ? this.restFrames + 1 : 0;
    if (this.restFrames > 60) {
      this.running = false;
      return;
    }
    requestAnimationFrame(this.frame);
  }
}
