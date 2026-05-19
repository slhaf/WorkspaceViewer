import { describe, expect, it } from "vitest";
import { parseLanguages, revokeAgent } from "./repository.js";

describe("repository helpers", () => {
  it("parses workspace languages defensively", () => {
    expect(parseLanguages('["typescript","python"]')).toEqual(["typescript", "python"]);
    expect(parseLanguages('"typescript"')).toBeUndefined();
    expect(parseLanguages("not-json")).toBeUndefined();
    expect(parseLanguages(null)).toBeUndefined();
  });

  it("revokes an agent after deleting its workspace summaries", async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(agentId: string) {
            statements.push(`${sql.trim()} :: ${agentId}`);
            return {};
          }
        };
      },
      async batch() {
        return [];
      }
    } as unknown as D1Database;

    await revokeAgent(db, "agent_test");

    expect(statements).toEqual([
      "DELETE FROM workspaces WHERE agent_id = ? :: agent_test",
      "DELETE FROM agents WHERE agent_id = ? :: agent_test"
    ]);
  });
});
