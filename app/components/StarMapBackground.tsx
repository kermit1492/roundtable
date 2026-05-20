'use client';

import { useEffect, useRef } from 'react';

// Canvas-based starmap rendered as a fixed full-screen background layer.
// Mode prop drives geometry: `idle` (balanced clusters), `discussion` (sprawling, reaches edges),
// `synthesis` (focused funnel to center). Transitions between modes are smooth (~1.6s).
// The animation loop is entirely inside one useEffect so React doesn't re-mount it on prop change.
// The current mode is read through a ref from inside the loop.

export type StarMapMode = 'idle' | 'discussion' | 'synthesis';

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
}
interface Edge { a: number; b: number; perpFrac: number; opacity: number; }
interface Pulse { edgeIdx: number; t: number; speed: number; dir: 1 | -1; hue: 'cool' | 'hot'; }

const N_NODES = 380;
const TRANSITION_DUR = 1.6;
const MAX_PULSES = 280;

export default function StarMapBackground({ mode, enabled = true, opacity = 1 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modeRequestRef = useRef<{ target: StarMapMode; tick: number }>({ target: mode, tick: 0 });

  // Bump the request tick whenever the prop changes; the animation loop picks it up.
  useEffect(() => {
    modeRequestRef.current = { target: mode, tick: modeRequestRef.current.tick + 1 };
  }, [mode]);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

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

        const sAngle = Math.random() * Math.PI * 2;
        const rT = Math.pow(Math.random(), 1.8);
        const sDist = rT * maxR;
        const synthPos = { x: cx + Math.cos(sAngle) * sDist, y: cy + Math.sin(sAngle) * sDist };

        const brightness = 0.4 + Math.random() * 0.6;
        const size = 0.4 + Math.random() * Math.random() * 3.2;

        nodes.push({
          positions: { idle: idlePos, discussion: discPos, synthesis: synthPos },
          current: { ...idlePos },
          from: { ...idlePos },
          brightness,
          size,
          twinkles: Math.random() < 0.25,
          twinklePhase: Math.random() * Math.PI * 2,
          twinkleSpeed: 0.3 + Math.random() * 0.8,
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
          edges.push({ a, b, perpFrac: (Math.random() - 0.5) * 0.18, opacity: 0.08 + Math.random() * 0.1 });
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

    function pulseColorStr(hue: 'cool' | 'hot', alpha: number): string {
      if (hue === 'cool') return `rgba(150, 220, 255, ${alpha})`;
      return `rgba(255, 145, 90, ${alpha})`;
    }

    function modePulseHue(): 'cool' | 'hot' {
      return currentMode === 'synthesis' ? 'hot' : 'cool';
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
      pulses.push({ edgeIdx: idx, t: 0, speed: speedFactor, dir, hue: modePulseHue() });
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

      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i];
        const tgt = nd.positions[currentMode];
        nd.current.x = nd.from.x + (tgt.x - nd.from.x) * k;
        nd.current.y = nd.from.y + (tgt.y - nd.from.y) * k;
      }

      ctx.globalAlpha = opacity;
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(bg, 0, 0, W, H);

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
      for (let e = 0; e < edges.length; e++) {
        const ed = edges[e];
        const na = nodes[ed.a].current, nb = nodes[ed.b].current;
        const dx = nb.x - na.x, dy = nb.y - na.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) continue;
        const px = -dy / len, py = dx / len;
        const mx = (na.x + nb.x) / 2 + px * len * ed.perpFrac;
        const my = (na.y + nb.y) / 2 + py * len * ed.perpFrac;
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
        const haloR = Math.max(2.5, nd.size * 5);
        ctx.globalAlpha = nd.brightness * 0.7 * opacity;
        ctx.drawImage(HALO_TEX, bx - haloR, by - haloR, haloR * 2, haloR * 2);
        if (currentMode === 'synthesis' && transitionT > 0.5) {
          ctx.globalCompositeOperation = 'source-atop';
          const hotMix = (transitionT - 0.5) / 0.5;
          ctx.globalAlpha = nd.brightness * 0.5 * hotMix * opacity;
          ctx.fillStyle = 'rgba(255, 130, 70, 1)';
          ctx.fillRect(bx - haloR, by - haloR, haloR * 2, haloR * 2);
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.globalAlpha = opacity;
        let twS = nd.size;
        if (nd.twinkles) {
          const ph = Math.sin((now / 1000) * nd.twinkleSpeed * Math.PI * 2 + nd.twinklePhase);
          if (ph > 0.6) twS = nd.size * (1 + (ph - 0.6) / 0.4 * 1.6);
        }
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.7 + nd.brightness * 0.3) * opacity})`;
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
        const midX = (na.x + nb.x) / 2 + px * len * ed.perpFrac;
        const midY = (na.y + nb.y) / 2 + py * len * ed.perpFrac;
        const tt = P.dir > 0 ? P.t : 1 - P.t;
        const omt = 1 - tt;
        const headX = omt * omt * na.x + 2 * omt * tt * midX + tt * tt * nb.x;
        const headY = omt * omt * na.y + 2 * omt * tt * midY + tt * tt * nb.y;
        const TRAIL = 8;
        for (let tr = 0; tr < TRAIL; tr++) {
          const tProg = tt - tr * 0.012;
          if (tProg < 0) break;
          const omt2 = 1 - tProg;
          const tx = omt2 * omt2 * na.x + 2 * omt2 * tProg * midX + tProg * tProg * nb.x;
          const ty = omt2 * omt2 * na.y + 2 * omt2 * tProg * midY + tProg * tProg * nb.y;
          const trAlpha = (1 - tr / TRAIL) * 0.45 * opacity;
          const trSize = (1 - tr / TRAIL) * 1.6 + 0.4;
          ctx.fillStyle = pulseColorStr(P.hue, trAlpha);
          ctx.beginPath();
          ctx.arc(tx, ty, trSize, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = pulseColorStr(P.hue, opacity);
        ctx.beginPath();
        ctx.arc(headX, headY, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.6 * opacity;
        ctx.drawImage(HALO_TEX, headX - 5, headY - 5, 10, 10);
        ctx.globalAlpha = opacity;
      }

      if (currentMode === 'synthesis' && transitionT > 0.4) {
        const coreAlpha = (transitionT - 0.4) / 0.6;
        const coreR = 60 + Math.sin(now / 200) * 6;
        const coreG = ctx.createRadialGradient(W * 0.5, H * 0.52, 0, W * 0.5, H * 0.52, coreR);
        coreG.addColorStop(0, `rgba(255, 240, 200, ${coreAlpha * 0.6})`);
        coreG.addColorStop(0.4, `rgba(255, 140, 80, ${coreAlpha * 0.3})`);
        coreG.addColorStop(1, 'rgba(255, 50, 80, 0)');
        ctx.fillStyle = coreG;
        ctx.fillRect(W * 0.5 - coreR, H * 0.52 - coreR, coreR * 2, coreR * 2);
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
