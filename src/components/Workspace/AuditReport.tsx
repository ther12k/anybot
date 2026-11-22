import { AlertTriangle, Info, ShieldCheck } from "lucide-react";
import type { AuditActivity, AuditVerification } from "../../services/tauri/bridge";

export const auditRequestError = "AnyBot couldn’t get a verification result. Try again.";

export function describeAuditVerification(report: AuditVerification): {
  title: string;
  detail: string;
  tone: "neutral" | "consistent" | "warning";
} {
  switch (report.status) {
    case "missing":
      return { title: "No audit log found.", detail: "There is no log file to verify.", tone: "neutral" };
    case "empty":
      return { title: "The audit log is empty.", detail: "The file exists, but it has no entries to check.", tone: "neutral" };
    case "legacy_only":
      return { title: "No chained entries to verify.", detail: "Older entries without hashes can’t be verified.", tone: "neutral" };
    case "consistent":
      return {
        title: "Local hash chain is consistent.",
        detail: `${report.hashed_rows} chained ${report.hashed_rows === 1 ? "entry" : "entries"} checked with SHA-256. Older entries without hashes aren’t verified.`,
        tone: "consistent",
      };
    case "broken":
      return {
        title: "Audit chain check failed.",
        detail: report.first_break === null ? "The log did not pass verification."
          : `The first break is at record ${report.first_break}.`,
        tone: "warning",
      };
    case "unreadable":
      return {
        title: "Audit verification unavailable.",
        detail: "AnyBot couldn’t read the log for verification. Check access to local audit storage and try again.",
        tone: "warning",
      };
  }
}

const actionLabels: Record<AuditActivity["tool"], string> = {
  execute_shell: "Run command",
  read_file: "Read file",
  write_file: "Write file",
  list_directory: "List directory",
  delegate_task: "Delegate task",
};

const outcomes: Record<AuditActivity["outcome"], { label: string; color: string }> = {
  completed: { label: "Completed", color: "green" },
  failed: { label: "Failed", color: "red" },
  blocked: { label: "Blocked", color: "amber" },
  rejected: { label: "Declined", color: "neutral" },
  cancelled: { label: "Cancelled", color: "neutral" },
  killed: { label: "Killed", color: "amber" },
  timeout: { label: "Timed out", color: "red" },
};

export function AuditReport({ report }: { report: AuditVerification }) {
  const { title, detail, tone } = describeAuditVerification(report);
  const Icon = tone === "consistent" ? ShieldCheck : tone === "warning" ? AlertTriangle : Info;
  const hasCounts = report.status === "consistent" || report.status === "broken" || report.status === "legacy_only";

  return <>
    <div className={`audit-result ${tone === "warning" ? "invalid" : tone}`} role="status">
      <Icon className="icon lg" aria-hidden="true" /><div><h2>{title}</h2><p>{detail}</p></div>
    </div>
    {hasCounts && <div className="table-wrap">
      <table className="audit-table" aria-label="Verification summary">
        <thead><tr><th scope="col">Records examined</th><th scope="col">Hashes checked</th><th scope="col">Legacy</th><th scope="col">First break</th></tr></thead>
        <tbody><tr>
          <td><strong>{report.total_rows}</strong></td><td>{report.hashed_rows}</td>
          <td>{report.legacy_rows}</td><td>{report.first_break ?? "None found"}</td>
        </tr></tbody>
      </table>
    </div>}
    {report.status === "consistent" && <section className="workspace-audit-activity" aria-labelledby="audit-activity-title">
      <h2 id="audit-activity-title">Recent activity</h2>
      <p className="small muted">Up to 25 checked AnyBot tool and delegation records, newest first. Commands, paths, and content are not shown.</p>
      {report.recent.length ? <div className="table-wrap" role="region" aria-labelledby="audit-activity-title" tabIndex={0}>
        <table className="audit-table">
          <thead><tr><th scope="col">Record</th><th scope="col">Action</th><th scope="col">Outcome</th><th scope="col">Time (UTC)</th></tr></thead>
          <tbody>{report.recent.map(({ record, tool, outcome, timestamp }) => (
            <tr key={record}>
              <td>{record}</td><td>{actionLabels[tool]}</td>
              <td><span className={`tag ${outcomes[outcome].color}`}>{outcomes[outcome].label}</span></td>
              <td>{timestamp ? <time dateTime={timestamp}>{timestamp.slice(0, 10)} {timestamp.slice(11, 19)}</time> : "—"}</td>
            </tr>
          ))}</tbody>
        </table>
      </div> : <p className="small muted">No checked records have an activity summary.</p>}
    </section>}
  </>;
}
