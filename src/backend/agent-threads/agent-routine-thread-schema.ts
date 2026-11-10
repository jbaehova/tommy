/** New schema tail and incremental migration. No shipped SQL constant uses these additions. */
export const AGENT_ROUTINE_THREAD_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS agent_threads_routine ON projection_agent_threads(agent_id, routine_id)
    WHERE routine_id IS NOT NULL;
`;

export const AGENT_ROUTINE_THREAD_MIGRATION_SQL = `
  ALTER TABLE projection_agent_threads ADD COLUMN routine_id TEXT;
  ${AGENT_ROUTINE_THREAD_INDEX_SQL}
`;

/** Existing routines keep their current chat. No row or provider session is rebuilt. */
export const ROUTINE_RUN_PLACE_COLUMN_SQL = "run_in TEXT NOT NULL DEFAULT 'chat' CHECK(run_in IN ('chat', 'thread'))";
export const ROUTINE_RUN_PLACE_MIGRATION_SQL = `
  ALTER TABLE projection_agent_routines ADD COLUMN ${ROUTINE_RUN_PLACE_COLUMN_SQL};
`;
