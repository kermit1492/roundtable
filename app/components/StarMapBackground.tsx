'use client';

import { useEffect, useRef } from 'react';

// Canvas-based starmap rendered as a fixed full-screen background layer.
// Mode prop drives geometry: `idle` (balanced clusters), `discussion` (sprawling, reaches edges),
// `synthesis` (focused funnel to center). Transitions between modes are smooth (~1.6s).
// The animation loop is entirely inside one useEffect so React doesn't re-mount it on prop change.
// The current mode is read through a ref from inside the loop.

export type StarMapMode = 'idle' | 'discussion' | 'synthesis';

export interface StarMapLabel {
  name: string;
  color: string;
}

interface Props {
  mode: StarMapMode;
  /**
   * Whether to render at all. Useful if you want to disable on low-end devices or specific themes.
   * Defaults to true.
   */
  enabled?: boolean;
  /**
   * Global opacity multiplier. Useful for light themes where a full-intensity starmap would
   * overpower the rest of the UI. Defaults to 1.
   */
  opacity?: number;
  /**
   * Model labels rendered as part of the network. Their positions rotate and breathe
   * together with the starmap, but the text itself stays upright for readability.
   */
  labels?: StarMapLabel[];
  /**
   * When true (discussion running), labels brighten and pulse subtly.
   */
  active?: boolean;
}

interface NodePos { x: number; y: number; }
interface Node {
  positions: { idle: NodePos; discussion: NodePos; synthesis: NodePos };
  current: NodePos;
  from: NodePos;
  brightness: number;
  size: number;
  twinkles: boolean;
  twinklePhase: number;
  twinkleSpeed: number;
  /** Transient flash activation (0..~1.2). Set by flash-wave events, decays each frame. */
  activation: number;
  // Per-node organic drift — small Lissajous-style oscillation around the base position,
  // so the graph keeps moving even when not transitioning between modes.
  driftAmpX: number;
  driftAmpY: number;
  driftSpeedX: number;
  driftSpeedY: number;
  driftPhaseX: number;
  driftPhaseY: number;
  /** Which model "owns" this node (0..NUM_GROUPS-1). Set by angle of idle position relative
      to canvas centre — partitions the network into N sectors, one per model. */
  group: number;
}
interface Edge {
  a: number;
  b: number;
  perpFrac: number;     // base curvature
  opacity: number;
  flowAmp: number;      // how much the curvature oscillates over time
  flowSpeed: number;    // angular speed of the oscillation
  flowPhase: number;    // initial phase
}
interface Pulse {
  edgeIdx: number;
  t: number;
  speed: number;
  dir: 1 | -1;
  /** Hex colour inherited from the source node's model. */
  color: string;
}

const NUM_GROUPS = 3;

const N_NODES = 380;
const TRANSITION_DUR = 1.6;
const MAX_PULSES = 280;

export default function StarMapBackground({ mode, enabled = true, opacity = 1, labels, active = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modeRequestRef = useRef<{ target: StarMapMode; tick: number }>({ target: mode, tick: 0 });
  // The animation loop reads labels/active through refs so the rAF loop doesn't restart on prop change.
  const labelsRef = useRef<StarMapLabel[] | undefined>(labels);
  const activeRef = useRef<boolean>(active);

  // Bump the request tick whenever the prop changes; the animation loop picks it up.
  useEffect(() => {
    modeRequestRef.current = { target: mode, tick: modeRequestRef.current.tick + 1 };
  }, [mode]);

  useEffect(() => { labelsRef.current = labels; }, [labels]);
  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => {
    if (!enabled) return;
    const canvasMaybe = canvasRef.current;
    if (!canvasMaybe) return;
    const ctxMaybe = canvasMaybe.getContext('2d');
    if (!ctxMaybe) return;
    // Bind to non-nullable typed consts so TS narrowing persists inside nested function declarations.
    // Without these, strict mode loses the null-check inside closures like drawBackground/resize.
    const canvas: HTMLCanvasElement = canvasMaybe;
    const ctx: CanvasRenderingContext2D = ctxMaybe;

    let W = 0, H = 0, DPR = 1;
    let rafId = 0;
    let disposed = false;

    // ===== Halo sprite =====
    function makeHalo(): HTMLCanvasElement {
      const size = 64;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const x = c.getContext('2d')!;
      const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.18, 'rgba(220,235,255,0.65)');
      g.addColorStop(0.45, 'rgba(150,200,255,0.18)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g;
      x.fillRect(0, 0, size, size);
      return c;
    }
    const HALO_TEX = makeHalo();

    // ===== State =====
    let nodes: Node[] = [];
    let edges: Edge[] = [];
    const pulses: Pulse[] = [];

    let currentMode: StarMapMode = mode;
    let fromMode: StarMapMode = mode;
    let transitionT = 1;
    let lastSeenTick = modeRequestRef.current.tick;

    // ===== Organic motion =====
    // Slow accumulated rotation about screen centre — makes the network feel like it drifts.
    let rotation = 0;
    // Fast independent rotation for the synthesis "pulsar" core: jets and orbiting labels.
    // Decoupled from the main graph rotation so the core can spin visibly fast without
    // turning the whole network into a blur.
    let pulsarRotation = 0;
    // Periodic "thunderclap" wave events: scheduled per-node activations that fire over ~1-2s.
    // Creates the impression of a discharge crossing the network.
    const flashQueue: { nodeIdx: number; fireAt: number }[] = [];
    let nextFlashTime = 5; // first wave 5 seconds in

    // ===== Background offscreen cache =====
    const bg = document.createElement('canvas');
    const bgCtx = bg.getContext('2d')!;

    function gauss(): number {
      return (Math.random() + Math.random() + Math.random()) / 3 - 0.5;
    }

    function makeClusters(count: number, opts: { xMin: number; xMax: number; yMin: number; yMax: number; radMin: number; radMax: number }) {
      const out: { cx: number; cy: number; radius: number }[] = [];
      for (let i = 0; i < count; i++) {
        out.push({
          cx: W * (opts.xMin + Math.random() * (opts.xMax - opts.xMin)),
          cy: H * (opts.yMin + Math.random() * (opts.yMax - opts.yMin)),
          radius: opts.radMin + Math.random() * (opts.radMax - opts.radMin),
        });
      }
      return out;
    }

    function sampleCluster(cl: { cx: number; cy: number; radius: number }, spread: number): NodePos {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.abs(gauss()) * cl.radius * spread;
      return { x: cl.cx + Math.cos(angle) * dist, y: cl.cy + Math.sin(angle) * dist };
    }

    function regenerate() {
      nodes = [];
      edges = [];
      pulses.length = 0;

      const idleClusters = makeClusters(7, { xMin: 0.17, xMax: 0.83, yMin: 0.18, yMax: 0.82, radMin: 70, radMax: 150 });
      const discClusters = makeClusters(11, { xMin: 0.02, xMax: 0.98, yMin: 0.05, yMax: 0.95, radMin: 50, radMax: 110 });
      const cx = W * 0.5, cy = H * 0.52;
      const maxR = Math.min(W, H) * 0.5;

      for (let i = 0; i < N_NODES; i++) {
        const idlePos = Math.random() < 0.85
          ? sampleCluster(idleClusters[Math.floor(Math.random() * idleClusters.length)], 2.2)
          : { x: Math.random() * W, y: Math.random() * H };

        const discPos = Math.random() < 0.78
          ? sampleCluster(discClusters[Math.floor(Math.random() * discClusters.length)], 2.5)
          : { x: Math.random() * W, y: Math.random() * H };

        // Synthesis = "black hole + accretion disk". Inner third of nodes collapses HARD into a
        // tight core; outer two-thirds stretches all the way to the actual screen edges
        // (using per-angle edge distance, so wide screens get horizontal reach, not just min(W,H)).
        const synthAngleSrc = Math.atan2(idlePos.y - cy, idlePos.x - cx);
        const idleRadius = Math.hypot(idlePos.x - cx, idlePos.y - cy);
        const rNorm = Math.min(1, idleRadius / maxR); // 0 = centre, 1 = source-cluster edge
        // Distance from centre to nearest screen edge along this angle. This is what allows
        // branches to reach the actual viewport corners on a wide canvas.
        const cosA = Math.cos(synthAngleSrc);
        const sinA = Math.sin(synthAngleSrc);
        const tX = cosA > 0 ? (W - cx) / cosA : cosA < 0 ? -cx / cosA : Infinity;
        const tY = sinA > 0 ? (H - cy) / sinA : sinA < 0 ? -cy / sinA : Infinity;
        const edgeDist = Math.min(tX, tY);
        // Piecewise remap of normalised radius:
        //   rNorm < 0.35  → quadratic collapse into 0..10% of edgeDist (the gravity well)
        //   rNorm ≥ 0.35  → smoothstep expansion from 10% out to 100% of edgeDist (the branches)
        let synthRadius: number;
        if (rNorm < 0.35) {
          const k = rNorm / 0.35;
          synthRadius = k * k * 0.10 * edgeDist;
        } else {
          const t = (rNorm - 0.35) / 0.65;
          const smooth = t * t * (3 - 2 * t);
          synthRadius = (0.10 + smooth * 0.90) * edgeDist;
        }
        const synthPos = { x: cx + cosA * synthRadius, y: cy + sinA * synthRadius };

        const brightness = 0.4 + Math.random() * 0.6;
        const size = 0.4 + Math.random() * Math.random() * 3.2;

        // Partition by angle in idle layout so each model "owns" a sector of the network.
        // Sectors are 120° each, first sector centred on top (-π/2).
        const idleAngle = Math.atan2(idlePos.y - cy, idlePos.x - cx);
        // Shift so that the first sector starts at -π/2 - π/3 = -5π/6 (top sector spans -π/2 ± π/3).
        const shifted = idleAngle - (-5 * Math.PI / 6);
        const TWO_PI = Math.PI * 2;
        const normalized = ((shifted % TWO_PI) + TWO_PI) % TWO_PI;
        const group = Math.floor(normalized / (TWO_PI / NUM_GROUPS)) % NUM_GROUPS;

        nodes.push({
          positions: { idle: idlePos, discussion: discPos, synthesis: synthPos },
          current: { ...idlePos },
          from: { ...idlePos },
          brightness,
          size,
          twinkles: Math.random() < 0.25,
          twinklePhase: Math.random() * Math.PI * 2,
          twinkleSpeed: 0.3 + Math.random() * 0.8,
          activation: 0,
          // Lissajous drift: independent X/Y amplitudes/speeds give an organic non-circular wobble.
          driftAmpX: 3 + Math.random() * 7,
          driftAmpY: 3 + Math.random() * 7,
          driftSpeedX: 0.18 + Math.random() * 0.35,
          driftSpeedY: 0.20 + Math.random() * 0.38,
          driftPhaseX: Math.random() * Math.PI * 2,
          driftPhaseY: Math.random() * Math.PI * 2,
          group,
        });
      }

      const MAX_DIST = 200;
      for (let i = 0; i < nodes.length; i++) {
        const pa = nodes[i].positions.idle;
        const candidates: { j: number; d: number }[] = [];
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          const pb = nodes[j].positions.idle;
          const dx = pa.x - pb.x, dy = pa.y - pb.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < MAX_DIST) candidates.push({ j, d });
        }
        candidates.sort((a, b) => a.d - b.d);
        const howMany = 2 + Math.floor(Math.random() * 3);
        for (let m = 0; m < Math.min(howMany, candidates.length); m++) {
          const jj = candidates[m].j;
          if (jj > i) {
            edges.push({
              a: i,
              b: jj,
              perpFrac: (Math.random() - 0.5) * 0.35,
              opacity: 0.12 + Math.random() * 0.18,
              flowAmp: 0.06 + Math.random() * 0.08,
              flowSpeed: 0.18 + Math.random() * 0.30,
              flowPhase: Math.random() * Math.PI * 2,
            });
          }
        }
      }

      const highways = Math.floor(N_NODES * 0.035);
      for (let h = 0; h < highways; h++) {
        const a = Math.floor(Math.random() * N_NODES);
        const b = Math.floor(Math.random() * N_NODES);
        if (a === b) continue;
        const pa2 = nodes[a].positions.idle, pb2 = nodes[b].positions.idle;
        const ddx = pa2.x - pb2.x, ddy = pa2.y - pb2.y;
        const dd = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dd > 350) {
          edges.push({
            a, b,
            perpFrac: (Math.random() - 0.5) * 0.18,
            opacity: 0.08 + Math.random() * 0.1,
            flowAmp: 0.04 + Math.random() * 0.06,
            flowSpeed: 0.12 + Math.random() * 0.22,
            flowPhase: Math.random() * Math.PI * 2,
          });
        }
      }

      drawBackground();
    }

    function drawBackground() {
      bg.width = canvas.width;
      bg.height = canvas.height;
      bgCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
      bgCtx.fillStyle = '#03050e';
      bgCtx.fillRect(0, 0, W, H);

      const rg = bgCtx.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.8);
      rg.addColorStop(0, 'rgba(28, 36, 80, 0.32)');
      rg.addColorStop(0.5, 'rgba(15, 20, 50, 0.16)');
      rg.addColorStop(1, 'rgba(0, 0, 0, 0)');
      bgCtx.fillStyle = rg;
      bgCtx.fillRect(0, 0, W, H);

      for (let i = 0; i < 800; i++) {
        bgCtx.fillStyle = `rgba(80,100,140,${Math.random() * 0.06})`;
        bgCtx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
      }
    }

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      regenerate();
    }

    function applyModeChange(newMode: StarMapMode) {
      if (newMode === currentMode && transitionT >= 1) return;
      for (let i = 0; i < nodes.length; i++) {
        nodes[i].from.x = nodes[i].current.x;
        nodes[i].from.y = nodes[i].current.y;
      }
      fromMode = currentMode;
      currentMode = newMode;
      transitionT = 0;
    }

    /** Convert "#RRGGBB" to "rgba(r,g,b,a)". Cached parse for performance. */
    const colorCache = new Map<string, { r: number; g: number; b: number }>();
    function parseHex(hex: string): { r: number; g: number; b: number } {
      const cached = colorCache.get(hex);
      if (cached) return cached;
      const h = hex.startsWith('#') ? hex.slice(1) : hex;
      const v = { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
      colorCache.set(hex, v);
      return v;
    }
    function pulseColorStr(hex: string, alpha: number): string {
      const c = parseHex(hex);
      return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
    }

    /** Look up the colour assigned to a model group via the labels prop. Falls back to white. */
    function groupColor(group: number): string {
      const labelArr = labelsRef.current;
      if (labelArr && labelArr[group]) return labelArr[group].color;
      return '#ffffff';
    }

    /**
     * Schedules per-node activations that propagate outward from an epicenter at a given speed.
     * Looks like a wave/flash crossing the whole network. In synthesis the epicenter is fixed
     * at the focal point; otherwise it's a random location.
     */
    function triggerFlashWave(tSec: number) {
      let ex: number, ey: number;
      if (currentMode === 'synthesis') {
        ex = W * 0.5; ey = H * 0.52;
      } else {
        ex = Math.random() * W; ey = Math.random() * H;
      }
      const speed =
        currentMode === 'idle' ? 700 :
        currentMode === 'discussion' ? 1100 :
        950;
      for (let i = 0; i < nodes.length; i++) {
        const dx = nodes[i].current.x - ex;
        const dy = nodes[i].current.y - ey;
        const dist = Math.sqrt(dx * dx + dy * dy);
        flashQueue.push({ nodeIdx: i, fireAt: tSec + dist / speed });
      }
    }

    function spawnPulse() {
      if (!edges.length) return;
      const idx = Math.floor(Math.random() * edges.length);
      const ed = edges[idx];
      const speedFactor =
        currentMode === 'idle' ? 0.55 + Math.random() * 0.5 :
        currentMode === 'discussion' ? 0.9 + Math.random() * 0.8 :
        1.4 + Math.random() * 1.2;
      let dir: 1 | -1;
      if (currentMode === 'synthesis') {
        const cx = W * 0.5, cy = H * 0.5;
        const na = nodes[ed.a].current, nb = nodes[ed.b].current;
        const dA = (na.x - cx) ** 2 + (na.y - cy) ** 2;
        const dB = (nb.x - cx) ** 2 + (nb.y - cy) ** 2;
        dir = dB < dA ? 1 : -1;
        if (Math.random() < 0.15) dir = (dir === 1 ? -1 : 1);
      } else {
        dir = Math.random() < 0.5 ? 1 : -1;
      }
      // Pulse colour = colour of the source-node's model group → impulses radiate
      // outward in each model's signature colour.
      const sourceNodeIdx = dir > 0 ? ed.a : ed.b;
      const color = groupColor(nodes[sourceNodeIdx].group);
      pulses.push({ edgeIdx: idx, t: 0, speed: speedFactor, dir, color });
    }

    function easeInOutCubic(x: number): number {
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    }

    let lastTime = performance.now();
    let lastSpawn = 0;

    function tick() {
      if (disposed) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      // Mode prop changed since last frame?
      if (modeRequestRef.current.tick !== lastSeenTick) {
        lastSeenTick = modeRequestRef.current.tick;
        applyModeChange(modeRequestRef.current.target);
      }

      if (transitionT < 1) transitionT = Math.min(1, transitionT + dt / TRANSITION_DUR);
      const k = easeInOutCubic(transitionT);

      // Drift is faster in higher-energy modes — graphs feel more "agitated" during synthesis.
      const driftScale = currentMode === 'idle' ? 1.0 : currentMode === 'discussion' ? 1.5 : 2.1;
      const tSecForDrift = now / 1000;
      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i];
        const tgt = nd.positions[currentMode];
        // Base position = lerp from old to new mode target
        const baseX = nd.from.x + (tgt.x - nd.from.x) * k;
        const baseY = nd.from.y + (tgt.y - nd.from.y) * k;
        // Layered organic drift — Lissajous-like, each node has its own period/phase, so the
        // whole network keeps gently rearranging without ever settling.
        nd.current.x = baseX + Math.cos(tSecForDrift * nd.driftSpeedX + nd.driftPhaseX) * nd.driftAmpX * driftScale;
        nd.current.y = baseY + Math.sin(tSecForDrift * nd.driftSpeedY + nd.driftPhaseY) * nd.driftAmpY * driftScale;
        // Decay transient flash activation so it visibly fades after the wave passes.
        if (nd.activation > 0) nd.activation *= Math.exp(-dt * 1.6);
      }

      // --- Organic motion: rotation, breathing, periodic flash waves ---
      const rotSpeed =
        currentMode === 'idle' ? 0.018 :
        currentMode === 'discussion' ? 0.04 :
        0.14;
      rotation += rotSpeed * dt;
      // Pulsar spins ~6× faster than the graph in synthesis mode, otherwise dormant.
      const pulsarSpeed = currentMode === 'synthesis' ? 0.85 : 0;
      pulsarRotation += pulsarSpeed * dt;

      const breathPeriod = currentMode === 'idle' ? 6 : currentMode === 'discussion' ? 4 : 2.5;
      const breath = 1 + Math.sin((now / 1000) * (Math.PI * 2 / breathPeriod)) * 0.025;

      const tSec = now / 1000;
      if (tSec > nextFlashTime) {
        const period =
          currentMode === 'idle' ? 16 :
          currentMode === 'discussion' ? 9 :
          6;
        nextFlashTime = tSec + period + Math.random() * 3;
        triggerFlashWave(tSec);
      }

      // Apply scheduled flash activations whose time has come
      for (let i = flashQueue.length - 1; i >= 0; i--) {
        if (tSec >= flashQueue[i].fireAt) {
          const idx = flashQueue[i].nodeIdx;
          nodes[idx].activation = Math.max(nodes[idx].activation, 1.2);
          flashQueue.splice(i, 1);
        }
      }

      ctx.globalAlpha = opacity;
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(bg, 0, 0, W, H);

      // Everything that follows gets rotated + scaled about the network's centre,
      // so the whole sky feels like it slowly turns and breathes.
      ctx.save();
      ctx.translate(W * 0.5, H * 0.52);
      ctx.rotate(rotation);
      ctx.scale(breath, breath);
      ctx.translate(-W * 0.5, -H * 0.52);

      if (currentMode === 'synthesis' && transitionT > 0.2) {
        const hotAlpha = 0.30 * (transitionT - 0.2) / 0.8;
        const hotG = ctx.createRadialGradient(W * 0.5, H * 0.52, 0, W * 0.5, H * 0.52, Math.min(W, H) * 0.55);
        hotG.addColorStop(0, `rgba(255, 80, 50, ${hotAlpha})`);
        hotG.addColorStop(0.7, `rgba(180, 30, 70, ${hotAlpha * 0.3})`);
        hotG.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = hotG;
        ctx.fillRect(0, 0, W, H);
      }

      ctx.lineCap = 'round';
      ctx.lineWidth = 0.6;
      const tEdges = now / 1000;
      for (let e = 0; e < edges.length; e++) {
        const ed = edges[e];
        const na = nodes[ed.a].current, nb = nodes[ed.b].current;
        const dx = nb.x - na.x, dy = nb.y - na.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) continue;
        const px = -dy / len, py = dx / len;
        // Edge curvature breathes over time — combined with node drift, this makes lines
        // appear to weave and intertwine like neural fibres rather than stay rigid.
        const dynPerp = ed.perpFrac + Math.sin(tEdges * ed.flowSpeed + ed.flowPhase) * ed.flowAmp;
        const mx = (na.x + nb.x) / 2 + px * len * dynPerp;
        const my = (na.y + nb.y) / 2 + py * len * dynPerp;
        if (currentMode === 'synthesis' && transitionT > 0.5) {
          const hot = (transitionT - 0.5) / 0.5;
          ctx.strokeStyle = `rgba(${Math.round(180 + hot * 60)}, ${Math.round(210 - hot * 70)}, ${Math.round(255 - hot * 150)}, ${ed.opacity})`;
        } else {
          ctx.strokeStyle = `rgba(180, 210, 255, ${ed.opacity})`;
        }
        ctx.beginPath();
        ctx.moveTo(na.x, na.y);
        ctx.quadraticCurveTo(mx, my, nb.x, nb.y);
        ctx.stroke();
      }

      for (let n = 0; n < nodes.length; n++) {
        const nd = nodes[n];
        const bx = nd.current.x, by = nd.current.y;
        // `act` clamps flash activation to a visible boost for halo opacity, size, and a brighter core.
        const act = Math.min(1, nd.activation);
        const haloR = Math.max(2.5, nd.size * 5) * (1 + act * 0.8);
        ctx.globalAlpha = (nd.brightness * 0.7 + act * 0.55) * opacity;
        ctx.drawImage(HALO_TEX, bx - haloR, by - haloR, haloR * 2, haloR * 2);
        if (currentMode === 'synthesis' && transitionT > 0.5) {
          ctx.globalCompositeOperation = 'source-atop';
          const hotMix = (transitionT - 0.5) / 0.5;
          ctx.globalAlpha = nd.brightness * 0.5 * hotMix * opacity;
          ctx.fillStyle = 'rgba(255, 130, 70, 1)';
          ctx.beginPath();
          ctx.arc(bx, by, haloR, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.globalAlpha = opacity;
        let twS = nd.size * (1 + act * 0.9);
        if (nd.twinkles) {
          const ph = Math.sin((now / 1000) * nd.twinkleSpeed * Math.PI * 2 + nd.twinklePhase);
          if (ph > 0.6) twS = nd.size * (1 + (ph - 0.6) / 0.4 * 1.6) * (1 + act * 0.9);
        }
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.7 + nd.brightness * 0.3 + act * 0.2) * opacity})`;
        ctx.beginPath();
        ctx.arc(bx, by, twS, 0, Math.PI * 2);
        ctx.fill();
      }

      // Pulses
      const spawnInterval = currentMode === 'idle' ? 0.08 : currentMode === 'discussion' ? 0.04 : 0.022;
      if ((now - lastSpawn) / 1000 > spawnInterval && pulses.length < MAX_PULSES) {
        spawnPulse();
        if (currentMode !== 'idle' && Math.random() < 0.3) spawnPulse();
        lastSpawn = now;
      }

      for (let p = pulses.length - 1; p >= 0; p--) {
        const P = pulses[p];
        P.t += P.speed * dt * 0.6;
        if (P.t >= 1) { pulses.splice(p, 1); continue; }
        const ed = edges[P.edgeIdx];
        const na = nodes[ed.a].current, nb = nodes[ed.b].current;
        const dx = nb.x - na.x, dy = nb.y - na.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        const px = -dy / Math.max(1, len), py = dx / Math.max(1, len);
        // Use the same time-varying curvature as the edge rendering, so the pulse rides on the
        // actual visible curve instead of drifting off-line.
        const dynPerp = ed.perpFrac + Math.sin(tEdges * ed.flowSpeed + ed.flowPhase) * ed.flowAmp;
        const midX = (na.x + nb.x) / 2 + px * len * dynPerp;
        const midY = (na.y + nb.y) / 2 + py * len * dynPerp;
        const tt = P.dir > 0 ? P.t : 1 - P.t;
        const omt = 1 - tt;
        const headX = omt * omt * na.x + 2 * omt * tt * midX + tt * tt * nb.x;
        const headY = omt * omt * na.y + 2 * omt * tt * midY + tt * tt * nb.y;

        // Pronounced fade-out: quick fade-in (first 10% of life), then a long quadratic fade-out
        // (remaining 90%). Curve exponent ~2 makes the head visibly dim before disappearing.
        const fade = P.t < 0.10
          ? P.t / 0.10
          : Math.pow(1 - (P.t - 0.10) / 0.90, 1.8);

        // Longer comet-style trail (12 segments) reinforces the fade-out sensation.
        const TRAIL = 12;
        for (let tr = 0; tr < TRAIL; tr++) {
          const tProg = tt - tr * 0.012;
          if (tProg < 0) break;
          const omt2 = 1 - tProg;
          const tx = omt2 * omt2 * na.x + 2 * omt2 * tProg * midX + tProg * tProg * nb.x;
          const ty = omt2 * omt2 * na.y + 2 * omt2 * tProg * midY + tProg * tProg * nb.y;
          const trAlpha = (1 - tr / TRAIL) * 0.45 * opacity * fade;
          const trSize = (1 - tr / TRAIL) * 1.7 + 0.4;
          ctx.fillStyle = pulseColorStr(P.color, trAlpha);
          ctx.beginPath();
          ctx.arc(tx, ty, trSize, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = pulseColorStr(P.color, opacity * fade);
        ctx.beginPath();
        ctx.arc(headX, headY, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.65 * opacity * fade;
        // Soft circular halo around the pulse head, tinted to the source model's colour.
        const halo = ctx.createRadialGradient(headX, headY, 0, headX, headY, 7);
        halo.addColorStop(0, pulseColorStr(P.color, 0.85));
        halo.addColorStop(1, pulseColorStr(P.color, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(headX, headY, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = opacity;
      }

      if (currentMode === 'synthesis' && transitionT > 0.4) {
        const coreAlpha = (transitionT - 0.4) / 0.6;
        const coreCX = W * 0.5;
        const coreCY = H * 0.52;
        const coreR = 80 + Math.sin(now / 200) * 8;

        // ---- Rotating pulsar jets ----
        // Two opposing beams emanate from the centre and rotate at pulsarSpeed. They sweep
        // around like a lighthouse, creating the "active galactic nucleus" feel.
        const jetLen = Math.min(W, H) * 0.42;
        const jetAlpha = coreAlpha * (0.45 + 0.25 * Math.sin(now / 140));
        for (let j = 0; j < 2; j++) {
          const a = pulsarRotation + j * Math.PI;
          const ex = coreCX + Math.cos(a) * jetLen;
          const ey = coreCY + Math.sin(a) * jetLen;
          const jetG = ctx.createLinearGradient(coreCX, coreCY, ex, ey);
          jetG.addColorStop(0, `rgba(255, 240, 220, ${jetAlpha})`);
          jetG.addColorStop(0.15, `rgba(255, 170, 90, ${jetAlpha * 0.7})`);
          jetG.addColorStop(0.5, `rgba(255, 90, 70, ${jetAlpha * 0.25})`);
          jetG.addColorStop(1, 'rgba(255, 50, 80, 0)');
          ctx.strokeStyle = jetG;
          ctx.lineWidth = 14;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(coreCX, coreCY);
          ctx.lineTo(ex, ey);
          ctx.stroke();
        }
        // Secondary thinner accretion-arm: offset by 90° and slightly slower-looking via cos modulation
        const arm2Alpha = coreAlpha * 0.35;
        const armOffset = Math.PI / 2 + Math.sin(now / 600) * 0.3;
        for (let j = 0; j < 2; j++) {
          const a = pulsarRotation * 0.6 + armOffset + j * Math.PI;
          const ex = coreCX + Math.cos(a) * jetLen * 0.55;
          const ey = coreCY + Math.sin(a) * jetLen * 0.55;
          const armG = ctx.createLinearGradient(coreCX, coreCY, ex, ey);
          armG.addColorStop(0, `rgba(255, 220, 180, ${arm2Alpha})`);
          armG.addColorStop(0.6, `rgba(255, 130, 80, ${arm2Alpha * 0.35})`);
          armG.addColorStop(1, 'rgba(255, 60, 60, 0)');
          ctx.strokeStyle = armG;
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(coreCX, coreCY);
          ctx.lineTo(ex, ey);
          ctx.stroke();
        }

        // ---- Black-hole core glow on top of the jets ----
        const coreG = ctx.createRadialGradient(coreCX, coreCY, 0, coreCX, coreCY, coreR);
        coreG.addColorStop(0, `rgba(255, 245, 220, ${coreAlpha * 0.95})`);
        coreG.addColorStop(0.25, `rgba(255, 180, 100, ${coreAlpha * 0.55})`);
        coreG.addColorStop(0.6, `rgba(255, 90, 90, ${coreAlpha * 0.25})`);
        coreG.addColorStop(1, 'rgba(255, 50, 80, 0)');
        ctx.fillStyle = coreG;
        ctx.beginPath();
        ctx.arc(coreCX, coreCY, coreR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Restore the world transform applied at the start of the drawing block.
      ctx.restore();

      // ===== Model labels =====
      // Labels are positioned outside the rotation/scale transform, but their COORDS are
      // computed by rotating/scaling base anchor points about the same centre. The text itself
      // stays upright (no glyph rotation) for readability, while the position moves with the network.
      const labelsCur = labelsRef.current;
      if (labelsCur && labelsCur.length > 0) {
        const cx = W * 0.5, cy = H * 0.52;
        const labelActive = activeRef.current;
        // Compute centroid (current position) of each model's group of nodes — labels
        // anchor at the visual centre of mass of their cluster, so they move with their
        // sub-network and stay roughly inside the cluster on every mode.
        const labelCount = Math.min(labelsCur.length, NUM_GROUPS);
        const baseAnchors: NodePos[] = [];
        const sums = new Array(labelCount).fill(0).map(() => ({ x: 0, y: 0, n: 0 }));
        for (let i = 0; i < nodes.length; i++) {
          const g = nodes[i].group;
          if (g >= 0 && g < labelCount) {
            sums[g].x += nodes[i].current.x;
            sums[g].y += nodes[i].current.y;
            sums[g].n++;
          }
        }
        for (let g = 0; g < labelCount; g++) {
          if (sums[g].n > 0) baseAnchors.push({ x: sums[g].x / sums[g].n, y: sums[g].y / sums[g].n });
          else baseAnchors.push({ x: cx, y: cy });
        }

        // In synthesis mode, blend the centroid anchors toward a tight orbit around the
        // pulsar core. This makes labels "stick" to the active nucleus and visibly rotate
        // with it, instead of trailing far out to the centroid of an extended branch.
        if (currentMode === 'synthesis' && transitionT > 0.05) {
          const pullStrength = Math.min(1, transitionT);
          const orbitRadius = Math.min(W, H) * 0.13; // ~13% of viewport — close to core, outside the brightest glow
          for (let g = 0; g < labelCount; g++) {
            const orbitAngle = pulsarRotation + (g * (Math.PI * 2 / labelCount));
            const orbitX = cx + Math.cos(orbitAngle) * orbitRadius;
            const orbitY = cy + Math.sin(orbitAngle) * orbitRadius;
            baseAnchors[g] = {
              x: baseAnchors[g].x * (1 - pullStrength) + orbitX * pullStrength,
              y: baseAnchors[g].y * (1 - pullStrength) + orbitY * pullStrength,
            };
          }
        }

        const cosR = Math.cos(rotation);
        const sinR = Math.sin(rotation);
        const labelFont = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.save();
        ctx.font = labelFont;
        ctx.textBaseline = 'middle';
        for (let i = 0; i < Math.min(labelsCur.length, baseAnchors.length); i++) {
          const label = labelsCur[i];
          const base = baseAnchors[i];
          // Rotate the anchor position about (cx, cy), then apply breathing scale.
          const dx = base.x - cx, dy = base.y - cy;
          const ax = cx + (dx * cosR - dy * sinR) * breath;
          const ay = cy + (dx * sinR + dy * cosR) * breath;
          // Active labels brighten and pulse gently.
          const pulseAlpha = labelActive
            ? 0.82 + Math.sin(now / 380 + i * 1.5) * 0.18
            : 0.55;
          ctx.globalAlpha = pulseAlpha * opacity;
          // Measure to centre dot + text group around the anchor.
          const text = label.name.toUpperCase();
          const textW = ctx.measureText(text).width;
          const dotR = 4;
          const gap = 8;
          const totalW = dotR * 2 + gap + textW;
          const startX = ax - totalW / 2;
          // Glow dot
          ctx.shadowColor = label.color;
          ctx.shadowBlur = 16;
          ctx.fillStyle = label.color;
          ctx.beginPath();
          ctx.arc(startX + dotR, ay, dotR, 0, Math.PI * 2);
          ctx.fill();
          // Text — glow comes from the same shadow setup.
          ctx.shadowBlur = 12;
          ctx.fillText(text, startX + dotR * 2 + gap, ay);
        }
        ctx.restore();
        ctx.globalAlpha = opacity;
      }

      ctx.globalAlpha = 1;
      rafId = requestAnimationFrame(tick);
    }

    // Debounced resize
    let resizeT: ReturnType<typeof setTimeout> | null = null;
    function onResize() {
      if (resizeT) clearTimeout(resizeT);
      resizeT = setTimeout(resize, 200);
    }

    resize();
    rafId = requestAnimationFrame(tick);
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      if (resizeT) clearTimeout(resizeT);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (!enabled) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
}
