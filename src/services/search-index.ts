import { query } from "../db/client";

// Trigram index carrying POST /orgs/google/messages/search (BRAND-PROOF-LOGOS-1121).
//
// Built AFTER listen, never in the migration: a GIN build over ~700k silver rows
// would hold the boot window (deploy health check, rollback), and CONCURRENTLY
// cannot run inside the migration's transaction. Until it exists the search
// still answers (sequential scan, ~3 s on the 692k mirror); with it, an index
// lookup. A failed concurrent build leaves an INVALID index that IF NOT EXISTS
// would skip forever, so it is dropped and rebuilt.
//
// The indexed expression MUST stay byte-equal to the one in phrase-search.ts.
export const PHRASE_INDEX = "idx_gmail_messages_silver_text_trgm";

export const ensurePhraseSearchIndex = async (): Promise<void> => {
  await query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  const existing = await query(
    `SELECT i.indisvalid AS valid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1`,
    [PHRASE_INDEX]
  );
  if (existing.rows.length > 0 && existing.rows[0].valid === true) return;
  if (existing.rows.length > 0) {
    console.warn(`[google-service] ${PHRASE_INDEX} is invalid (an earlier build died), rebuilding`);
    await query(`DROP INDEX CONCURRENTLY IF EXISTS ${PHRASE_INDEX}`);
  }
  const started = Date.now();
  await query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${PHRASE_INDEX}
       ON gmail_messages_silver
       USING GIN ((COALESCE(subject, '') || E'\\n' || COALESCE(snippet, '')) gin_trgm_ops)`
  );
  console.log(`[google-service] ${PHRASE_INDEX} built in ${Date.now() - started} ms`);
};
