import Database from "better-sqlite3"

export function sqliteLoadsForTests(): boolean {
  try {
    new Database(":memory:").close()
    return true
  } catch (err) {
    if (process.env.COWORK_REQUIRE_SQLITE_TESTS === "1") {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `better-sqlite3 could not load in the required SQLite test job: ${message}`
      )
    }
    return false
  }
}
