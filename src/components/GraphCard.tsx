import { useMemo, useState } from "react";
import { gbDesmos } from "../lib/ipc";
import { compile, formatNumber, parse, type GraphPoint, type GraphResult } from "../providers/agent/graph";
import { useNotice } from "../store/notice";
import type { ToolStep } from "../types";
import { Icon } from "./Icon";

const W = 640;
const H = 360;
const COLORS = ["var(--neon)", "var(--crimson)", "var(--green)", "var(--amber)", "#b48cff"];
const POINT_LABEL: Record<GraphPoint["kind"], string> = {
  root: "root",
  solution: "solution",
  intersection: "meet",
  max: "max",
  min: "min",
  "y-intercept": "y-int",
};

/** A tick spacing of 1, 2 or 5 × 10ⁿ giving about `count` ticks. */
function tickStep(span: number, count = 8): number {
  const raw = span / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? p * 10;
}

function ticks(lo: number, hi: number): number[] {
  const step = tickStep(hi - lo);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return out;
}

export function GraphCard({ step }: { step: ToolStep }) {
  const graph = step.graph as GraphResult;
  const { xmin, xmax, ymin, ymax } = graph.view;
  const [opening, setOpening] = useState(false);
  const sx = (x: number) => ((x - xmin) / (xmax - xmin)) * W;
  const sy = (y: number) => H - ((y - ymin) / (ymax - ymin)) * H;

  const lines = useMemo(() => {
    const exprs = [
      ...graph.input.curves.map((c) => ({ label: c.label, expr: c.expr })),
      ...graph.input.equations.flatMap((e) => [
        { label: `${e.label} (left)`, expr: e.left },
        { label: `${e.label} (right)`, expr: e.right },
      ]),
    ];
    return exprs.map(({ label, expr }) => {
      const f = compile(parse(expr));
      let d = "";
      let pen = false;
      let lastY = 0;
      for (let i = 0; i <= 800; i++) {
        const x = xmin + ((xmax - xmin) * i) / 800;
        const y = f(x);
        const py = sy(y);
        // Lift the pen at gaps and across asymptotes.
        if (!Number.isFinite(y) || (pen && Math.abs(py - lastY) > H * 1.5)) {
          pen = false;
          continue;
        }
        const clamped = Math.max(-H, Math.min(2 * H, py));
        d += `${pen ? "L" : "M"}${sx(x).toFixed(1)},${clamped.toFixed(1)}`;
        pen = true;
        lastY = py;
      }
      return { label, d };
    });
    // sx/sy only depend on the view, which is part of `graph`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  const shown = graph.points.filter((p) => p.x >= xmin && p.x <= xmax && p.y >= ymin && p.y <= ymax);
  const latex = [...graph.input.curves.map((c) => c.latex), ...graph.input.equations.map((e) => e.latex)];

  const openDesmos = () => {
    setOpening(true);
    gbDesmos(latex, [xmin, xmax, ymin, ymax])
      .catch((err) => useNotice.getState().show({ message: `Couldn't open Desmos: ${String(err)}` }))
      .finally(() => setOpening(false));
  };

  return (
    <div className="tool-card graph-card">
      <div className="tool-head">
        <Icon name="spark" size={12} />
        <span className="tool-title">{step.title}</span>
      </div>
      <svg className="graph-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Graph of ${lines.map((l) => l.label).join(", ")}`}>
        <defs>
          <clipPath id={`clip-${step.id}`}>
            <rect width={W} height={H} />
          </clipPath>
        </defs>
        {ticks(xmin, xmax).map((v) => (
          <g key={`x${v}`}>
            <line className="graph-grid" x1={sx(v)} x2={sx(v)} y1={0} y2={H} />
            {v !== 0 && (
              <text className="graph-tick" x={sx(v) + 3} y={Math.min(H - 4, Math.max(12, sy(0) + 13))}>
                {formatNumber(v)}
              </text>
            )}
          </g>
        ))}
        {ticks(ymin, ymax).map((v) => (
          <g key={`y${v}`}>
            <line className="graph-grid" x1={0} x2={W} y1={sy(v)} y2={sy(v)} />
            {v !== 0 && (
              <text className="graph-tick" x={Math.min(W - 30, Math.max(3, sx(0) + 4))} y={sy(v) - 3}>
                {formatNumber(v)}
              </text>
            )}
          </g>
        ))}
        {ymin <= 0 && ymax >= 0 && <line className="graph-axis" x1={0} x2={W} y1={sy(0)} y2={sy(0)} />}
        {xmin <= 0 && xmax >= 0 && <line className="graph-axis" x1={sx(0)} x2={sx(0)} y1={0} y2={H} />}
        <g clipPath={`url(#clip-${step.id})`}>
          {lines.map((l, i) => (
            <path key={l.label} d={l.d} className="graph-line" style={{ stroke: COLORS[i % COLORS.length] }} />
          ))}
        </g>
        {shown.map((p, i) => (
          <g key={i} className={`graph-point point-${p.kind}`}>
            <circle cx={sx(p.x)} cy={sy(p.y)} r={4.5} />
            <text x={Math.min(W - 120, sx(p.x) + 8)} y={Math.max(14, sy(p.y) - 8)}>
              {POINT_LABEL[p.kind]} ({formatNumber(p.x)}, {formatNumber(p.y)})
            </text>
          </g>
        ))}
      </svg>
      <div className="graph-foot">
        <span className="graph-legend">
          {lines.map((l, i) => (
            <span key={l.label} style={{ color: COLORS[i % COLORS.length] }}>
              {l.label}
            </span>
          ))}
        </span>
        <button className="btn small" onClick={openDesmos} disabled={opening}>
          <Icon name="download" size={11} /> {opening ? "Opening Desmos…" : "Open in Desmos"}
        </button>
      </div>
    </div>
  );
}
