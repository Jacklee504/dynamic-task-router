import { describe, expect, it } from "vitest";
import { classifyTask } from "../src/routing/classifier.js";

describe("deterministic task classification", () => {
  it("does not infer difficult complexity from 'why' alone", () => {
    expect(classifyTask("Explain why memoization matters here", "researcher").complexity).toBe("normal");
  });
  it("infers difficult complexity when a standalone 'why' has failing evidence", () => {
    expect(classifyTask("Explain why the build fails on startup", "debugger").complexity).toBe("difficult");
  });
  it("does not infer extreme complexity from 'architecture' alone", () => {
    expect(classifyTask("Review the module architecture for correctness", "architect").complexity).toBe("normal");
  });
  it("infers extreme complexity when architecture work is cross-cutting", () => {
    expect(classifyTask("Plan the cross-cutting redesign of the request layer", "architect").complexity).toBe("extreme");
  });
  it("does not infer high risk from isolated trading or financial wording", () => {
    expect(classifyTask("Review the trading order code for race conditions", "reviewer").risk).toBe("medium");
    expect(classifyTask("Explain the payment retry flow", "researcher").risk).toBe("low");
  });
  it("infers high risk for live order-submission changes", () => {
    expect(classifyTask("Implement changes to the live order submission path", "implementer").risk).toBe("high");
  });
  it("infers high risk for destructive operations", () => {
    expect(classifyTask("Plan removal of the legacy migration utility", "architect").risk).toBe("high");
  });
  it("keeps explicit user profile overrides authoritative", () => {
    expect(classifyTask("Explain why memoization matters here", "researcher", { complexity: "extreme", risk: "high" }).complexity).toBe("extreme");
    expect(classifyTask("Explain why memoization matters here", "researcher", { complexity: "extreme", risk: "high" }).risk).toBe("high");
  });
});