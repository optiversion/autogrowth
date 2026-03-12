import { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

/*
  autogrowth v5
  
  Faithful to karpathy/autoresearch:
  - ONE thing being optimized (the usage-limit intervention)
  - ONE metric (incremental paid conversion vs holdout)
  - Changes are CUMULATIVE — if it works, it persists
  - Each experiment changes ONE lever from the current best
  - The log is the product
*/

const PROGRAM_MD = `# program.md — Autonomous Lifecycle Experiment
# The human writes this. The system executes it.
# Inspired by karpathy/autoresearch.
#
# "You're not touching the Python files like you
#  normally would as a researcher. Instead, you
#  are programming the program.md that provides
#  context to the AI agents and sets up your
#  autonomous research org." — Karpathy

## The intervention
A free-tier ChatGPT user hits their daily usage
limit. Today they see an in-app paywall. Nothing
else happens. No follow-up. No email. No push.
No re-engagement if they leave.

This moment happens millions of times per week.
It is the single highest-leverage conversion
opportunity in the product.

## Objective
Maximize incremental free-to-paid conversion
from the usage-limit moment.
Baseline (no intervention): 2.80%
Target: 4.00%+

## Fixed budget
Each experiment: 72 hours, 10K users
Treatment (90%) vs holdout (10%)
Holdout = current best (or no intervention)

## The levers (what the system may change)
Each experiment modifies ONE lever from the
current best configuration:

Channel    Email | Push | In-app | Email+Push
Timing     Immediate | 2h after | 6h after |
           Next morning | 24h after
Frame      Direct benefit | Loss aversion |
           Social proof | ROI calculation |
           Feature discovery | Curiosity gap
Format     Short (2 lines) | Medium (paragraph) |
           Rich (with usage stats)
Tone       Professional | Casual | Urgent |
           Educational | Empathetic
Sequence   Single touch | 2-touch (24h apart) |
           3-touch (24h intervals)

## The loop
1. Read full experiment log
2. Identify which lever to modify next
3. Generate variant (change ONE thing)
4. Run against holdout for 72h
5. Evaluate: did conversion improve?
6. KEEP (new baseline) or REVERT (try next)
7. Write result to log
8. Repeat

## Guardrails
Unsubscribe rate must stay < 0.30%
Max 2 touches per user per sequence
Never reference conversation content
If guardrail trips → BLOCK + revert

## Design note
The system changes only one lever at a time
so we can attribute what caused the change.
This is the same principle as autoresearch:
one modification, one evaluation, clear signal.`;

const LEVERS = {
  channel: ["Email", "Push", "In-app", "Email+Push"],
  timing: ["Immediate", "2h after", "6h after", "Next morning", "24h after"],
  frame: ["Direct benefit", "Loss aversion", "Social proof", "ROI calculation", "Feature discovery", "Curiosity gap"],
  format: ["Short", "Medium", "Rich (usage stats)"],
  tone: ["Professional", "Casual", "Urgent", "Educational", "Empathetic"],
  sequence: ["Single touch", "2-touch", "3-touch"],
};

const LEVER_NAMES = Object.keys(LEVERS);

const INITIAL_STATE = {
  channel: "Email",
  timing: "6h after",
  frame: "Direct benefit",
  format: "Medium",
  tone: "Professional",
  sequence: "Single touch",
};

function pickModification(currentState, log) {
  // Look at what's been tried: avoid repeating exact combos
  const triedKeys = new Set(log.map(e => e.stateKey));

  // Pick a lever to modify — prefer levers least recently changed
  const leverChangeCounts = {};
  LEVER_NAMES.forEach(l => { leverChangeCounts[l] = 0; });
  log.forEach(e => { if (e.changedLever) leverChangeCounts[e.changedLever]++; });

  // Sort levers by least explored
  const sortedLevers = [...LEVER_NAMES].sort((a, b) => leverChangeCounts[a] - leverChangeCounts[b]);

  // Try each lever, find an untried value
  for (const lever of sortedLevers) {
    const currentVal = currentState[lever];
    const options = LEVERS[lever].filter(v => v !== currentVal);

    for (const option of options) {
      const newState = { ...currentState, [lever]: option };
      const key = Object.values(newState).join("|");
      if (!triedKeys.has(key)) {
        return { lever, from: currentVal, to: option, newState, key };
      }
    }
  }

  // Fallback: random change
  const lever = LEVER_NAMES[Math.floor(Math.random() * LEVER_NAMES.length)];
  const options = LEVERS[lever].filter(v => v !== currentState[lever]);
  const to = options[Math.floor(Math.random() * options.length)];
  const newState = { ...currentState, [lever]: to };
  return { lever, from: currentState[lever], to, newState, key: Object.values(newState).join("|") };
}

function simulateResult(modification, expNum, currentBase) {
  // Base conversion improves slightly as experiments accumulate (the system gets better)
  const base = currentBase;

  // Some lever changes are more likely to help than others
  const leverBonus = {
    channel: { "Push": 0.15, "In-app": 0.1, "Email+Push": 0.25, "Email": 0 },
    timing: { "2h after": 0.2, "Immediate": 0.05, "Next morning": 0.1, "6h after": 0, "24h after": -0.1 },
    frame: { "Loss aversion": 0.25, "ROI calculation": 0.2, "Feature discovery": 0.15, "Social proof": 0.1, "Curiosity gap": 0.1, "Direct benefit": 0 },
    format: { "Rich (usage stats)": 0.2, "Short": -0.05, "Medium": 0 },
    tone: { "Empathetic": 0.15, "Educational": 0.1, "Casual": 0.05, "Urgent": -0.1, "Professional": 0 },
    sequence: { "2-touch": 0.2, "3-touch": 0.1, "Single touch": 0 },
  };

  const bonus = (leverBonus[modification.lever]?.[modification.to] || 0);
  const noise = (Math.random() * 0.8 - 0.4);
  const lift = bonus + noise;

  const holdoutConv = base + (Math.random() * 0.15 - 0.075);
  const treatmentConv = Math.max(0.5, holdoutConv + lift);
  const incLift = treatmentConv - holdoutConv;

  const pVal = Math.abs(incLift) > 0.25
    ? Math.max(0.001, Math.random() * 0.06)
    : 0.04 + Math.random() * 0.92;
  const sig = pVal < 0.05;
  const pos = incLift > 0.08;

  // ~6% chance of guardrail violation
  const unsubRate = Math.random() < 0.06 ? 0.31 + Math.random() * 0.1 : Math.random() * 0.24;
  const healthOk = unsubRate < 0.3;

  const decision = !healthOk ? "BLOCK" : (sig && pos) ? "KEEP" : "REVERT";

  return {
    tConv: treatmentConv.toFixed(2),
    hConv: holdoutConv.toFixed(2),
    incLift: incLift.toFixed(2),
    pVal: pVal.toFixed(3),
    sig, pos, decision, healthOk,
    unsubRate: unsubRate.toFixed(2),
  };
}

const PHASES = [
  { key: "read", label: "READ LOG", dur: 800 },
  { key: "analyze", label: "ANALYZE", dur: 1000 },
  { key: "modify", label: "MODIFY", dur: 1200 },
  { key: "split", label: "SPLIT", dur: 500 },
  { key: "run", label: "RUN 72H", dur: 5500 },
  { key: "evaluate", label: "EVALUATE", dur: 2000 },
  { key: "decide", label: "DECIDE", dur: 1400 },
  { key: "write", label: "WRITE LOG", dur: 600 },
];

const DC = { KEEP: "#4ade80", REVERT: "#fbbf24", BLOCK: "#f87171" };

function StateDisplay({ state, changedLever, highlightNew }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
      {LEVER_NAMES.map(lever => {
        const isChanged = lever === changedLever;
        return (
          <div key={lever}>
            <span style={{ fontSize: 9, color: "#52525b", letterSpacing: "0.04em" }}>{lever}: </span>
            <span style={{
              fontSize: 11, fontWeight: isChanged ? 700 : 400,
              color: isChanged && highlightNew ? "#a78bfa" : isChanged ? "#fbbf24" : "#a1a1aa",
              textDecoration: isChanged && !highlightNew ? "line-through" : "none",
              opacity: isChanged && !highlightNew ? 0.5 : 1,
            }}>
              {state[lever]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function AutoGrowth() {
  const [log, setLog] = useState([]);
  const [running, setRunning] = useState(false);
  const [phaseIdx, setPhaseIdx] = useState(-1);
  const [phaseProg, setPhaseProg] = useState(0);
  const [currentState, setCurrentState] = useState(INITIAL_STATE);
  const [curMod, setCurMod] = useState(null);
  const [curResult, setCurResult] = useState(null);
  const [chartData, setChartData] = useState([{ exp: 0, conversion: 2.80 }]);
  const [conv, setConv] = useState(2.80);
  const [showProg, setShowProg] = useState(true);
  const [progWidth, setProgWidth] = useState(440);
  const [loopNum, setLoopNum] = useState(0);

  const runRef = useRef(false);
  const logRef = useRef([]);
  const stateRef = useRef(INITIAL_STATE);
  const convRef = useRef(2.80);
  const expN = useRef(0);
  const logEndRef = useRef(null);
  const dragRef = useRef(false);
  const movedDuringDrag = useRef(false);

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragRef.current) return;
      movedDuringDrag.current = true;
      // We limit between 280px and 1000px width. e.clientX roughly equals the width since it's on the left screen edge.
      setProgWidth(Math.max(280, Math.min(1000, e.clientX)));
    };
    const onMouseUp = () => {
      dragRef.current = false;
      document.body.style.cursor = "default";
      // Defer clearing moved marker so onClick can read it when released on the button
      setTimeout(() => { movedDuringDrag.current = false; }, 100);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const animPhase = async (idx) => {
    setPhaseIdx(idx);
    setPhaseProg(0);
    const d = PHASES[idx].dur;
    const steps = 20;
    for (let s = 0; s <= steps; s++) {
      if (!runRef.current) return false;
      setPhaseProg((s / steps) * 100);
      await sleep(d / steps);
    }
    return true;
  };

  const mainLoop = useCallback(async () => {
    while (runRef.current) {
      expN.current++;
      setCurResult(null);
      setCurMod(null);

      // 1. READ LOG
      if (!await animPhase(0)) return;

      // 2. ANALYZE — decide which lever to change
      if (!await animPhase(1)) return;

      // 3. MODIFY — pick the change
      const mod = pickModification(stateRef.current, logRef.current);
      setCurMod(mod);
      if (!await animPhase(2)) return;

      // 4. SPLIT
      if (!await animPhase(3)) return;

      // 5. RUN
      if (!await animPhase(4)) return;

      // 6. EVALUATE
      const result = simulateResult(mod, expN.current, convRef.current);
      setCurResult(result);
      if (!await animPhase(5)) return;

      // 7. DECIDE
      if (!await animPhase(6)) return;

      // Build log entry
      const entry = {
        num: expN.current,
        changedLever: mod.lever,
        from: mod.from,
        to: mod.to,
        stateBefore: { ...stateRef.current },
        stateKey: mod.key,
        ...result,
        baseBefore: convRef.current.toFixed(2),
      };

      // Apply decision
      if (result.decision === "KEEP") {
        stateRef.current = { ...mod.newState };
        setCurrentState({ ...mod.newState });
        convRef.current = Math.min(6.0, convRef.current + parseFloat(result.incLift));
        setConv(convRef.current);
      }
      // REVERT and BLOCK: state stays the same

      entry.baseAfter = convRef.current.toFixed(2);
      entry.stateAfter = { ...stateRef.current };

      logRef.current = [entry, ...logRef.current];
      setLog([...logRef.current]);
      setChartData(prev => [...prev, { exp: expN.current, conversion: parseFloat(convRef.current.toFixed(2)) }].slice(-120));

      // 8. WRITE LOG
      if (!await animPhase(7)) return;

      setLoopNum(prev => prev + 1);
      setPhaseIdx(-1);
      await sleep(400);
    }
  }, []);

  const toggle = () => {
    if (running) { runRef.current = false; setRunning(false); setPhaseIdx(-1); }
    else { runRef.current = true; setRunning(true); }
  };

  useEffect(() => { if (running) mainLoop(); }, [running]);
  useEffect(() => () => { runRef.current = false; }, []);

  const phase = phaseIdx >= 0 ? PHASES[phaseIdx] : null;
  const keeps = log.filter(e => e.decision === "KEEP").length;
  const reverts = log.filter(e => e.decision === "REVERT").length;
  const blocks = log.filter(e => e.decision === "BLOCK").length;

  return (
    <div style={{ minHeight: "100vh", background: "#0b0b0f", color: "#d4d4d8", fontFamily: "'IBM Plex Mono', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=IBM+Plex+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&display=swap');
        @keyframes fadeIn { from{opacity:0} to{opacity:1} }
        @keyframes slideIn { from{opacity:0;transform:translateY(-3px)} to{opacity:1;transform:translateY(0)} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        @keyframes glow { 
          0%, 100% { box-shadow: 0 0 0px 0px rgba(255,255,255,0); border-color: rgba(244, 244, 245, 0.4); }
          50% { box-shadow: 0 0 15px 1px rgba(255,255,255,0.15); border-color: rgba(244, 244, 245, 1); }
        }
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:#1c1c22;border-radius:3px}
      `}</style>

      {/* HEADER */}
      <div style={{ padding: "14px 22px", borderBottom: "1px solid #18181b", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 22, fontWeight: 700, color: "#f4f4f5", letterSpacing: "-0.03em" }}>autogrowth</span>
            <span style={{ fontSize: 11, color: "#a1a1aa", letterSpacing: "0.08em" }}>v0.2</span>
          </div>
          <div style={{ fontSize: 13, color: "#a1a1aa", marginTop: 2, fontFamily: "'IBM Plex Sans', sans-serif", fontStyle: "italic" }}>
            Autonomous lifecycle experimentation · one intervention, iterated until optimized
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {running && (
            <span style={{ fontSize: 10, color: "#4ade80", fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#4ade80", animation: "pulse 1.5s infinite" }} />
              LOOP {loopNum + 1}
            </span>
          )}
          {log.length > 0 && (
            <span style={{ fontSize: 10, color: "#52525b" }}>
              {keeps} kept · {reverts} reverted{blocks > 0 ? ` · ${blocks} blocked` : ""}
            </span>
          )}
          <button onClick={toggle} style={{
            background: running ? "transparent" : "#f4f4f5", color: running ? "#f87171" : "#0b0b0f",
            border: `1px solid ${running ? "#f8717155" : "#f4f4f5"}`, padding: "7px 20px", borderRadius: 3,
            fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", cursor: "pointer", fontFamily: "inherit",
            animation: running ? "none" : "glow 2s infinite ease-in-out",
            transition: "all 0.3s ease"
          }}>
            {running ? "STOP" : "START"}
          </button>
        </div>
      </div>

      {/* MAIN */}
      <div style={{ display: "flex", height: "calc(100vh - 56px)" }}>

        {/* LEFT: program.md */}
        {showProg && (
          <div style={{ width: progWidth, minWidth: 240, maxWidth: 800, borderRight: "1px solid #18181b", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "12px 18px", borderBottom: "1px solid #18181b", display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#a1a1aa", letterSpacing: "0.08em" }}>PROGRAM.MD</span>
              <span style={{ fontSize: 11, color: "#71717a" }}>HUMAN LAYER</span>
            </div>
            <pre style={{ flex: 1, overflow: "auto", padding: 18, fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {PROGRAM_MD.split("\n").map((line, i) => {
                let c = "#71717a";
                if (line.startsWith("# ")) c = "#f4f4f5";
                else if (line.startsWith("## ")) c = "#d4d4d8";
                else if (line.startsWith("- ") || line.match(/^\d\./)) c = "#a1a1aa";
                else if (line.match(/^H\d/)) c = "#c4b5fd";
                else if (line.includes("→") || line.includes("|")) c = "#a1a1aa";
                return <div key={i} style={{ color: c }}>{line || "\u00A0"}</div>;
              })}
            </pre>
          </div>
        )}

        <button
          onMouseDown={(e) => {
            if (showProg) {
              dragRef.current = true;
              movedDuringDrag.current = false;
              document.body.style.cursor = "col-resize";
              e.preventDefault();
            }
          }}
          onClick={() => {
            if (!movedDuringDrag.current) {
              setShowProg(p => !p);
            }
          }}
          style={{
            width: 24, background: dragRef.current ? "#18181b" : "transparent", border: "none", borderRight: "1px solid #18181b",
            color: "#71717a", cursor: showProg ? "col-resize" : "pointer", fontSize: 11, display: "flex", alignItems: "center",
            justifyContent: "center", writingMode: "vertical-rl", fontFamily: "inherit", transition: "background 0.2s"
          }}>
          {showProg ? "⋮" : "▸ PROGRAM.MD"}
        </button>

        {/* RIGHT */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* CHART & IMPACT PANEL */}
          <div style={{ height: 207, borderBottom: "1px solid #18181b", display: "flex" }}>

            {/* Left: Chart */}
            <div style={{ flex: 1, padding: "14px 18px 6px", borderRight: "1px solid #18181b", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#a1a1aa", letterSpacing: "0.08em" }}>FREE → PLUS CONVERSION FROM USAGE-LIMIT MOMENT</span>
              </div>
              {chartData.length > 1 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 4, right: 10, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#141418" />
                    <XAxis dataKey="exp" tick={{ fontSize: 9, fill: "#3f3f46" }} stroke="#141418" />
                    <YAxis domain={[2, 5.5]} tick={{ fontSize: 9, fill: "#3f3f46" }} stroke="#141418" tickFormatter={v => `${v}%`} />
                    <Tooltip content={({ active, payload }) => active && payload?.length ? (
                      <div style={{ background: "#141418", border: "1px solid #27272a", borderRadius: 3, padding: "5px 10px", fontSize: 11, color: "#a1a1aa" }}>
                        Experiment {payload[0]?.payload?.exp}: {payload[0].value}%
                      </div>
                    ) : null} />
                    <ReferenceLine y={2.8} stroke="#f8717133" strokeDasharray="4 4" label={{ value: "2.80% baseline", position: "insideTopRight", fill: "#f8717155", fontSize: 9 }} />
                    <ReferenceLine y={4.0} stroke="#4ade8028" strokeDasharray="4 4" label={{ value: "4.00% target", position: "insideTopRight", fill: "#4ade8044", fontSize: 9 }} />
                    <Line type="monotone" dataKey="conversion" stroke="#4ade80" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#27272a", fontSize: 13 }}>
                  Press START to begin
                </div>
              )}
            </div>

            {/* Right: Business Impact */}
            <div style={{ width: 340, padding: "14px 22px", background: "#0b0b0f", display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#a1a1aa", letterSpacing: "0.08em", marginBottom: 14 }}>ESTIMATED BUSINESS IMPACT</span>

              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, alignItems: "baseline" }}>
                <div>
                  <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.05em", marginBottom: 2 }}>STARTING CONVERSION</div>
                  <div style={{ fontSize: 15, color: "#a1a1aa", fontWeight: 600 }}>2.80%</div>
                </div>
                <div style={{ color: "#3f3f46" }}>→</div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.05em", marginBottom: 2 }}>CURRENT CONVERSION</div>
                  <div style={{ fontSize: 18, color: conv > 2.85 ? "#4ade80" : "#d4d4d8", fontWeight: 700 }}>{conv.toFixed(2)}%</div>
                </div>
              </div>

              {(() => {
                const totalLift = conv - 2.8;
                // Scale penalty: we assume the effect size drops 20% when rolled out globally
                const scaledLift = Math.max(0, totalLift * 0.8);
                const userPoolWeekly = 5_000_000;
                // Lift / 100 to make it a decimal, * user pool * 52 weeks * $240 ($20/mo annualized)
                const annualizedARR = (scaledLift / 100) * userPoolWeekly * 52 * 240;

                return (
                  <div style={{ background: "#141418", border: "1px solid #27272a", borderRadius: 8, padding: "12px 16px", marginTop: "auto" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: "#a1a1aa", fontWeight: 600, letterSpacing: "0.03em" }}>ANNUALIZED ARR LIFT</span>
                      <span style={{ fontSize: 9, color: "#52525b" }}>(assumes $20/mo Plus)</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontSize: 26, fontWeight: 800, color: annualizedARR > 0 ? "#4ade80" : "#d4d4d8", letterSpacing: "-0.03em" }}>
                        +${(annualizedARR / 1_000_000).toFixed(1)}M
                      </span>
                      <div style={{ display: "flex", flexDirection: "column", borderLeft: "1px solid #27272a", paddingLeft: 12, lineHeight: 1.4 }}>
                        <span style={{ fontSize: 10, color: "#71717a", fontWeight: 500 }}>@ 5M users/wk</span>
                        <span style={{ fontSize: 10, color: "#71717a" }}>w/ 20% scale-down penalty</span>
                      </div>
                    </div>
                  </div>
                );
              })()}

            </div>
          </div>

          {/* CURRENT STATE + CURRENT EXPERIMENT — taller highlight card */}
          <div style={{ minHeight: 236, borderBottom: "1px solid #18181b", padding: "16px 22px", display: "flex", flexDirection: "column", background: curMod ? "#121215" : "transparent", transition: "background 0.3s" }}>

            {/* Current best state */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#a1a1aa", letterSpacing: "0.08em" }}>CURRENT BEST CONFIGURATION</span>
                {curMod && phaseIdx >= 2 && (
                  <span style={{ fontSize: 12, color: "#c4b5fd" }}>
                    testing: <span style={{ fontWeight: 600 }}>{curMod.lever}</span> → {curMod.to}
                  </span>
                )}
              </div>
              {/* Making the state display larger */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px", fontSize: 13 }}>
                {LEVER_NAMES.map(lever => {
                  const isChanged = curMod && phaseIdx >= 2 && lever === curMod.lever;
                  return (
                    <div key={lever}>
                      <span style={{ color: "#71717a", letterSpacing: "0.04em" }}>{lever}: </span>
                      <span style={{
                        fontWeight: isChanged ? 700 : 400,
                        color: isChanged ? "#c4b5fd" : "#d4d4d8",
                      }}>
                        {curMod && phaseIdx >= 2 ? curMod.newState[lever] : currentState[lever]}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Phase progress + result */}
            {phase ? (
              <div style={{ animation: "fadeIn 0.15s ease", borderTop: "1px dashed #27272a", paddingTop: 12 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
                  {PHASES.map((p, i) => (
                    <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <div style={{
                        height: 6, width: i === phaseIdx ? 48 : (p.key === "run" ? 32 : 18),
                        borderRadius: 3, background: i < phaseIdx ? "#4ade8033" : "#1c1c22",
                        overflow: "hidden", transition: "width 0.2s",
                      }}>
                        {i < phaseIdx && <div style={{ height: "100%", width: "100%", background: "#4ade8066", borderRadius: 3 }} />}
                        {i === phaseIdx && <div style={{ height: "100%", width: `${phaseProg}%`, background: "#4ade80", borderRadius: 3, transition: "width 0.04s linear" }} />}
                      </div>
                      <span style={{ fontSize: 10, fontWeight: 700, color: i === phaseIdx ? "#4ade80" : i < phaseIdx ? "#71717a" : "#3f3f46", letterSpacing: "0.04em" }}>
                        {p.label}
                      </span>
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: curMod ? "#19191d" : "transparent", padding: curMod ? "14px 18px" : "14px 0", borderRadius: 8, marginTop: 12, marginBottom: 8, border: curMod ? "1px solid #27272a" : "1px solid transparent", transition: "all 0.3s ease" }}>
                  <div style={{ fontSize: 16, display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ color: curMod ? "#e4e4e7" : "#71717a", fontWeight: 700, letterSpacing: "0.05em", transition: "color 0.3s" }}>
                      EXP-{String(expN.current).padStart(3, "0")}
                    </span>
                    {curMod && phaseIdx >= 1 && (
                      <span style={{ background: "#27272a44", padding: "6px 14px", borderRadius: 6, border: "1px dashed #52525b", display: "inline-flex", gap: 8, alignItems: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" }}>
                        <span style={{ color: "#a1a1aa", fontSize: 13 }}>change</span>
                        <span style={{ color: "#f4f4f5", fontWeight: 600, fontSize: 15 }}>{curMod.lever}</span>
                        <span style={{ color: "#71717a", fontSize: 13 }}>from</span>
                        <span style={{ color: "#fbbf24", opacity: 0.9, fontWeight: 500, fontSize: 14 }}>{curMod.from}</span>
                        <span style={{ color: "#71717a", fontSize: 13 }}>to</span>
                        <span style={{ color: "#c4b5fd", fontWeight: 700, fontSize: 15 }}>{curMod.to}</span>
                      </span>
                    )}
                  </div>
                  {curResult && phaseIdx >= 6 && (
                    <span style={{ fontSize: 24, fontWeight: 800, color: DC[curResult.decision], letterSpacing: "0.08em" }}>
                      {curResult.decision}
                    </span>
                  )}
                </div>

                {curResult && phaseIdx >= 5 && (
                  <div style={{ display: "flex", gap: 32, marginTop: 12, animation: "fadeIn 0.2s ease" }}>
                    {[
                      { l: "TREATMENT", v: `${curResult.tConv}%`, c: "#f4f4f5" },
                      { l: "HOLDOUT", v: `${curResult.hConv}%`, c: "#a1a1aa" },
                      { l: "LIFT", v: `${parseFloat(curResult.incLift) > 0 ? "+" : ""}${curResult.incLift}%`, c: parseFloat(curResult.incLift) > 0.08 ? "#4ade80" : parseFloat(curResult.incLift) < -0.08 ? "#f87171" : "#fbbf24" },
                      { l: "P-VALUE", v: curResult.pVal, c: curResult.sig ? "#4ade80" : "#a1a1aa" },
                      { l: "UNSUB", v: `${curResult.unsubRate}%`, c: parseFloat(curResult.unsubRate) > 0.3 ? "#f87171" : "#71717a" },
                    ].map((m, i) => (
                      <div key={i}>
                        <div style={{ fontSize: 10, color: "#71717a", letterSpacing: "0.08em", marginBottom: 2 }}>{m.l}</div>
                        <div style={{ fontSize: i === 2 ? 22 : 18, fontWeight: 700, color: m.c }}>{m.v}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: "#71717a", fontSize: 14, lineHeight: 1.7, marginTop: 12 }}>
                {log.length === 0
                  ? "Ready. Each loop: read log → analyze → modify one lever → run → evaluate → keep or revert → write log → repeat."
                  : `Idle · ${log.length} experiments · ${keeps} kept · baseline at ${conv.toFixed(2)}%`}
              </div>
            )}
          </div>

          {/* EXPERIMENT LOG — newest on top */}
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "12px 22px", borderBottom: "1px solid #18181b", display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#a1a1aa", letterSpacing: "0.08em" }}>EXPERIMENT LOG</span>
              <span style={{ fontSize: 11, color: "#71717a" }}>SYSTEM READS THIS BEFORE EACH LOOP · NEWEST FIRST</span>
            </div>
            <div style={{ flex: 1, overflow: "auto" }}>
              {log.length === 0 ? (
                <div style={{ padding: 36, textAlign: "center", fontSize: 14, lineHeight: 2.2, color: "#a1a1aa" }}>
                  <div style={{ color: "#d4d4d8", marginBottom: 12, fontSize: 16 }}>The log is the product.</div>
                  <div>Each experiment changes <span style={{ color: "#f4f4f5" }}>one lever</span> from the current best.</div>
                  <div>If conversion improves → <span style={{ color: "#4ade80" }}>KEEP</span> · change persists · new baseline.</div>
                  <div>If it doesn't → <span style={{ color: "#fbbf24" }}>REVERT</span> · undo · try something else.</div>
                  <div>The system reads the full log before each loop.</div>
                  <div>It never tries the same combination twice.</div>
                  <div style={{ marginTop: 20, color: "#71717a", fontStyle: "italic", fontFamily: "'IBM Plex Sans', sans-serif" }}>
                    "You wake up in the morning to a log of experiments
                    and (hopefully) a better model." — Karpathy
                  </div>
                </div>
              ) : log.map((e, i) => (
                <div key={e.num} style={{
                  padding: "16px 22px", borderBottom: "1px solid #141418",
                  animation: i === 0 ? "slideIn 0.25s ease" : "none",
                  fontSize: 13, lineHeight: 1.8,
                }}>
                  <div>
                    <span style={{ color: "#a1a1aa", fontWeight: 600 }}>exp-{String(e.num).padStart(3, "0")}</span>
                    <span style={{ color: "#3f3f46" }}> │ </span>
                    <span style={{ color: "#71717a" }}>change </span>
                    <span style={{ color: "#d4d4d8", fontWeight: 500 }}>{e.changedLever}</span>
                    <span style={{ color: "#71717a" }}> from </span>
                    <span style={{ color: "#fbbf24", opacity: 0.8 }}>{e.from}</span>
                    <span style={{ color: "#71717a" }}> to </span>
                    <span style={{ color: "#c4b5fd", fontWeight: 600 }}>{e.to}</span>
                  </div>
                  <div>
                    <span style={{ color: "#3f3f46" }}>{"        "}│ </span>
                    <span style={{ color: "#a1a1aa" }}>treatment={e.tConv}%</span>
                    <span style={{ color: "#71717a" }}> holdout={e.hConv}%</span>
                    <span style={{ color: "#71717a" }}> lift=</span>
                    <span style={{ color: parseFloat(e.incLift) > 0.08 ? "#4ade80" : parseFloat(e.incLift) < -0.08 ? "#f87171" : "#fbbf24", fontWeight: 500 }}>
                      {parseFloat(e.incLift) > 0 ? "+" : ""}{e.incLift}%
                    </span>
                    <span style={{ color: "#71717a" }}> p={e.pVal}</span>
                    <span style={{ color: "#71717a" }}> unsub={e.unsubRate}%</span>
                  </div>
                  <div>
                    <span style={{ color: "#3f3f46" }}>{"        "}└─ </span>
                    <span style={{ color: DC[e.decision], fontWeight: 800 }}>{e.decision}</span>
                    {e.decision === "KEEP" && <span style={{ color: "#a1a1aa" }}> · baseline {e.baseBefore}% → {e.baseAfter}% · change persists</span>}
                    {e.decision === "REVERT" && <span style={{ color: "#71717a" }}> · baseline unchanged at {e.baseBefore}% · reverted to previous</span>}
                    {e.decision === "BLOCK" && <span style={{ color: "#71717a" }}> · guardrail violation · reverted</span>}
                  </div>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
