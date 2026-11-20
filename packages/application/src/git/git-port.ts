// Repository access for missions (docs/02_ARCHITECTURE_ADR.md §4, PRD: Issue → draft PR).
// The control plane, not the agent, talks to the Git host: it checks the repository out, lets the
// agent edit the working tree in a sandbox, then commits and pushes the result itself. The agent
// never receives Git host credentials, and the repository metadata (.git) stays outside the
// sandbox, so the agent cannot plant hooks or config that the control plane's git would run.

export type RepositoryRef = {
  readonly owner: string;
  readonly name: string;
};

export type Checkout = {
  readonly repository: RepositoryRef;
  /** Working tree: the only directory to mount into a sandbox. Contains no .git. */
  readonly workTree: string;
  /** Repository metadata, kept outside the working tree. Never mount it into a sandbox. */
  readonly gitDir: string;
  readonly baseBranch: string;
  readonly baseSha: string;
};

export type PublishRequest = {
  /** Must start with the adapter's branch prefix (e.g. `aep/`), so base branches are never touched. */
  readonly branch: string;
  readonly message: string;
};

export type PublishResult =
  | { readonly kind: "pushed"; readonly sha: string }
  /** The working tree equals the base; nothing was committed or pushed. */
  | { readonly kind: "no_changes" };

export type DraftPullRequest = {
  readonly number: number;
  readonly url: string;
  /** False when an open pull request for the branch already existed (a retried job). */
  readonly created: boolean;
};

/** An issue's text. Written by whoever can open issues: untrusted input for the agent. */
export type Issue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
};

/** One CI result for a commit: a check run or a commit status. */
export type CiCheck = {
  readonly name: string;
  /** neutral: finished without passing or failing (e.g. skipped). */
  readonly state: "pending" | "success" | "failure" | "neutral";
  readonly url: string | null;
};

export type ChangedFile = {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
};

export type PullRequestFiles = {
  readonly files: readonly ChangedFile[];
  /** True when the pull request changes more files than were read. */
  readonly truncated: boolean;
};

export interface GitPort {
  /** Reads an open or closed issue; pull requests are rejected. */
  readIssue(repository: RepositoryRef, issueNumber: number): Promise<Issue>;
  /** Clones `baseBranch` into `directory` (which must not exist yet or be empty). */
  checkout(repository: RepositoryRef, baseBranch: string, directory: string): Promise<Checkout>;
  /**
   * Commits every change in the working tree and pushes it to `branch`, replacing what an
   * earlier attempt pushed there. Safe to repeat.
   */
  publish(checkout: Checkout, request: PublishRequest): Promise<PublishResult>;
  /** Opens a draft pull request from `branch` into the checkout's base, or returns the open one. */
  openDraftPullRequest(
    checkout: Checkout,
    request: { readonly branch: string; readonly title: string; readonly body: string },
  ): Promise<DraftPullRequest>;
  /** The CI results reported for commit `sha` (40 hex characters), check runs and statuses. */
  readCiChecks(repository: RepositoryRef, sha: string): Promise<readonly CiCheck[]>;
  /** The files pull request `number` changes, with line counts. */
  listPullRequestFiles(repository: RepositoryRef, number: number): Promise<PullRequestFiles>;
}
