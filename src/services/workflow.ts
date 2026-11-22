import { DEFAULT_WORKFLOWS } from "../data/defaultWorkflows";
import type { AIModel, BotWorkflow, Thread, WorkflowGate } from "../types";
import type { RunOutcome } from "./agent/agentLoop";
import { isCliModel } from "./ai/models";

type PauseState = "awaiting_input" | "awaiting_approval";
export type WorkflowState = "running" | PauseState | RunOutcome;

type WorkflowResult =
  | { step: number; state: RunOutcome }
  | { step: number; state: PauseState; nextStep: number; gate: WorkflowGate };

export function isWorkflowGate(step: unknown): step is WorkflowGate {
  return !!step && typeof step === "object" && "kind" in step &&
    (step.kind === "human_input" || step.kind === "approval");
}

/** Refresh built-ins so saved string-only definitions get their checkpoints. */
export function reconcileWorkflows(saved: BotWorkflow[]): BotWorkflow[] {
  return saved.map((workflow) => workflow.isCustom
    ? workflow
    : DEFAULT_WORKFLOWS.find(({ id }) => id === workflow.id) ?? workflow);
}

export function getWorkflowPause(workflows: BotWorkflow[], pending: Thread["pendingWorkflow"]) {
  if (!pending || !Number.isSafeInteger(pending.nextStep) || pending.nextStep < 1) return null;
  const workflow = workflows.find(({ id }) => id === pending.workflowId);
  const gate = workflow?.steps[pending.nextStep - 1];
  if (!workflow || !isWorkflowGate(gate) || (pending.kind !== undefined && pending.kind !== gate.kind)) return null;
  return { workflow, gate, nextStep: pending.nextStep };
}

export function modelCanRunWorkflow(workflow: BotWorkflow, model: AIModel): boolean {
  if (!workflow.steps.length || (workflow.toolsRequired && !model.supportsTools)) return false;
  // CLI-managed actions have no AnyBot tool outcomes or native review cards.
  return !isCliModel(model) || (!workflow.toolsRequired && !workflow.steps.some(
    (step) => typeof step !== "string" && step.kind === "approval"
  ));
}

export async function runWorkflowSteps(workflow: BotWorkflow, startIndex: number, {
  runPrompt, onStep, shouldStop,
}: {
  runPrompt: (prompt: string) => Promise<RunOutcome | null>;
  onStep: (step: number) => void;
  shouldStop: () => boolean;
}): Promise<WorkflowResult> {
  const { steps } = workflow;
  if (!steps.length || !Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex > steps.length) {
    return { state: "failed", step: 0 };
  }
  for (let index = startIndex; index < steps.length; index++) {
    if (shouldStop()) return { state: "cancelled", step: index };
    const step = steps[index];
    if (typeof step !== "string") {
      return { step: index + 1, nextStep: index + 1, gate: step,
        state: step.kind === "human_input" ? "awaiting_input" : "awaiting_approval" };
    }
    onStep(index + 1);
    const outcome = await runPrompt(step);
    if (shouldStop()) return { state: "cancelled", step: index + 1 };
    if (outcome !== "completed") return { state: outcome ?? "failed", step: index + 1 };
  }
  return { state: shouldStop() ? "cancelled" : "completed", step: steps.length };
}
