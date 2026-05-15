import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ResponsiveContainer,
} from "recharts";

// ═══════════════════════════════════════════════════════════════════════
//  PHYSICS ENGINE
// ═══════════════════════════════════════════════════════════════════════
function rhoMix(api, bsw) {
  const T = 165, go = 141.5 / (api + 131.5), gw = 1.074, gg = 0.65;
  const Rs = Math.min(gg * Math.pow(850 / 18.2 * Math.pow(10, 0.0125 * api - 0.00091 * T) + 1.4, 1 / 0.83), 500);
  const Bo = 0.972 + 0.000147 * Math.pow(Rs * Math.sqrt(gg / go) + 1.25 * T, 1.175);
  const Bw = 1 + 1.21e-4 * (T - 60) + 1e-6 * (T - 60) ** 2;
  const ro = (62.4 * go + 0.0136 * gg * Rs) / Bo;
  const rw = 62.4 * gw / Bw;
  return (1 - bsw) * ro + bsw * rw;
}

function calcPhysics(d) {
  const T_rated = (d.hp * 5252) / d.rpm;
  const lf = d.ampM / Math.max(d.ampN, 1);
  const T_oper = T_rated * lf;
  const T_col = T_oper * d.eta;
  const f_crit = d.hz * Math.sqrt(Math.min(T_col / T_rated, 1));
  const f_back = Math.max(3, f_crit * 0.85);
  const T_yield = T_rated * 1.60;
  const dP = d.pDis - d.pIn;
  const rho = rhoMix(d.api, d.bsw);
  const grad = rho / 144;
  const P_tub = grad * d.hTub;
  const P_ann = grad * d.hAnn;
  return {
    T_rated: +T_rated.toFixed(1), T_rated_Nm: +(T_rated * 1.35582).toFixed(0),
    T_oper: +T_oper.toFixed(1), T_oper_Nm: +(T_oper * 1.35582).toFixed(0),
    T_col: +T_col.toFixed(1), T_col_Nm: +(T_col * 1.35582).toFixed(0),
    T_yield: +T_yield.toFixed(1), lf_pct: +(lf * 100).toFixed(1),
    f_crit: +f_crit.toFixed(2), f_back: +f_back.toFixed(2),
    safety: +((T_yield - T_oper) / T_yield * 100).toFixed(1),
    dP: +dP.toFixed(0), rho: +rho.toFixed(2), grad: +grad.toFixed(4),
    P_tub: +P_tub.toFixed(1), P_ann: +P_ann.toFixed(1),
    dP_hyd: +(P_tub - P_ann).toFixed(1),
  };
}

function simRamp(T_rated, T_col, f0, rampTime) {
  const fMin = 3;
  const f_crit = f0 * Math.sqrt(Math.min(T_col / T_rated, 1));
  const f_back = Math.max(3, f_crit * 0.85);
  const T_yield = T_rated * 1.60;
  const dt = 0.25, steps = Math.ceil(rampTime / dt) + 1;
  const data = [];
  let peakT = 0, peakTm = 0, bfTime = null, failTime = null, fatigue = 0;
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    const f = Math.max(fMin, f0 - (f0 - fMin) * Math.min(t / rampTime, 1));
    const r = f / f0;
    const Tm = T_rated * r * r;
    const inBF = f <= f_back;
    if (inBF && bfTime === null) bfTime = t;
    let Trev = 0;
    if (inBF) {
      const depth = Math.pow((f_back - f) / Math.max(f_back - fMin, 1), 1.2);
      Trev = T_col * depth * 1.85;
    }
    const prox = Math.abs(f - f_crit) / f0;
    const pulse = prox < 0.08 ? (1 + 0.28 * Math.sin(t * 16)) : 1.0;
    let Ts = inBF
      ? (Tm + Trev) * pulse
      : (Tm + Math.max(0, (T_col / Math.max(r * r, 0.05) - Tm) * 0.25)) * pulse;
    if (Ts > T_rated) fatigue += (Ts - T_rated) * dt;
    if (Ts > peakT) { peakT = Ts; peakTm = t; }
    if (Ts >= T_yield && failTime === null) failTime = t;
    data.push({ t: +t.toFixed(2), f: +f.toFixed(2), Tm: +Tm.toFixed(1), Trev: +Trev.toFixed(1), Ts: +Ts.toFixed(1), factor: +(Ts / T_rated).toFixed(3) });
  }
  return {
    data, f_crit: +f_crit.toFixed(2), f_back: +f_back.toFixed(2),
    T_yield: +T_yield.toFixed(1), peakT: +peakT.toFixed(1),
    peakTime: +peakTm.toFixed(1), bfTime, failTime,
    fatigue: +fatigue.toFixed(1), factor: +(peakT / T_rated).toFixed(3),
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════
// DEMO 1 — Tu pozo real a 60Hz (de tus capturas)
const DEMO1 = {
  api: 17.6, bsw: 0.90, hTub: 10650, hAnn: 1200,
  pIn: 1285, pDis: 4800, hp: 330, rpm: 3600,
  hz: 60, ampN: 84, ampM: 84, eta: 0.75,
};
// DEMO 2 — Mismo pozo interpolado a 40Hz (leyes de afinidad)
// ΔP × (40/60)²=0.444 | I × (40/60)²=0.444 | Columnas sin cambio
const DEMO2 = {
  api: 17.6, bsw: 0.90, hTub: 10650, hAnn: 1200,
  pIn: 1050, pDis: 2610, hp: 330, rpm: 3600,
  hz: 40, ampN: 84, ampM: 37, eta: 0.72,
};
// Default on load = Demo 1
const DEMO_INPUTS = DEMO1;
const RAMPS = [5, 10, 15, 20, 30, 45, 60];

// ═══════════════════════════════════════════════════════════════════════
//  DESIGN TOKENS
// ═══════════════════════════════════════════════════════════════════════
const D = {
  bg: "#02070d",
  panel: "#050b14",
  panel2: "#070d18",
  panel3: "#030810",
  border: "#0c1c2a",
  border2: "#163044",
  accent: "#0891b2",
  accent2: "#67c1d4",
  accentD: "#06627a",
  ok: "#2a9d6f",
  warn: "#c9820a",
  danger: "#c94040",
  text: "#5a8a9f",
  textB: "#8faebb",
  textD: "#253d4d",
  hdr: "linear-gradient(90deg,#010508,#030d18,#010508)",
};

const RC = f => f > 1.5 ? D.danger : f > 1.1 ? D.warn : D.ok;
const RL = f => f > 1.5 ? "ALTO" : f > 1.1 ? "MODERADO" : "NORMAL";

// ═══════════════════════════════════════════════════════════════════════
//  NATIVE SLIDER  — no opacity hack, real CSS, local state for drag
//  FIX: uses local dragging value so track fills instantly,
//       only commits to parent state on change (debounced via RAF)
// ═══════════════════════════════════════════════════════════════════════
function NativeSlider({ label, note, value, onChange, min, max, step, color, unit }) {
  // Local display value updates instantly on drag
  const [local, setLocal] = useState(value);
  const rafRef = useRef(null);

  // Sync from parent when value changes externally (e.g. "Send to Simulator")
  useEffect(() => { setLocal(value); }, [value]);

  const handleChange = useCallback((e) => {
    const v = parseFloat(e.target.value);
    setLocal(v); // instant visual update
    // Debounce parent state update via requestAnimationFrame
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => onChange(v));
  }, [onChange]);

  const pct = Math.min(100, Math.max(0, ((local - min) / (max - min)) * 100));
  const display = step < 1 ? local.toFixed(2) : local.toFixed(1);

  return (
    <div style={{ marginBottom: 18 }}>
      {/* Label row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: note ? 2 : 6 }}>
        <span style={{ fontSize: 11, color: D.textB, fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color, fontFamily: "monospace" }}>
          {display} <span style={{ fontSize: 9, color: D.textD, fontWeight: 400 }}>{unit}</span>
        </span>
      </div>
      {note && <div style={{ fontSize: 8, color: D.textD, marginBottom: 5, fontStyle: "italic" }}>{note}</div>}

      {/* Track container — click area matches visual exactly */}
      <div style={{ position: "relative", height: 20, display: "flex", alignItems: "center" }}>
        {/* Background track */}
        <div style={{
          position: "absolute", left: 0, right: 0, height: 6,
          background: D.border, borderRadius: 3,
        }} />
        {/* Filled portion */}
        <div style={{
          position: "absolute", left: 0, width: `${pct}%`, height: 6,
          background: `linear-gradient(90deg, ${color}55, ${color})`,
          borderRadius: 3,
          // No transition — instant fill matching drag
        }} />
        {/* Native range input — styled to match track exactly */}
        <input
          type="range"
          min={min} max={max} step={step}
          value={local}
          onChange={handleChange}
          style={{
            position: "absolute",
            left: 0, right: 0, width: "100%",
            height: 20,
            margin: 0, padding: 0,
            opacity: 0,       // hide default appearance
            cursor: "pointer",
            zIndex: 3,        // on top for interaction
          }}
        />
        {/* Custom thumb — positioned by pct, pointer-events none so input captures events */}
        <div style={{
          position: "absolute",
          left: `calc(${pct}% - 8px)`,
          width: 16, height: 16,
          background: color,
          borderRadius: "50%",
          border: `2px solid ${D.panel}`,
          boxShadow: `0 0 8px ${color}99`,
          pointerEvents: "none",
          zIndex: 2,
          // No transition on thumb either — must feel instant
        }} />
      </div>

      {/* Min/max */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, color: D.textD, marginTop: 2 }}>
        <span>{min}</span>
        <span>{max} {unit}</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  SMALL UI ATOMS
// ═══════════════════════════════════════════════════════════════════════
const CTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#040a12", border: `1px solid ${D.border2}`, borderRadius: 6, padding: "8px 12px", fontSize: 11 }}>
      <div style={{ color: D.accent, fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, display: "flex", justifyContent: "space-between", gap: 14 }}>
          <span style={{ color: D.text }}>{p.name}</span>
          <span style={{ fontWeight: 700 }}>{typeof p.value === "number" ? p.value.toFixed(2) : p.value}</span>
        </div>
      ))}
    </div>
  );
};

const SecLabel = ({ icon, children }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "16px 0 10px" }}>
    {icon && <span style={{ fontSize: 13 }}>{icon}</span>}
    <span style={{ fontSize: 9, color: D.accent, letterSpacing: 3, fontWeight: 700, textTransform: "uppercase", whiteSpace: "nowrap" }}>{children}</span>
    <div style={{ flex: 1, height: 1, background: `linear-gradient(90deg,${D.border2},transparent)` }} />
  </div>
);

const Inp = ({ label, note, value, onChange, step = 1, min, max, unit }) => (
  <div style={{ marginBottom: 10 }}>
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
      <span style={{ fontSize: 9, color: D.textD, letterSpacing: 1, textTransform: "uppercase" }}>{label}</span>
      {unit && <span style={{ fontSize: 9, color: D.textD }}>{unit}</span>}
    </div>
    {note && <div style={{ fontSize: 8, color: "#1a4a5a", marginBottom: 3, fontStyle: "italic", lineHeight: 1.4 }}>{note}</div>}
    <input type="number" value={value} step={step} min={min} max={max}
      onChange={e => onChange(parseFloat(e.target.value) || 0)}
      style={{ width: "100%", background: D.panel3, border: `1px solid ${D.border}`, color: D.textB, padding: "6px 9px", borderRadius: 4, fontSize: 12, fontFamily: "'Courier New',monospace", outline: "none" }}
      onFocus={e => e.target.style.borderColor = D.accent}
      onBlur={e => e.target.style.borderColor = D.border}
    />
  </div>
);

const KPI = ({ label, value, unit, color, sub, glow }) => (
  <div style={{
    background: D.panel2,
    border: `1px solid ${glow ? color + "55" : D.border}`,
    borderTop: `2px solid ${color}`,
    borderRadius: 6, padding: "10px 12px",
    boxShadow: glow ? `0 0 14px ${color}22` : "none",
  }}>
    <div style={{ fontSize: 9, color: D.textD, letterSpacing: 2, marginBottom: 4, textTransform: "uppercase" }}>{label}</div>
    <div style={{ fontSize: 19, fontWeight: 700, color: color || D.accent2, fontFamily: "monospace" }}>
      {value} <span style={{ fontSize: 9, color: D.textD, fontWeight: 400 }}>{unit}</span>
    </div>
    {sub && <div style={{ fontSize: 10, color: D.textD, marginTop: 2 }}>{sub}</div>}
  </div>
);

const Badge = ({ label, color }) => (
  <span style={{ background: color + "18", border: `1px solid ${color}`, color, padding: "3px 10px", borderRadius: 3, fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>{label}</span>
);

const StepRow = ({ n, formula, calc, result, color, alt }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 5, background: alt ? "#040810" : D.panel2, border: `1px solid ${D.border}`, marginBottom: 4 }}>
    <div style={{ width: 20, height: 20, borderRadius: "50%", flexShrink: 0, background: color + "18", border: `1.5px solid ${color}`, color, fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{n}</div>
    <div style={{ flex: 2, fontSize: 11, color: D.textB, fontFamily: "monospace" }}>{formula}</div>
    <div style={{ flex: 2, fontSize: 10, color: D.textD, fontFamily: "monospace" }}>= {calc}</div>
    <div style={{ fontSize: 12, fontWeight: 700, color, fontFamily: "monospace", textAlign: "right", minWidth: 110 }}>{result}</div>
  </div>
);

// Simple bar gauge — no animation transition to avoid lag
const GaugeBar = ({ label, value, max, color }) => (
  <div style={{ marginBottom: 8 }}>
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
      <span style={{ fontSize: 9, color: D.textD }}>{label}</span>
      <span style={{ fontSize: 11, color, fontWeight: 700, fontFamily: "monospace" }}>{value} lb·ft</span>
    </div>
    <div style={{ height: 4, background: D.border, borderRadius: 2 }}>
      <div style={{ width: `${Math.min(100, value / max * 100)}%`, height: "100%", background: color, borderRadius: 2 }} />
    </div>
  </div>
);

// Frequency zone bar
const FreqZone = ({ f0, f_crit, f_back }) => {
  const pb = (f_back / f0) * 100;
  const pc = (f_crit / f0) * 100;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 9, color: D.textD, letterSpacing: 2, marginBottom: 5, textTransform: "uppercase" }}>Zonas de frecuencia</div>
      <div style={{ position: "relative", height: 22, borderRadius: 4, overflow: "hidden", border: `1px solid ${D.border}` }}>
        <div style={{ position: "absolute", left: 0, width: `${pb}%`, height: "100%", background: D.danger + "30", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 7, color: D.danger, fontWeight: 700 }}>RETROCESO</span>
        </div>
        <div style={{ position: "absolute", left: `${pb}%`, width: `${pc - pb}%`, height: "100%", background: D.warn + "30", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 7, color: D.warn, fontWeight: 700 }}>CRÍTICA</span>
        </div>
        <div style={{ position: "absolute", left: `${pc}%`, right: 0, height: "100%", background: D.ok + "20", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 7, color: D.ok, fontWeight: 700 }}>SEGURA</span>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, color: D.textD, marginTop: 2 }}>
        <span style={{ color: D.danger }}>3Hz</span>
        <span style={{ color: D.danger }}>{f_back}Hz</span>
        <span style={{ color: D.warn }}>{f_crit}Hz</span>
        <span style={{ color: D.ok }}>{f0}Hz</span>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════
//  MAIN APP
//  KEY FIX: comp (7 ramp comparison) only recalculates when user
//  stops dragging, not on every frame. This eliminates the lag.
// ═══════════════════════════════════════════════════════════════════════
export default function App() {
  const [ci, setCi] = useState(DEMO_INPUTS);
  const setC = k => v => setCi(p => ({ ...p, [k]: v }));

  const [simT_rated, setSimT_rated] = useState(null);
  const [simT_col, setSimT_col] = useState(null);
  const [simF0, setSimF0] = useState(null);
  const [selRamp, setSelRamp] = useState(20);
  const [tab, setTab] = useState("calc");

  // "committed" values — only update after drag ends (for heavy comp calc)
  const [committed, setCommitted] = useState({ T_rated: null, T_col: null, f0: null });
  const commitTimer = useRef(null);

  const phy = useMemo(() => calcPhysics(ci), [ci]);

  const syncToSim = () => {
    setSimT_rated(phy.T_rated);
    setSimT_col(phy.T_col);
    setSimF0(ci.hz);
    setCommitted({ T_rated: phy.T_rated, T_col: phy.T_col, f0: ci.hz });
    setTab("sim");
  };

  const sT_rated = simT_rated ?? phy.T_rated;
  const sT_col = simT_col ?? phy.T_col;
  const sF0 = simF0 ?? ci.hz;

  // When sliders change: update committed values after 300ms idle
  // This means comp only recalculates after user stops dragging
  const deferCommit = useCallback((T_rated, T_col, f0) => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      setCommitted({ T_rated, T_col, f0 });
    }, 300);
  }, []);

  const handleTrChange = useCallback((v) => {
    setSimT_rated(v);
    deferCommit(v, sT_col, sF0);
  }, [sT_col, sF0, deferCommit]);

  const handleTcChange = useCallback((v) => {
    setSimT_col(v);
    deferCommit(sT_rated, v, sF0);
  }, [sT_rated, sF0, deferCommit]);

  const handleF0Change = useCallback((v) => {
    setSimF0(v);
    deferCommit(sT_rated, sT_col, v);
  }, [sT_rated, sT_col, deferCommit]);

  // rd: recalculates on every slider move (single ramp — fast)
  const rd = useMemo(() => simRamp(sT_rated, sT_col, sF0, selRamp), [sT_rated, sT_col, sF0, selRamp]);

  // comp: only recalculates after drag ends (7 ramps — deferred)
  const cT_rated = committed.T_rated ?? sT_rated;
  const cT_col = committed.T_col ?? sT_col;
  const cF0 = committed.f0 ?? sF0;
  const comp = useMemo(() => RAMPS.map(rt => {
    const r = simRamp(cT_rated, cT_col, cF0, rt);
    return { rt, ...r };
  }), [cT_rated, cT_col, cF0]);

  // tvfData: recalculates on slider move (light — just 60 points)
  const tvfData = useMemo(() => Array.from({ length: sF0 + 1 }, (_, f) => ({
    f, Tm: +(sT_rated * (f / sF0) ** 2).toFixed(1), Tc: sT_col, Ty: rd.T_yield,
  })), [sT_rated, sT_col, sF0, rd.T_yield]);

  const rf = parseFloat(rd.factor);
  const rc = RC(rf), rl = RL(rf);

  const TABS = [
    { id: "calc", label: "Calculadora" },
    { id: "sim", label: "Simulador" },
    { id: "tvf", label: "T vs Frecuencia" },
    { id: "compare", label: "Comparativa" },
  ];

  const chartM = { top: 8, right: 18, left: 0, bottom: 4 };

  return (
    <div style={{ background: D.bg, minHeight: "100vh", fontFamily: "'Courier New', monospace", color: D.text, display: "flex", flexDirection: "column" }}>

      {/* HEADER */}
      <div style={{ background: D.hdr, borderBottom: `2px solid ${D.border2}`, padding: "11px 22px", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>

        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: D.accent2, letterSpacing: 3 }}>ESP SHUTDOWN TORQUE ANALYZER</div>
          <div style={{ fontSize: 9, color: D.textD, letterSpacing: 2 }}>CALCULADORA + SIMULADOR INTERACTIVO</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
          <button onClick={() => { setCi(DEMO1); setSimT_rated(null); setSimT_col(null); setSimF0(null); setCommitted({ T_rated: null, T_col: null, f0: null }); }}
            style={{ background: D.accentD + "33", border: `1px solid ${D.accent}`, color: D.accent2, padding: "7px 13px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>
            DEMO 1 — 60Hz
          </button>
          <button title="Interpolado a 40Hz (leyes afinidad)"
            onClick={() => { setCi(DEMO2); setSimT_rated(null); setSimT_col(null); setSimF0(null); setCommitted({ T_rated: null, T_col: null, f0: null }); }}
            style={{ background: "#06627a33", border: `1px solid #2a9d6f`, color: "#2a9d6f", padding: "7px 13px", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>
            DEMO 2 — 40Hz
          </button>
          <div style={{ background: rc + "18", border: `1px solid ${rc}`, color: rc, padding: "7px 15px", borderRadius: 4, fontSize: 11, fontWeight: 700, letterSpacing: 2, boxShadow: `0 0 10px ${rc}33` }}>
            RIESGO: {rl}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* LEFT PANEL */}
        <div style={{ width: 280, background: D.panel, borderRight: `1px solid ${D.border}`, padding: "14px 13px", overflowY: "auto", flexShrink: 0 }}>

          {tab === "calc" && (
            <>
              <SecLabel icon="">Fluido</SecLabel>
              <Inp label="API Gravity" unit="°API" note="→ densidad mezcla → gradiente" value={ci.api} onChange={setC("api")} step={0.5} min={8} max={55} />
              <Inp label="BSW" unit="frac 0–1" note="→ corte de agua → densidad" value={ci.bsw} onChange={setC("bsw")} step={0.01} min={0} max={1} />
              <SecLabel icon="">Columnas</SecLabel>
              <Inp label="Columna tubería" unit="ft" note="→ P_tub = ρ·g·h" value={ci.hTub} onChange={setC("hTub")} />
              <Inp label="Columna anular" unit="ft" note="→ P_ann → contrapresión" value={ci.hAnn} onChange={setC("hAnn")} />
              <SecLabel icon="">Presiones</SecLabel>
              <Inp label="P Intake" unit="psia" value={ci.pIn} onChange={setC("pIn")} />
              <Inp label="P Discharge" unit="psia" note="→ incluye tubería+fricción+cabezal" value={ci.pDis} onChange={setC("pDis")} />
              <SecLabel icon="">Motor (Placa)</SecLabel>
              <Inp label="HP Nominal" unit="HP" note="→ T_rated = HP×5252/RPM" value={ci.hp} onChange={setC("hp")} />
              <Inp label="RPM Nominal" unit="RPM" value={ci.rpm} onChange={setC("rpm")} />
              <Inp label="Frecuencia operación" unit="Hz" value={ci.hz} onChange={setC("hz")} />
              <Inp label="Amperaje Nominal" unit="A" note="→ lf = A_med/A_nom" value={ci.ampN} onChange={setC("ampN")} />
              <Inp label="Amperaje Medido" unit="A" note="→ T_oper = T_rated × lf" value={ci.ampM} onChange={setC("ampM")} />
              <SecLabel icon="">Eficiencia bomba η</SecLabel>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 10, color: D.textD }}>T_col = T_oper × η</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: D.accent2, fontFamily: "monospace" }}>{ci.eta.toFixed(2)}</span>
              </div>
              <NativeSlider label="" value={ci.eta} onChange={v => setC("eta")(v)} min={0.40} max={0.75} step={0.01} color={D.accent} unit="" />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, color: D.textD, marginBottom: 12, marginTop: -10 }}>
                <span>0.40</span><span style={{ color: D.textD }}>típico 0.52–0.65</span><span>0.75</span>
              </div>
              <button onClick={syncToSim} style={{ width: "100%", background: `linear-gradient(135deg,${D.accentD},${D.accent}88)`, border: `1px solid ${D.accent}`, color: D.accent2, padding: "10px 0", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, letterSpacing: 2, marginTop: 4 }}>
                ENVIAR AL SIMULADOR →
              </button>
            </>
          )}

          {(tab === "sim" || tab === "tvf" || tab === "compare") && (
            <>
              <div style={{ background: D.accentD + "22", border: `1px solid ${D.accentD}`, borderRadius: 6, padding: "8px 10px", marginBottom: 14, fontSize: 10, color: D.accent2, lineHeight: 1.5 }}>
                Ajusta los sliders para explorar.<br />
                Valores iniciales de la <strong>Calculadora</strong>.
              </div>

              <SecLabel icon="">Sliders interactivos</SecLabel>

              <NativeSlider
                label="T rated — Torque nominal"
                note="HP × 5252 / RPM"
                value={sT_rated} onChange={handleTrChange}
                min={50} max={Math.max(sT_rated * 2, 600)} step={1}
                color={D.ok} unit="lb·ft"
              />
              <NativeSlider
                label="T col — Torque columna"
                note="T_oper × η  (CONSTANTE en rampa)"
                value={sT_col} onChange={handleTcChange}
                min={0} max={Math.max(sT_rated * 1.2, 400)} step={0.5}
                color={D.warn} unit="lb·ft"
              />
              <NativeSlider
                label="f₀ — Frecuencia operación"
                note="Base de la rampa VSD"
                value={sF0} onChange={handleF0Change}
                min={30} max={70} step={1}
                color={D.accent} unit="Hz"
              />

              <FreqZone f0={sF0} f_crit={rd.f_crit} f_back={rd.f_back} />

              {/* Compact derived values — no heavy components */}
              <div style={{ background: D.panel, border: `1px solid ${D.border}`, borderRadius: 6, padding: "10px 12px", marginBottom: 12 }}>
                <div style={{ fontSize: 9, color: D.textD, letterSpacing: 2, marginBottom: 8, textTransform: "uppercase" }}>Torques (lb·ft)</div>
                <GaugeBar label="T nominal" value={sT_rated} max={rd.T_yield} color={D.ok} />
                <GaugeBar label="T columna" value={sT_col} max={rd.T_yield} color={D.warn} />
                <GaugeBar label="T yield" value={rd.T_yield} max={rd.T_yield} color={D.danger} />
              </div>

              <div style={{ background: D.panel, border: `1px solid ${D.border}`, borderRadius: 6, padding: "10px 12px", marginBottom: 12 }}>
                <div style={{ fontSize: 9, color: D.textD, letterSpacing: 2, marginBottom: 6, textTransform: "uppercase" }}>Frecuencias críticas</div>
                {[
                  ["f crítica", rd.f_crit + " Hz", D.warn],
                  ["f retroceso", rd.f_back + " Hz", D.danger],
                  ["T yield", rd.T_yield + " lb·ft", D.danger],
                ].map(([k, v, c]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${D.border}`, fontSize: 11 }}>
                    <span style={{ color: D.textD }}>{k}</span>
                    <span style={{ color: c, fontWeight: 700, fontFamily: "monospace" }}>{v}</span>
                  </div>
                ))}
              </div>

              {/* Numeric overrides */}
              <SecLabel icon="">Ingresar valor exacto</SecLabel>
              <Inp label="T rated" unit="lb·ft" value={sT_rated} onChange={v => { setSimT_rated(v); deferCommit(v, sT_col, sF0); }} step={1} />
              <Inp label="T col" unit="lb·ft" value={sT_col} onChange={v => { setSimT_col(v); deferCommit(sT_rated, v, sF0); }} step={0.5} />
              <Inp label="f₀" unit="Hz" value={sF0} onChange={v => { setSimF0(v); deferCommit(sT_rated, sT_col, v); }} step={1} />

              {/* Ramp selector */}
              <SecLabel icon="">Rampa VSD</SecLabel>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 4, marginBottom: 8 }}>
                {RAMPS.map(r => (
                  <button key={r} onClick={() => setSelRamp(r)} style={{
                    background: selRamp === r ? D.accentD + "44" : "transparent",
                    border: `1px solid ${selRamp === r ? D.accent : D.border}`,
                    color: selRamp === r ? D.accent2 : D.textD,
                    padding: "6px 2px", borderRadius: 4, cursor: "pointer",
                    fontSize: 11, fontFamily: "inherit", fontWeight: selRamp === r ? 700 : 400,
                  }}>{r}s</button>
                ))}
              </div>

              <button onClick={() => setTab("calc")} style={{ width: "100%", background: "transparent", border: `1px solid ${D.border}`, color: D.textD, padding: "7px 0", borderRadius: 5, cursor: "pointer", fontFamily: "inherit", fontSize: 10, marginTop: 6, letterSpacing: 2 }}>
                ← VOLVER A CALCULADORA
              </button>
            </>
          )}
        </div>

        {/* RIGHT: TABS */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ display: "flex", background: D.panel, borderBottom: `1px solid ${D.border}`, flexShrink: 0 }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                background: tab === t.id ? "#040b16" : "transparent",
                border: "none", borderBottom: `2px solid ${tab === t.id ? D.accent : "transparent"}`,
                color: tab === t.id ? D.accent2 : D.textD,
                padding: "11px 18px", cursor: "pointer", fontSize: 11,
                fontFamily: "inherit", fontWeight: tab === t.id ? 700 : 400, letterSpacing: 1,
              }}>{t.label}</button>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>

            {/* ══ CALCULADORA ══ */}
            {tab === "calc" && (
              <div>
                <div style={{ fontSize: 9, color: D.textD, letterSpacing: 2, marginBottom: 14 }}>RESULTADOS DE CÁLCULO — PUNTO DE PARTIDA PARA EL SIMULADOR</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 9, marginBottom: 16 }}>
                  <KPI label="T nominal eje" value={phy.T_rated} unit="lb·ft" color={D.ok} sub={`${phy.T_rated_Nm} N·m`} />
                  <KPI label="T operación real" value={phy.T_oper} unit="lb·ft" color={D.accent2} sub={`${phy.T_oper_Nm} N·m`} />
                  <KPI label="T columna (reverso)" value={phy.T_col} unit="lb·ft" color={D.warn} sub="CONSTANTE en rampa" glow />
                  <KPI label="T yield (rotura)" value={phy.T_yield} unit="lb·ft" color={D.danger} sub="Factor 1.60×" />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 9, marginBottom: 16 }}>
                  <KPI label="f crítica" value={phy.f_crit} unit="Hz" color={D.warn} glow />
                  <KPI label="f retroceso" value={phy.f_back} unit="Hz" color={D.danger} glow />
                  <KPI label="Carga motor" value={phy.lf_pct} unit="%" color={phy.lf_pct > 95 ? D.warn : D.ok} />
                  <KPI label="Margen yield" value={phy.safety} unit="%" color={phy.safety < 15 ? D.danger : phy.safety > 30 ? D.ok : D.warn} />
                </div>
                <div style={{ background: D.panel2, border: `1px solid ${D.border}`, borderRadius: 8, padding: "14px 16px", marginBottom: 16 }}>
                  <div style={{ fontSize: 9, color: D.textD, letterSpacing: 2, marginBottom: 10 }}>CADENA DE CÁLCULO — TRAZABILIDAD COMPLETA</div>
                  <StepRow n={1} formula="T_rated = HP × 5252 / RPM" calc={`${ci.hp} × 5252 / ${ci.rpm}`} result={`${phy.T_rated} lb·ft`} color={D.ok} />
                  <StepRow n={2} formula="lf     = A_medido / A_nominal" calc={`${ci.ampM} / ${ci.ampN}`} result={`${phy.lf_pct}%`} color={D.accent} alt />
                  <StepRow n={3} formula="T_oper = T_rated × lf" calc={`${phy.T_rated} × ${(phy.lf_pct / 100).toFixed(2)}`} result={`${phy.T_oper} lb·ft`} color={D.accent2} />
                  <StepRow n={4} formula="T_col  = T_oper × η  ← CONSTANTE" calc={`${phy.T_oper} × ${ci.eta.toFixed(2)}`} result={`${phy.T_col} lb·ft`} color={D.warn} alt />
                  <StepRow n={5} formula="f_crit = f₀ × √(T_col/T_rated)" calc={`${ci.hz} × √(${phy.T_col}/${phy.T_rated})`} result={`${phy.f_crit} Hz`} color={D.warn} />
                  <StepRow n={6} formula="f_back = f_crit × 0.85" calc={`${phy.f_crit} × 0.85`} result={`${phy.f_back} Hz`} color={D.danger} alt />
                  <StepRow n={7} formula="T_yield = T_rated × 1.60" calc={`${phy.T_rated} × 1.60`} result={`${phy.T_yield} lb·ft`} color={D.danger} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                  <div style={{ background: D.panel2, border: `1px solid ${D.border}`, borderRadius: 8, padding: "12px 14px" }}>
                    <div style={{ fontSize: 9, color: D.textD, letterSpacing: 2, marginBottom: 10 }}>COMPARATIVA TORQUES (lb·ft)</div>
                    <ResponsiveContainer width="100%" height={170}>
                      <BarChart data={[
                        { n: "T nominal", v: phy.T_rated, c: D.ok },
                        { n: "T oper", v: phy.T_oper, c: D.accent },
                        { n: "T col", v: phy.T_col, c: D.warn },
                        { n: "T yield", v: phy.T_yield, c: D.danger },
                      ]} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
                        <XAxis dataKey="n" tick={{ fontSize: 9, fill: D.textD }} stroke={D.border} />
                        <YAxis tick={{ fontSize: 9, fill: D.textD }} stroke={D.border} />
                        <Tooltip content={<CTip />} />
                        <Bar dataKey="v" name="lb·ft" radius={[3, 3, 0, 0]}>
                          {[D.ok, D.accent, D.warn, D.danger].map((c, i) => <Cell key={i} fill={c} fillOpacity={0.8} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ background: D.panel2, border: `1px solid ${D.border}`, borderRadius: 8, padding: "12px 14px" }}>
                    <div style={{ fontSize: 9, color: D.textD, letterSpacing: 2, marginBottom: 10 }}>FLUIDO & COLUMNAS</div>
                    {[
                      ["ρ mezcla", phy.rho + " lb/ft³", D.textB],
                      ["Gradiente", phy.grad + " psi/ft", D.textB],
                      ["P col. tubería", phy.P_tub + " psi", D.accent],
                      ["P col. anular", phy.P_ann + " psi", D.ok],
                      ["ΔP neto col.", phy.dP_hyd + " psi", D.warn],
                      ["ΔP bomba medido", phy.dP + " psi", D.accent2],
                    ].map(([k, v, c]) => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: `1px solid ${D.border}`, fontSize: 11 }}>
                        <span style={{ color: D.textD }}>{k}</span>
                        <span style={{ color: c, fontWeight: 700, fontFamily: "monospace" }}>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ background: "#040f1a", border: `1px solid ${D.border2}`, borderLeft: `4px solid ${D.accent}`, borderRadius: 6, padding: "11px 14px", fontSize: 11, color: "#8ab0c8", lineHeight: 1.8 }}>
                  <strong style={{ color: D.accent }}>Por qué T_col es constante:</strong> T_col = (ΔP×Q)/ω → Q = (T_oper×ω×η)/ΔP → <strong style={{ color: D.warn }}>T_col = T_oper × η</strong>. El ΔP y ω se cancelan. T_motor(f) = T_rated×(f/f₀)² cae con f². Se cruzan en <strong style={{ color: D.warn }}>f_crítica = {phy.f_crit} Hz</strong>.
                </div>
              </div>
            )}

            {/* ══ SIMULADOR ══ */}
            {tab === "sim" && (
              <div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
                  <span style={{ fontSize: 9, color: D.textD, letterSpacing: 2 }}>RAMPA {selRamp}s · {sF0}Hz → 3Hz</span>
                  <Badge label={`FACTOR ${rd.factor}× · ${rl}`} color={rc} />
                  {rd.failTime !== null && <Badge label={`⚠ YIELD t=${rd.failTime.toFixed(1)}s`} color={D.danger} />}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 9, marginBottom: 14 }}>
                  <KPI label="T pico en eje" value={rd.peakT} unit="lb·ft" color={rf > 1.1 ? D.warn : D.ok} glow={rf > 1.1} />
                  <KPI label="Factor T/T_rated" value={rd.factor + "×"} unit="" color={rc} glow />
                  <KPI label="t torque máx" value={rd.peakTime + "s"} unit="" color={D.accent2} />
                  <KPI label="Inicio retroceso" value={rd.bfTime !== null ? rd.bfTime.toFixed(1) + "s" : "No ocurre"} unit="" color={rd.bfTime !== null ? D.warn : D.ok} />
                </div>
                {rd.bfTime !== null ? (
                  <div style={{ background: "#180808", border: `1px solid #7f1d1d`, borderLeft: `4px solid ${D.danger}`, borderRadius: 5, padding: "10px 14px", marginBottom: 12, fontSize: 11, color: "#fca5a5", lineHeight: 1.7 }}>
                    <strong>FLUJO REVERSO</strong> en t={rd.bfTime.toFixed(1)}s (f≈{rd.f_back} Hz). Columna actúa como <strong>turbina inversa</strong>. T_col={sT_col} lb·ft se suma al T_motor.
                    {rd.failTime !== null && <strong> ⛔ T_yield superado en t={rd.failTime.toFixed(1)}s — RIESGO DE ROTURA.</strong>}
                  </div>
                ) : (
                  <div style={{ background: "#040f08", border: `1px solid #14532d`, borderLeft: `4px solid ${D.ok}`, borderRadius: 5, padding: "9px 13px", marginBottom: 12, fontSize: 11, color: "#86efac" }}>
                    ✅ Sin flujo reverso en esta rampa.
                  </div>
                )}
                <div style={{ background: D.panel2, border: `1px solid ${D.border}`, borderRadius: 8, padding: "12px 14px", marginBottom: 10 }}>
                  <div style={{ fontSize: 9, color: D.textD, letterSpacing: 2, marginBottom: 8 }}>TORQUE EN EJE vs TIEMPO — RAMPA {selRamp}s (lb·ft)</div>
                  <ResponsiveContainer width="100%" height={250}>
                    <AreaChart data={rd.data} margin={chartM}>
                      <defs>
                        <linearGradient id="gTs" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={D.danger} stopOpacity={0.25} /><stop offset="95%" stopColor={D.danger} stopOpacity={0.02} />
                        </linearGradient>
                        <linearGradient id="gTr" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={D.warn} stopOpacity={0.2} /><stop offset="95%" stopColor={D.warn} stopOpacity={0.02} />
                        </linearGradient>
                        <linearGradient id="gTm" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={D.accent} stopOpacity={0.1} /><stop offset="95%" stopColor={D.accent} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
                      <XAxis dataKey="t" stroke={D.border2} tick={{ fill: D.textD, fontSize: 10 }} label={{ value: "Tiempo (s)", position: "insideBottom", fill: D.textD, fontSize: 10 }} />
                      <YAxis stroke={D.border2} tick={{ fill: D.textD, fontSize: 10 }} label={{ value: "Torque lb·ft", angle: -90, position: "insideLeft", fill: D.textD, fontSize: 10 }} />
                      <Tooltip content={<CTip />} />
                      <Legend
                        verticalAlign="bottom"
                        align="center"
                        iconType="line"
                        wrapperStyle={{ fontSize: 10, color: D.textD, paddingTop: 8 }}
                      />
                      <ReferenceLine y={sT_rated} stroke={D.ok} strokeDasharray="5 3"
                        label={{ value: `T_rated: ${sT_rated}`, fill: D.ok, fontSize: 9, position: "insideTopLeft" }} />
                      <ReferenceLine y={sT_col} stroke={D.warn} strokeDasharray="5 3"
                        label={{ value: `T_col: ${sT_col}`, fill: D.warn, fontSize: 9, position: "insideBottomRight" }} />
                      <ReferenceLine y={rd.T_yield} stroke={D.danger} strokeDasharray="5 3"
                        label={{ value: `T_yield: ${rd.T_yield}`, fill: D.danger, fontSize: 9, position: "insideTopRight" }} />
                      <Area type="monotone" dataKey="Ts" name="T Eje total (lb·ft)" stroke={D.danger} fill="url(#gTs)" strokeWidth={2.5} dot={false} />
                      <Area type="monotone" dataKey="Trev" name="T Reverso columna (lb·ft)" stroke={D.warn} fill="url(#gTr)" strokeWidth={1.5} dot={false} />
                      <Area type="monotone" dataKey="Tm" name="T Motor (lb·ft)" stroke={D.accent} fill="url(#gTm)" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ background: D.panel2, border: `1px solid ${D.border}`, borderRadius: 8, padding: "12px 14px" }}>
                  <div style={{ fontSize: 9, color: D.textD, letterSpacing: 2, marginBottom: 8 }}>FRECUENCIA VSD — ZONAS DE RIESGO</div>
                  <ResponsiveContainer width="100%" height={140}>
                    <AreaChart data={rd.data} margin={chartM}>
                      <defs>
                        <linearGradient id="gF" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={D.accent} stopOpacity={0.2} /><stop offset="95%" stopColor={D.accent} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
                      <XAxis dataKey="t" stroke={D.border2} tick={{ fill: D.textD, fontSize: 10 }} />
                      <YAxis stroke={D.border2} tick={{ fill: D.textD, fontSize: 10 }} />
                      <Tooltip content={<CTip />} />
                      <ReferenceLine y={rd.f_crit} stroke={D.warn} strokeDasharray="5 3"
                        label={{ value: `f_crit: ${rd.f_crit} Hz`, fill: D.warn, fontSize: 9, position: "insideBottomRight" }} />
                      <ReferenceLine y={rd.f_back} stroke={D.danger} strokeDasharray="5 3"
                        label={{ value: `f_back: ${rd.f_back} Hz`, fill: D.danger, fontSize: 9, position: "insideTopRight" }} />
                      <Area type="monotone" dataKey="f" name="Frecuencia (Hz)" stroke={D.accent} fill="url(#gF)" strokeWidth={2} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* ══ T vs FRECUENCIA ══ */}
            {tab === "tvf" && (
              <div>
                <div style={{ background: D.panel2, border: `1px solid ${D.border}`, borderRadius: 8, padding: "12px 14px", marginBottom: 14 }}>
                  <div style={{ fontSize: 9, color: D.textD, letterSpacing: 2, marginBottom: 4 }}>T_motor(f²) vs T_col (CONSTANTE) — intersección = f_crítica = {rd.f_crit} Hz</div>
                  <div style={{ fontSize: 10, color: D.textD, marginBottom: 10 }}>T_motor = T_rated × (f/f₀)² cae con f². T_col = {sT_col} lb·ft es constante. A la izquierda de f_crit → flujo reverso.</div>
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={tvfData} margin={chartM}>
                      <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
                      <XAxis dataKey="f" stroke={D.border2} tick={{ fill: D.textD, fontSize: 10 }} label={{ value: "Frecuencia (Hz)", position: "insideBottom", fill: D.textD, fontSize: 10 }} />
                      <YAxis stroke={D.border2} tick={{ fill: D.textD, fontSize: 10 }} label={{ value: "Torque (lb·ft)", angle: -90, position: "insideLeft", fill: D.textD, fontSize: 10 }} />
                      <Tooltip content={<CTip />} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <ReferenceLine x={rd.f_crit} stroke={D.warn} strokeDasharray="6 3"
                        label={{ value: `f_crit ${rd.f_crit}Hz`, fill: D.warn, fontSize: 9, position: "insideTopLeft" }} />
                      <ReferenceLine x={rd.f_back} stroke={D.danger} strokeDasharray="6 3"
                        label={{ value: `f_back ${rd.f_back}Hz`, fill: D.danger, fontSize: 9, position: "insideBottomLeft" }} />
                      <Line type="monotone" dataKey="Tm" name="T motor (f²) lb·ft" stroke={D.accent} dot={false} strokeWidth={2.5} />
                      <Line type="monotone" dataKey="Tc" name="T columna (constante) lb·ft" stroke={D.warn} dot={false} strokeWidth={2} strokeDasharray="5 3" />
                      <Line type="monotone" dataKey="Ty" name="T yield lb·ft" stroke={D.danger} dot={false} strokeWidth={1} strokeDasharray="3 3" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    { color: D.ok, title: `ZONA SEGURA  f > ${rd.f_crit} Hz`, body: "T_motor > T_col. La bomba desacelera normalmente. Sin riesgo de inversión." },
                    { color: D.warn, title: `ZONA CRÍTICA  f ≈ ${rd.f_crit} Hz`, body: "T_motor ≈ T_col. Inestabilidad hidráulica y pulsaciones. Zona de fatiga." },
                    { color: D.danger, title: `FLUJO REVERSO  f < ${rd.f_back} Hz`, body: "T_motor < T_col. La columna invierte flujo — turbina inversa. Estrés máximo en eje." },
                    { color: "#a855f7", title: `ROTURA  T > ${rd.T_yield} lb·ft`, body: "Si T_total supera T_yield el eje falla. Rampas largas = más ciclos de fatiga." },
                  ].map(({ color, title, body }) => (
                    <div key={title} style={{ background: D.panel2, border: `1px solid ${color}33`, borderLeft: `3px solid ${color}`, borderRadius: 6, padding: "10px 12px" }}>
                      <div style={{ fontSize: 9, color, fontWeight: 700, marginBottom: 4 }}>{title}</div>
                      <div style={{ fontSize: 11, color: "#8ab0c8", lineHeight: 1.6 }}>{body}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ══ COMPARATIVA ══ */}
            {tab === "compare" && (
              <div>
                <div style={{ fontSize: 9, color: D.textD, letterSpacing: 2, marginBottom: 12 }}>
                  COMPARATIVA TODAS LAS RAMPAS · f_crit={rd.f_crit} Hz · T_col={sT_col} lb·ft
                  <span style={{ color: D.textD, marginLeft: 10, fontSize: 8 }}>(se actualiza al soltar el slider)</span>
                </div>
                <div style={{ background: D.panel2, border: `1px solid ${D.border}`, borderRadius: 8, padding: "12px 14px", marginBottom: 12 }}>
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={comp.map(r => ({ rt: r.rt + "s", factor: r.factor }))} margin={chartM}>
                      <defs>
                        <linearGradient id="gCp" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={D.accent} stopOpacity={0.18} /><stop offset="95%" stopColor={D.accent} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
                      <XAxis dataKey="rt" stroke={D.border2} tick={{ fill: D.textD, fontSize: 11 }} />
                      <YAxis stroke={D.border2} tick={{ fill: D.textD, fontSize: 10 }} />
                      <Tooltip content={<CTip />} />
                      <ReferenceLine y={1.6} stroke={D.danger} strokeDasharray="5 3" label={{ value: "1.6× yield", fill: D.danger, fontSize: 9, position: "right" }} />
                      <ReferenceLine y={1.1} stroke={D.warn} strokeDasharray="5 3" label={{ value: "1.1× fatiga", fill: D.warn, fontSize: 9, position: "right" }} />
                      <ReferenceLine y={1.0} stroke={D.ok} strokeDasharray="5 3" label={{ value: "1.0× nominal", fill: D.ok, fontSize: 9, position: "right" }} />
                      <Area type="monotone" dataKey="factor" name="Factor T pico/T_rated"
                        stroke={D.accent} fill="url(#gCp)" strokeWidth={2.5}
                        dot={(p) => { const c = RC(p.payload.factor); return <circle key={p.payload.rt} cx={p.cx} cy={p.cy} r={6} fill={c} stroke={D.panel} strokeWidth={1.5} />; }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 14 }}>
                  <thead>
                    <tr style={{ background: "#030810" }}>
                      {["Rampa", "T pico (lb·ft)", "Factor", "t retroceso", "t yield", "Fatiga", "Riesgo"].map(h => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: D.textD, borderBottom: `1px solid ${D.border}`, fontSize: 9, letterSpacing: 1, textTransform: "uppercase" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {comp.map(r => {
                      const rc2 = RC(r.factor);
                      return (
                        <tr key={r.rt} onClick={() => { setSelRamp(r.rt); setTab("sim"); }}
                          style={{ background: r.rt === selRamp ? D.accentD + "18" : "transparent", borderBottom: `1px solid ${D.border}`, cursor: "pointer" }}>
                          <td style={{ padding: "8px 12px", color: r.rt === selRamp ? D.accent2 : D.textB, fontWeight: r.rt === selRamp ? 700 : 400 }}>{r.rt}s {r.rt === selRamp ? "◀" : ""}</td>
                          <td style={{ padding: "8px 12px", fontFamily: "monospace", color: D.textB }}>{r.peakT.toFixed(0)}</td>
                          <td style={{ padding: "8px 12px", color: rc2, fontWeight: 700, fontFamily: "monospace" }}>{r.factor.toFixed(3)}×</td>
                          <td style={{ padding: "8px 12px", color: r.bfTime !== null ? D.warn : D.ok }}>{r.bfTime !== null ? r.bfTime.toFixed(1) + "s" : "—"}</td>
                          <td style={{ padding: "8px 12px", color: r.failTime !== null ? D.danger : D.ok }}>{r.failTime !== null ? r.failTime.toFixed(1) + "s" : "—"}</td>
                          <td style={{ padding: "8px 12px", fontFamily: "monospace", color: r.fatigue > 500 ? D.warn : D.text }}>{r.fatigue.toFixed(0)}</td>
                          <td style={{ padding: "8px 12px" }}><span style={{ background: rc2 + "18", border: `1px solid ${rc2}`, color: rc2, padding: "2px 9px", borderRadius: 3, fontSize: 9, fontWeight: 700 }}>{RL(r.factor)}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {(() => {
                  const minFactor = Math.min(...comp.map(r => r.factor));
                  const maxFactor = Math.max(...comp.map(r => r.factor));
                  const allEqual = (maxFactor - minFactor) < 0.001;
                  const best = comp.reduce((a, b) => a.factor < b.factor ? a : b);
                  const worst = comp.reduce((a, b) => a.factor > b.factor ? a : b);
                  const safe = comp.filter(r => r.bfTime === null);
                  // When factors are equal, rank by fatigue (lower = better)
                  const bestFatigue = comp.reduce((a, b) => a.fatigue < b.fatigue ? a : b);
                  const worstFatigue = comp.reduce((a, b) => a.fatigue > b.fatigue ? a : b);
                  const allSafe = comp.every(r => r.bfTime === null);
                  const allReverso = comp.every(r => r.bfTime !== null);
                  return (
                    <div style={{ background: "#040f1a", border: `1px solid ${D.border2}`, borderLeft: `4px solid ${D.accent}`, borderRadius: 6, padding: "12px 16px", fontSize: 12, color: "#8ab0c8", lineHeight: 1.9 }}>
                      <div style={{ fontSize: 9, color: D.accent, letterSpacing: 2, fontWeight: 700, marginBottom: 8 }}>▸ RECOMENDACIÓN OPERACIONAL</div>

                      {(() => {
                        // -- Fatigue analysis --
                        const allZeroFatigue = comp.every(r => r.fatigue < 0.5);
                        const fatigueDiff = worstFatigue.fatigue - bestFatigue.fatigue;
                        const fatigueMatters = fatigueDiff > 10;

                        // -- Backflow severity --
                        // Backflow exists but factor=1 means it's weak — not dangerous
                        const backflowDangerous = allReverso && minFactor > 1.05;
                        const backflowWeak = allReverso && minFactor <= 1.05;

                        return (
                          <>
                            {/* TORQUE ANALYSIS */}
                            {allEqual ? (
                              <div style={{ background: D.ok + "18", border: `1px solid ${D.ok}44`, borderRadius: 4, padding: "8px 12px", marginBottom: 8, fontSize: 11 }}>
                                <strong style={{ color: D.ok }}>Factor de torque idéntico en todas las rampas ({minFactor.toFixed(3)}×)</strong><br />
                                <span style={{ color: D.textB }}>El pico ocurre al inicio al cruzar f_crit={rd.f_crit} Hz. La duración de la rampa no lo cambia.</span>
                              </div>
                            ) : (
                              <>
                                ✅ <strong style={{ color: D.ok }}>Rampa óptima: {best.rt}s</strong> — Factor: {best.factor.toFixed(3)}× · Fatiga: {best.fatigue.toFixed(0)}<br />
                                ❌ <strong style={{ color: D.danger }}>Rampa más riesgosa: {worst.rt}s</strong> — Factor: {worst.factor.toFixed(3)}× · Fatiga: {worst.fatigue.toFixed(0)}<br />
                              </>
                            )}

                            {/* FATIGUE ANALYSIS */}
                            {allZeroFatigue ? (
                              <div style={{ marginTop: 4 }}>
                                ✅ <strong style={{ color: D.ok }}>Fatiga cero en todas las rampas</strong> — el torque nunca supera T_rated durante la desaceleración.
                              </div>
                            ) : fatigueMatters ? (
                              <div style={{ marginTop: 4 }}>
                                ✅ <strong style={{ color: D.ok }}>Menor fatiga: {bestFatigue.rt}s</strong> — {bestFatigue.fatigue.toFixed(0)} lb·ft·s<br />
                                <strong style={{ color: D.warn }}>Mayor fatiga: {worstFatigue.rt}s</strong> — {worstFatigue.fatigue.toFixed(0)} lb·ft·s
                                <span style={{ color: D.textD, fontSize: 10, display: "block", marginTop: 2 }}>→ Usa la rampa más corta para minimizar fatiga acumulada.</span>
                              </div>
                            ) : null}

                            {/* BACKFLOW ANALYSIS — severity-aware */}
                            <div style={{ marginTop: 6 }}>
                              {allSafe ? (
                                <span style={{ color: D.ok }}>✅ Sin flujo reverso en ninguna rampa — condición ideal.<br /></span>
                              ) : backflowWeak ? (
                                <span style={{ color: D.textB }}>
                                  ℹ️ Flujo reverso presente pero débil (factor={minFactor.toFixed(3)}× ≤ 1.05) —
                                  la columna invierte pero no genera sobre-torque significativo.
                                  {allEqual && minFactor <= 1.0 ? " Cualquier rampa es válida." : " Prefiere rampa corta."}<br />
                                </span>
                              ) : backflowDangerous ? (
                                <span style={{ color: D.warn }}>⚠️ Flujo reverso con sobre-torque — considerar válvula de retención.<br /></span>
                              ) : (
                                <span>🛡 <strong>Sin flujo reverso en:</strong> {safe.map(r => r.rt + "s").join(", ")}<br /></span>
                              )}
                            </div>
                          </>
                        );
                      })()}

                      <span style={{ color: D.textD, fontSize: 11 }}>
                        T_rated={sT_rated} · T_col={sT_col} lb·ft · f_crit={rd.f_crit} Hz · T_yield={rd.T_yield} lb·ft
                      </span>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}