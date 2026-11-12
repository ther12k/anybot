import { BotWorkflow } from "../types";

/**
 * Seeded one-click workflows (Grok Bot-style multi-step task chains).
 * Each step is a full agent turn — tools, approvals, and diffs behave
 * exactly like a hand-typed conversation. `toolsRequired` gates the card
 * on chat-only models instead of promising what can't run.
 */
export const DEFAULT_WORKFLOWS: BotWorkflow[] = [
  {
    id: "wf-repo-health",
    name: "Repo health check",
    description: "Inspect the working tree, run checks, and summarize what needs attention.",
    icon: "🩺",
    toolsRequired: true,
    category: "code",
    steps: [
      "Show the current git status and the last 5 commits of this repository.",
      "Run the project's typecheck or test command and report the outcome.",
      "Summarize everything you found: working-tree state, check results, and the top 3 things I should fix first.",
    ],
  },
  {
    id: "wf-code-review",
    name: "Code review sweep",
    description: "Review recent changes file by file and produce an actionable report.",
    icon: "🔍",
    toolsRequired: true,
    category: "code",
    steps: [
      "List the files changed in the last commit and read each one.",
      "Review every changed file for bugs, security issues, and readability problems. Cite file:line evidence.",
      "Write the final review as a markdown report: verdict, blocking issues, nice-to-haves.",
    ],
  },
  {
    id: "wf-release-notes",
    name: "Release notes writer",
    description: "Turn recent work into a polished, user-facing changelog draft.",
    icon: "📝",
    category: "writing",
    steps: [
      "I need release notes. Ask me (or infer from context) what shipped in this release: features, fixes, known issues.",
      "Draft the changelog: group by Added / Changed / Fixed, one line each, user-facing language, no jargon.",
      "Polish the draft into final markdown with a short intro sentence and a version header I can paste directly.",
    ],
  },
  {
    id: "wf-morning-brief",
    name: "Morning dev briefing",
    description: "Plan the day: priorities, focus block, and a status update draft.",
    icon: "☀️",
    category: "productivity",
    steps: [
      "Act as my chief of staff. Interview me in one short message about what's on my plate today.",
      "Turn my answers into a prioritized plan: top 3 goals, one focus block, and what to defer.",
      "Draft a 3-bullet status update I can send to stakeholders, based on the plan.",
    ],
  },
  {
    id: "wf-readme-refresh",
    name: "README refresh",
    description: "Read the current README, propose improvements, and prepare the reviewed edit.",
    icon: "📖",
    toolsRequired: true,
    category: "writing",
    steps: [
      "Read the README.md in this workspace and summarize its current structure in 5 bullets.",
      "Propose a concrete rewrite plan: what to cut, what to add, what to fix. Wait for my confirmation on the direction.",
      "Write the improved README as a file change proposal so I can review the diff before anything is applied.",
    ],
  },
  {
    id: "wf-security-audit",
    name: "Quick security audit",
    description: "Scan for leaked secrets and unsafe patterns, then rank the risks.",
    icon: "🛡️",
    toolsRequired: true,
    category: "code",
    steps: [
      "Scan this workspace for hardcoded secrets, API keys, and tokens in source files. Report exact paths.",
      "Check for unsafe patterns: shell injection, unvalidated input, and outdated dependencies in manifests.",
      "Rank every finding by severity (Critical/High/Medium/Low) with a one-line remediation for each.",
    ],
  },
];
