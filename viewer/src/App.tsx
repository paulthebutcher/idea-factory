import { useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { get } from "./api.js";
import { Runs } from "./pages/Runs.js";
import { RunDetail } from "./pages/RunDetail.js";
import { Pipeline } from "./pages/Pipeline.js";
import { IdeaDetail } from "./pages/IdeaDetail.js";
import { StageResult } from "./pages/StageResult.js";
import { Critic, CriticLatest } from "./pages/Critic.js";
import { ComparisonPage } from "./pages/Comparison.js";
import { Annotations } from "./pages/Annotations.js";

export function App() {
  return (
    <div className="app">
      <nav className="top">
        <span className="brand">Idea Factory</span>
        <NavLink to="/runs" end>
          Runs
        </NavLink>
        <NavLink to="/ideas">Pipeline</NavLink>
        <NavLink to="/critic">Critic</NavLink>
        <NavLink to="/annotations">Annotations</NavLink>
        <IdSearch />
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/runs" replace />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/runs/:id/critic" element={<Critic />} />
          <Route path="/ideas" element={<Pipeline />} />
          <Route path="/ideas/:id" element={<IdeaDetail />} />
          <Route path="/traces/:id" element={<StageResult />} />
          <Route path="/comparisons/:id" element={<ComparisonPage />} />
          <Route path="/critic" element={<CriticLatest />} />
          <Route path="/annotations" element={<Annotations />} />
          <Route path="*" element={<p>Not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}

/** Paste any id (run, idea, sr_…, comparison number) and jump to it. */
function IdSearch() {
  const [q, setQ] = useState("");
  const [miss, setMiss] = useState(false);
  const nav = useNavigate();
  const go = async () => {
    const id = q.trim();
    if (!id) return;
    const hit = await get<{ type: string; id: string } | null>(`/search?q=${encodeURIComponent(id)}`);
    if (!hit) return setMiss(true);
    setMiss(false);
    setQ("");
    nav(hit.type === "stage_result" ? `/traces/${hit.id}` : hit.type === "run" ? `/runs/${hit.id}` : hit.type === "idea" ? `/ideas/${hit.id}` : `/comparisons/${hit.id}`);
  };
  return (
    <form
      className="idsearch"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <input value={q} onChange={(e) => (setQ(e.target.value), setMiss(false))} placeholder="jump to id: sr_…, A07, live_run_4" className={miss ? "miss" : ""} />
    </form>
  );
}
