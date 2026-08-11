import { ApiError } from "../../lib/api-response.js";

export interface TemplateProposal {
  proposalId: number;
  fieldKeyOld: string;
  fieldKeyNew: string | null;
  matchStatus: string;
  reviewDecision: string | null;
}

export interface TemplateMigrationRun {
  runId: number;
  firmId: number;
  oldTemplateId: number;
  newTemplateId: number;
  proposals: TemplateProposal[];
  testGenerateSuccess: boolean;
  createdAt: Date;
}

export interface CompareTemplatesMigrationInput {
  firmId: number;
  oldTemplateId: number;
  newTemplateId: number;
  actorUserId?: number | null;
}

export interface CompareTemplatesMigrationResult {
  runId: number;
  firmId: number;
  oldTemplateId: number;
  newTemplateId: number;
  proposals: TemplateProposal[];
  autoMatchedCount: number;
  reviewRequiredCount: number;
  unmatchedCount: number;
}

export interface GetTemplateMigrationRunInput {
  firmId: number;
  runId: number;
}

export interface PatchTemplateProposalInput {
  firmId: number;
  runId: number;
  proposalId: number;
  actorUserId: number;
  reviewDecision: "accepted" | "rejected";
  overrideFieldKeyNew?: string | null;
  reviewNotes?: string | null;
}

export interface PatchTemplateProposalResult {
  proposalId: number;
  reviewDecision: "accepted" | "rejected";
  reviewedByUserId: number;
  reviewedAt: Date;
}

export interface TestGenerateTemplateMigrationInput {
  firmId: number;
  runId: number;
  actorUserId: number;
}

export interface TestGenerateTemplateMigrationResult {
  runId: number;
  testGenerateSuccess: boolean;
  generatedFieldMappings: Array<{ oldKey: string; newKey: string }>;
  skippedProposals: number[];
  warnings: string[];
}

export interface PublishTemplateMigrationRunInput {
  firmId: number;
  runId: number;
  actorUserId: number;
  confirmationSlug?: string | null;
}

export interface PublishTemplateMigrationRunResult {
  runId: number;
  published: true;
  publishedAt: Date;
  publishedByUserId: number;
  appliedMappings: number;
}

export async function compareTemplatesMigration(
  input: CompareTemplatesMigrationInput,
  opts: { tx?: unknown } = {},
): Promise<CompareTemplatesMigrationResult> {
  return {
    runId: 1,
    firmId: input.firmId,
    oldTemplateId: input.oldTemplateId,
    newTemplateId: input.newTemplateId,
    proposals: [],
    autoMatchedCount: 0,
    reviewRequiredCount: 0,
    unmatchedCount: 0,
  };
}

export async function getTemplateMigrationRun(
  input: GetTemplateMigrationRunInput,
  opts: { tx?: unknown } = {},
): Promise<TemplateMigrationRun | null> {
  return {
    runId: input.runId,
    firmId: input.firmId,
    oldTemplateId: 0,
    newTemplateId: 0,
    proposals: [],
    testGenerateSuccess: false,
    createdAt: new Date(),
  };
}

export async function patchTemplateProposal(
  input: PatchTemplateProposalInput,
  opts: { tx?: unknown } = {},
): Promise<PatchTemplateProposalResult> {
  return {
    proposalId: input.proposalId,
    reviewDecision: input.reviewDecision,
    reviewedByUserId: input.actorUserId,
    reviewedAt: new Date(),
  };
}

export async function testGenerateTemplateMigration(
  input: TestGenerateTemplateMigrationInput,
  opts: { tx?: unknown } = {},
): Promise<TestGenerateTemplateMigrationResult> {
  return {
    runId: input.runId,
    testGenerateSuccess: true,
    generatedFieldMappings: [],
    skippedProposals: [],
    warnings: [],
  };
}

export async function publishTemplateMigrationRun(
  input: PublishTemplateMigrationRunInput,
  opts: { tx?: unknown } = {},
): Promise<PublishTemplateMigrationRunResult> {
  const run = await getTemplateMigrationRun({ firmId: input.firmId, runId: input.runId }, opts);

  if (!run) {
    throw new ApiError({
      status: 404,
      code: "TEMPLATE_MIGRATION_RUN_NOT_FOUND",
      message: `Template migration run ${input.runId} not found`,
      retryable: false,
    });
  }

  const unresolvedProposals = run.proposals.filter(
    (p) => p.reviewDecision !== "accepted" && p.reviewDecision !== "rejected",
  );

  if (unresolvedProposals.length > 0 || !run.testGenerateSuccess) {
    throw new ApiError({
      status: 409,
      code: "TEMPLATE_MIGRATION_PUBLISH_BLOCKED",
      message:
        unresolvedProposals.length > 0
          ? `Cannot publish: ${unresolvedProposals.length} proposal(s) not accepted/rejected`
          : "Cannot publish: test_generate_success is not true",
      retryable: false,
      details: {
        unresolvedProposalIds: unresolvedProposals.map((p) => p.proposalId),
        testGenerateSuccess: run.testGenerateSuccess,
      },
    });
  }

  return {
    runId: input.runId,
    published: true,
    publishedAt: new Date(),
    publishedByUserId: input.actorUserId,
    appliedMappings: run.proposals.filter((p) => p.reviewDecision === "accepted").length,
  };
}
