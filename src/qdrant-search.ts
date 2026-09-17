import type { Database } from "./db.js";
import type { LLM } from "./llm.js";
import { METADATA_EXTRACTION_VERSION } from "./metadata.js";
import { compileMetadataFilter, type MetadataFilter } from "./metadata-filter.js";
import { getContextForFile, type HybridQueryExplain, type HybridQueryResult } from "./store.js";
import {
  searchQdrant,
  type QdrantDocumentResult,
  type QdrantScope,
  type QdrantSearch,
} from "./qdrant.js";

export type QdrantAdapterOptions = {
  collections: string[];
  searches: QdrantSearch[];
  llm: LLM;
  limit: number;
  candidateLimit: number;
  minScore: number;
  rerank: boolean;
  intent?: string;
  scope?: QdrantScope;
  filter?: MetadataFilter;
};

function filterCandidatesByMetadata(
  db: Database,
  candidates: QdrantDocumentResult[],
  filter: MetadataFilter | undefined,
): QdrantDocumentResult[] {
  if (!filter || candidates.length === 0) return candidates;
  const compiled = compileMetadataFilter(filter, "d");
  const placeholders = candidates.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT d.id
      FROM documents d
      JOIN document_metadata dm ON dm.document_id = d.id
     WHERE d.id IN (${placeholders})
       AND d.active = 1
       AND dm.extraction_version = ?
       AND dm.extraction_error IS NULL
       AND ${compiled.sql}
  `).all(
    ...candidates.map(candidate => candidate.internalDocumentId),
    METADATA_EXTRACTION_VERSION,
    ...compiled.params,
  ) as Array<{ id: number }>;
  const allowed = new Set(rows.map(row => row.id));
  return candidates.filter(candidate => allowed.has(candidate.internalDocumentId));
}

/**
 * Qdrant retrieves only candidates. Metadata filtering and reranking happen
 * against QMD's local, authoritative index state before a result is returned.
 * This keeps a stale Qdrant payload from bypassing QMD metadata semantics.
 */
export async function searchQdrantWithMetadata(
  db: Database,
  options: QdrantAdapterOptions,
): Promise<HybridQueryResult[]> {
  const candidates = filterCandidatesByMetadata(
    db,
    await searchQdrant(db, options.searches, {
      collections: options.collections,
      limit: Math.min(100, Math.max(options.limit, options.candidateLimit)),
      candidateLimit: options.candidateLimit,
      llm: options.llm,
      scope: options.scope,
    }),
    options.filter,
  );
  if (candidates.length === 0) return [];

  const primaryQuery = options.searches.find(search => search.type === "lex")?.query
    ?? options.searches.find(search => search.type === "vec")?.query
    ?? options.searches[0]?.query
    ?? "";
  const rerankScores = new Map<string, number>();
  if (options.rerank) {
    const reranked = await options.llm.rerank(
      options.intent ? `${options.intent}\n\n${primaryQuery}` : primaryQuery,
      candidates.map(candidate => ({ file: candidate.file, text: candidate.bestChunk })),
    );
    for (const result of reranked.results) rerankScores.set(result.file, result.score);
  }

  return candidates
    .map((candidate, index) => {
      const rerankScore = rerankScores.get(candidate.file);
      const score = rerankScore === undefined
        ? candidate.score
        : (0.4 * candidate.score) + (0.6 * rerankScore);
      const explain: HybridQueryExplain = {
        ftsScores: [], vectorScores: [],
        rrf: {
          rank: index + 1, positionScore: candidate.score, weight: rerankScore === undefined ? 1 : 0.4,
          baseScore: candidate.score, topRankBonus: 0, totalScore: candidate.score, contributions: [],
        },
        rerankScore: rerankScore ?? 0,
        blendedScore: score,
      };
      return {
        ...candidate,
        context: getContextForFile(db, candidate.file),
        // Qdrant payloads intentionally do not carry arbitrary metadata.
        // Filtering above consults the local metadata tables; callers that
        // need metadata can resolve it from the same authoritative index.
        metadata: {},
        score,
        explain,
      };
    })
    .filter(candidate => candidate.score >= options.minScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, options.limit);
}
