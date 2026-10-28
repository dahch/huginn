export interface Iteration {
  index: number;
  title: string;
  prompt: string;
  modules?: string[];
  /** One-line observable outcome of the increment, when the plan declares it. */
  goal?: string;
  /** Verifiable acceptance criteria for the increment, when declared. */
  acceptanceCriteria?: string[];
  /** Non-interactive commands that prove the increment works, when declared. */
  verification?: string[];
  startLine: number;
}
