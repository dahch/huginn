import { describe, it, expect } from "bun:test";
import { permissionHandlerFor } from "./permissionPolicy";
import type { DecisionChoice } from "./types";

const request = { id: "perm_1", title: "run tests" };

describe("permissionHandlerFor", () => {
  it("auto-approves in auto mode without asking", async () => {
    let asked = false;
    const handler = permissionHandlerFor("auto", async () => {
      asked = true;
      return "continue";
    });
    expect(await handler(request)).toBe("allow-always");
    expect(asked).toBe(false);
  });

  it("denies in deny mode without asking", async () => {
    let asked = false;
    const handler = permissionHandlerFor("deny", async () => {
      asked = true;
      return "continue";
    });
    expect(await handler(request)).toBe("deny");
    expect(asked).toBe(false);
  });

  it("maps the human choice in ask mode", async () => {
    const choices: Array<[DecisionChoice, string]> = [
      ["continue", "allow-always"],
      ["retry", "allow-once"],
      ["deny", "deny"],
      ["abort", "deny"],
    ];
    for (const [choice, expected] of choices) {
      const handler = permissionHandlerFor("ask", async () => choice);
      expect(await handler(request)).toBe(expected as never);
    }
  });

  it("forwards the permission id and title to the decision broker", async () => {
    let seen: { permissionId?: string; message?: string } = {};
    const handler = permissionHandlerFor("ask", async (req) => {
      seen = { permissionId: req.permissionId, message: req.message };
      return "retry";
    });
    await handler(request);
    expect(seen.permissionId).toBe("perm_1");
    expect(seen.message).toContain("run tests");
  });
});
