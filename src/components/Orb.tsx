import { useEffect, useRef } from "react";
import { audioEngine } from "../audio/engine";

const DEFAULT_PARTICLES = 1400;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const LISTEN_RGB = [62, 230, 176];
const SPEAK_RGB = [255, 42, 109];
const IDLE_RGB = [110, 160, 200];

interface Particle {
  x: number;
  y: number;
  z: number;
  phase: number;
  jitter: number;
}

function buildSphere(count: number): Particle[] {
  return Array.from({ length: count }, (_, i) => {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = GOLDEN * i;
    return { x: Math.cos(theta) * r, y, z: Math.sin(theta) * r, phase: Math.random() * Math.PI * 2, jitter: Math.random() };
  });
}

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/**
 * Audio-reactive particle sphere. Samples microphone and speech-output levels every frame,
 * colouring toward cyan for the user's voice and crimson for the AI's.
 */
export function Orb({ size, running, particles: count = DEFAULT_PARTICLES }: { size: number; running: boolean; particles?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!running) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const particles = buildSphere(count);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let level = 0;
    let micShare = 0;
    let rotY = 0;
    let rotX = 0.35;
    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const mic = audioEngine.micLevel();
      const out = audioEngine.outputLevel();
      const target = Math.max(mic, out);
      // Fast attack, slower release keeps motion lively without flicker.
      level += (target - level) * (target > level ? 0.35 : 0.08);
      const share = mic + out > 0.01 ? mic / (mic + out) : micShare;
      micShare += (share - micShare) * 0.1;

      rotY += dt * (reduceMotion ? 0.05 : 0.25 + level * 1.4);
      rotX = 0.35 + Math.sin(now / 4000) * 0.15;
      const t = now / 1000;

      const cx = size / 2;
      const cy = size / 2;
      const base = size * 0.3;
      const dotScale = Math.max(0.45, size / 150);
      const tint = level < 0.02 ? IDLE_RGB : mix(SPEAK_RGB, LISTEN_RGB, micShare);
      const rgb = mix(IDLE_RGB, tint, Math.min(1, level * 6));

      ctx.clearRect(0, 0, size, size);

      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, base * (1.25 + level));
      glow.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.22 + level * 0.45})`);
      glow.addColorStop(0.55, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.06 + level * 0.12})`);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);

      ctx.globalCompositeOperation = "lighter";
      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      const cosX = Math.cos(rotX);
      const sinX = Math.sin(rotX);
      for (const p of particles) {
        const wobble = Math.sin(t * 2.2 + p.phase) * 0.025 + Math.sin(t * 5 + p.phase * 3) * level * 0.22 * p.jitter;
        const r = base * (1 + level * 0.35 + wobble);
        const x1 = p.x * cosY - p.z * sinY;
        const z1 = p.x * sinY + p.z * cosY;
        const y1 = p.y * cosX - z1 * sinX;
        const z2 = p.y * sinX + z1 * cosX;
        const depth = (z2 + 1) / 2;
        const perspective = 1 / (1.6 - z2 * 0.45);
        const px = cx + x1 * r * perspective * 1.2;
        const py = cy + y1 * r * perspective * 1.2;
        const alpha = 0.12 + depth * 0.6 + level * 0.25;
        const dot = (0.5 + depth * 1.1 + level * 1.4 * p.jitter) * dotScale;
        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.min(1, alpha)})`;
        ctx.beginPath();
        ctx.arc(px, py, dot, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    };
  }, [size, running, count]);

  return <canvas ref={canvasRef} className="orb-canvas" style={{ width: size, height: size }} aria-hidden="true" />;
}
