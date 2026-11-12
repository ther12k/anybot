import React, { useMemo, useState } from "react";
import { FileCode, Plus, Minus } from "lucide-react";

interface DiffViewerProps {
  before: string;
  after: string;
  path: string;
}

type RowType = "ctx" | "add" | "del";
interface DiffRow {
  type: RowType;
  text: string;
  aNum?: number;
  bNum?: number;
}

/** Line-level LCS diff. Falls back to full del+add when the matrix would be huge. */
function diffLines(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;

  if (n * m > 1_000_000) {
    return [
      ...a.map((text, i) => ({ type: "del" as RowType, text, aNum: i + 1 })),
      ...b.map((text, i) => ({ type: "add" as RowType, text, bNum: i + 1 })),
    ];
  }

  // dp[i][j] = LCS length of a[i..], b[j..]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () =>
    new Uint32Array(m + 1)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "ctx", text: a[i], aNum: i + 1, bNum: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i], aNum: i + 1 });
      i++;
    } else {
      rows.push({ type: "add", text: b[j], bNum: j + 1 });
      j++;
    }
  }
  while (i < n) {
    rows.push({ type: "del", text: a[i], aNum: i + 1 });
    i++;
  }
  while (j < m) {
    rows.push({ type: "add", text: b[j], bNum: j + 1 });
    j++;
  }
  return rows;
}

const CTX_EDGE = 3; // context lines kept visible at each edge of a collapsed run

export const DiffViewer: React.FC<DiffViewerProps> = ({ before, after, path }) => {
  const rows = useMemo(
    () => diffLines(before.split("\n"), after.split("\n")),
    [before, after]
  );
  const isNewFile = before.trim() === "";

  // Collapsed unchanged runs: run.start = index of first hidden row,
  // run.hidden = count of hidden rows; CTX_EDGE rows stay visible on each side.
  const collapsedRuns = useMemo(() => {
    const runs: Array<{ start: number; hidden: number }> = [];
    let i = 0;
    while (i < rows.length) {
      if (rows[i].type !== "ctx") {
        i++;
        continue;
      }
      let end = i;
      while (end < rows.length && rows[end].type === "ctx") end++;
      const len = end - i;
      if (len > CTX_EDGE * 2 + 2) {
        runs.push({ start: i + CTX_EDGE, hidden: len - CTX_EDGE * 2 });
      }
      i = end;
    }
    return runs;
  }, [rows]);

  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const runAt = (idx: number) =>
    collapsedRuns.find(
      (r) => !expanded[r.start] && idx >= r.start && idx < r.start + r.hidden
    );
  const markerAt = (idx: number) =>
    !isNewFile &&
    collapsedRuns.find((r) => !expanded[r.start] && idx === r.start);

  const rowClasses: Record<RowType, string> = {
    add: "bg-[#10ab6114] text-[#0b6b3d]",
    del: "bg-[#e72e3b0f] text-[#9c1f29]",
    ctx: "text-secondary",
  };

  const adds = rows.filter((r) => r.type === "add").length;
  const dels = rows.filter((r) => r.type === "del").length;

  return (
    <div className="border-t border-stroke bg-chrome overflow-hidden">
      <div className="px-3 py-1.5 bg-hover flex items-center justify-between text-xxs font-mono text-secondary">
        <div className="flex items-center gap-1.5 min-w-0">
          <FileCode className="w-3 h-3 text-accent shrink-0" aria-hidden="true" />
          <span className="text-primary font-medium truncate">{path}</span>
        </div>
        <span className="text-quaternary shrink-0">
          {isNewFile ? "Created" : `${adds} added · ${dels} removed`}
        </span>
      </div>

      <div className="py-1.5 font-mono text-xxs overflow-x-auto max-h-56 overflow-y-auto select-text">
        {rows.map((row, idx) => {
          const run = runAt(idx);
          if (run) return null; // inside a collapsed unchanged run

          const marker = markerAt(idx);
          return (
            <React.Fragment key={idx}>
              {marker && (
                <button
                  onClick={() =>
                    setExpanded((prev) => ({ ...prev, [marker.start]: true }))
                  }
                  className="w-full text-left px-3 py-0.5 text-quaternary hover:text-secondary bg-hover"
                >
                  ⋯ Show {marker.hidden} unchanged lines
                </button>
              )}
              <div className={`flex items-center px-3 ${rowClasses[row.type]}`}>
                {row.type === "add" ? (
                  <Plus className="w-2.5 h-2.5 mr-1.5 shrink-0" aria-hidden="true" />
                ) : row.type === "del" ? (
                  <Minus className="w-2.5 h-2.5 mr-1.5 shrink-0" aria-hidden="true" />
                ) : (
                  <span className="w-2.5 mr-1.5 shrink-0" aria-hidden="true" />
                )}
                <span className="w-7 text-quaternary select-none shrink-0">
                  {row.aNum ?? row.bNum ?? ""}
                </span>
                <span className="whitespace-pre">{row.text}</span>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
