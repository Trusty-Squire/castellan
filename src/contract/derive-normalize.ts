import type { z } from "zod";

export interface StageDiagnostic {
  stage: string;
  rawText: string;
  parsed?: unknown;
  normalized?: unknown;
  parseError?: string;
  validationIssues?: z.ZodIssue[];
}

function splitStringList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const parts = trimmed.includes(",") ? trimmed.split(",") : trimmed.split(/\s+/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

function normalizeStringList(value: unknown): unknown {
  if (typeof value === "string") return splitStringList(value);
  return value;
}

function normalizeNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : value;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeArrayField(parent: Record<string, unknown>, key: string): void {
  const value = parent[key];
  if (value === undefined) return;
  parent[key] = Array.isArray(value) ? value : [value];
}

function normalizeDecompose(value: unknown): unknown {
  const root = objectRecord(value);
  if (!root) return value;
  const copy: Record<string, unknown> = { ...root };
  normalizeArrayField(copy, "nodes");
  if (Array.isArray(copy.nodes)) {
    copy.nodes = copy.nodes.map((node) => {
      const n = objectRecord(node);
      if (!n) return node;
      return {
        ...n,
        deps: normalizeStringList(n.deps ?? []),
        context_globs: normalizeStringList(n.context_globs ?? []),
        blast_radius: normalizeStringList(n.blast_radius),
        budget_usd: normalizeNumber(n.budget_usd),
      };
    });
  }
  return copy;
}

function normalizeInferGates(value: unknown): unknown {
  const root = objectRecord(value);
  if (!root) return value;
  const copy: Record<string, unknown> = { ...root };
  normalizeArrayField(copy, "gates");
  return copy;
}

function normalizeClaims(value: unknown): unknown {
  const root = objectRecord(value);
  if (!root) return value;
  const copy: Record<string, unknown> = { ...root };
  normalizeArrayField(copy, "claims");
  return copy;
}

function normalizeRemedies(value: unknown): unknown {
  const root = objectRecord(value);
  if (!root) return value;
  const copy: Record<string, unknown> = { ...root };
  normalizeArrayField(copy, "remedies");
  return copy;
}

export function normalizeStageOutput(stage: string, value: unknown): unknown {
  if (stage.startsWith("decompose")) return normalizeDecompose(value);
  if (stage.startsWith("infer-gates")) return normalizeInferGates(value);
  if (stage.startsWith("extract-claims")) return normalizeClaims(value);
  if (stage.startsWith("remedy")) return normalizeRemedies(value);
  return value;
}

export function formatStageDiagnostic(diagnostic: StageDiagnostic): string {
  return JSON.stringify({
    stage: diagnostic.stage,
    rawLength: diagnostic.rawText.length,
    parseError: diagnostic.parseError,
    validationIssues: diagnostic.validationIssues?.map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: issue.message,
    })),
    rawText: diagnostic.rawText,
    parsed: diagnostic.parsed,
    normalized: diagnostic.normalized,
  }, null, 2);
}
