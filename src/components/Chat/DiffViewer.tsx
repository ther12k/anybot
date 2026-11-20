import React, { useId, useMemo, useRef, useState } from "react";
import { Maximize2, X } from "lucide-react";

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

const CTX_EDGE = 3;

export const DiffViewer: React.FC<DiffViewerProps> = ({ before, after, path }) => {
  const rows = useMemo(
    () => diffLines(before === "" ? [] : before.split("\n"), after === "" ? [] : after.split("\n")),
    [before, after]
  );
  const collapsedRuns = useMemo(() => {
    const runs = new Map<number, number>();
    let i = 0;
    while (i < rows.length) {
      if (rows[i].type !== "ctx") {
        i++;
        continue;
      }
      let end = i;
      while (end < rows.length && rows[end].type === "ctx") end++;
      if (end - i > CTX_EDGE * 2 + 2) {
        runs.set(i + CTX_EDGE, end - i - CTX_EDGE * 2);
      }
      i = end;
    }
    return runs;
  }, [rows]);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [view, setView] = useState<"diff" | "full">("diff");
  const [showExpandedReview, setShowExpandedReview] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogTitle = useId();

  const adds = rows.filter((r) => r.type === "add").length;
  const dels = rows.filter((r) => r.type === "del").length;

  const renderReview = (inDialog: boolean) => {
    let hideUntil = 0;
    return (
      <>
        <div className="diff-toolbar">
          <div className="segmented" role="group" aria-label="File review view">
            <button type="button" className={view === "diff" ? "active" : ""} aria-pressed={view === "diff"} onClick={() => setView("diff")}>Diff</button>
            <button type="button" className={view === "full" ? "active" : ""} aria-pressed={view === "full"} onClick={() => setView("full")}>Full file</button>
          </div>
          <div className="diff-stats">
            <span className="stat-add" aria-hidden="true">+{adds}</span>
            <span className="stat-remove" aria-hidden="true">−{dels}</span>
            <span className="quiet" aria-hidden="true">lines</span>
            <span className="sr-only">{adds} lines added, {dels} lines removed</span>
          </div>
          {!inDialog && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Expand file review"
              title="Expand file review"
              onClick={() => {
                dialogRef.current?.showModal();
                setShowExpandedReview(true);
              }}
            >
              <Maximize2 className="icon" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="diff-code select-text" role="region" aria-label={view === "full" ? "Proposed file content" : "Proposed file diff"} tabIndex={0}>
          {view === "full" ? (
            <pre className="full-file">{after || "(Empty file)"}</pre>
          ) : adds + dels === 0 ? (
            <p className="full-file">No content changes.</p>
          ) : rows.map((row, idx) => {
            const hidden = collapsedRuns.get(idx);
            const isExpanded = expanded[idx] ?? false;
            if (idx < hideUntil) return null;
            if (hidden && !isExpanded) hideUntil = idx + hidden;
            return (
              <React.Fragment key={idx}>
                {hidden && (
                  <button
                    type="button"
                    className="diff-context"
                    aria-expanded={isExpanded}
                    onClick={() => setExpanded((prev) => ({ ...prev, [idx]: !isExpanded }))}
                  >
                    {isExpanded ? "Hide" : "Show"} {hidden} unchanged lines
                  </button>
                )}
                {(!hidden || isExpanded) && (
                  <div className={`diff-line ${row.type}`}>
                    <span className="line-num" aria-hidden="true">{row.aNum}</span>
                    <span className="line-num" aria-hidden="true">{row.bNum}</span>
                    <span className="sign" aria-hidden="true">{row.type === "add" ? "+" : row.type === "del" ? "-" : " "}</span>
                    {row.type !== "ctx" && <span className="sr-only">{row.type === "add" ? "Added: " : "Removed: "}</span>}
                    <span className="code">{row.text || " "}</span>
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </>
    );
  };

  return (
    <>
      {renderReview(false)}
      <dialog
        ref={dialogRef}
        className="modal wide diff-review-dialog"
        aria-labelledby={dialogTitle}
        onClose={() => setShowExpandedReview(false)}
      >
        <header className="modal-head">
          <div className="min-w-0 break-words">
            <h2 id={dialogTitle}>File review</h2>
            <p>{path}</p>
          </div>
          <button type="button" className="icon-btn shrink-0" aria-label="Close file review" onClick={() => dialogRef.current?.close()}>
            <X className="icon" aria-hidden="true" />
          </button>
        </header>
        {showExpandedReview && <div className="modal-body">{renderReview(true)}</div>}
      </dialog>
    </>
  );
};
