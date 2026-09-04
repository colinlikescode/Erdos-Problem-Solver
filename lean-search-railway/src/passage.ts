// Reconstruct the kind-aware STRUCTURED PASSAGE the LeanSearch-v2 paper embeds  - 
// not the raw informal_description (that's the "one thing that bites you"). Each
// corpus item becomes: kind + name + type signature + informal description, plus
// the VALUE field for non-theorems (definitions/classes/instances/abbrevs) where
// the value carries real semantic meaning (theorem values are just proof terms).
//
// Confirmed fields (FrenzyMath/lsv2-mathlib-v4.28.0-rc1-jsonl, 310,579 rows):
//   name[], module_name[], type, kind, index, signature, value,
//   informal_name, informal_description

export interface CorpusRecord {
  name?: string | string[];
  module_name?: string | string[];
  type?: string;
  kind?: string;
  index?: number;
  signature?: string;
  value?: string;
  informal_name?: string;
  informal_description?: string;
}

const asStr = (v: unknown): string => (Array.isArray(v) ? v.join(".") : v == null ? "" : String(v));

// Non-theorem kinds whose `value` is semantically meaningful and worth embedding.
const VALUE_KINDS = new Set([
  "definition", "def", "abbrev", "abbreviation", "instance", "class", "structure", "inductive",
]);

export function recordKind(rec: CorpusRecord): string {
  return asStr(rec.kind || "declaration").toLowerCase();
}

/** The document passage that gets embedded (RETRIEVAL_DOCUMENT side). */
export function buildPassage(rec: CorpusRecord): string {
  const kind = recordKind(rec);
  const name = asStr(rec.informal_name || rec.name);
  const sig = asStr(rec.signature || rec.type);
  const desc = asStr(rec.informal_description);
  const value = asStr(rec.value);
  const lines: string[] = [];
  if (kind) lines.push(`Kind: ${kind}`);
  if (name) lines.push(`Name: ${name}`);
  if (sig) lines.push(`Signature: ${sig}`);
  if (value && VALUE_KINDS.has(kind)) lines.push(`Value: ${value}`);
  if (desc) lines.push(`Description: ${desc}`);
  return lines.join("\n");
}

/** Metadata stored alongside the vector (what the caller + reranker see). */
export function buildMetadata(rec: CorpusRecord): Record<string, string> {
  return {
    name: asStr(rec.name),
    kind: recordKind(rec),
    module: asStr(rec.module_name),
    signature: asStr(rec.signature || rec.type),
    informal_name: asStr(rec.informal_name),
    informal_description: asStr(rec.informal_description),
  };
}
