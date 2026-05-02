import { describe, it, expect } from "bun:test";
import {
  GmplError,
  PatternNotFoundError,
  RoleNotFoundError,
  DomainNotRegisteredError,
  PatternValidationError,
  CompositionError,
  OutcomeResolutionError,
  ConvergenceError,
} from "../../../gmpl/errors.js";
import { PatternRegistry } from "../../../gmpl/PatternRegistry.js";
import { RoleRegistry } from "../../../gmpl/RoleRegistry.js";
import { z } from "zod";

describe("GMPL Error Hierarchy", () => {
  describe("GmplError (base)", () => {
    it("should set code, message, and context", () => {
      const err = new GmplError("TEST_CODE", "Test message", { key: "value" });
      expect(err.code).toBe("TEST_CODE");
      expect(err.message).toBe("Test message");
      expect(err.context.key).toBe("value");
      expect(err.name).toBe("GmplError");
      expect(err).toBeInstanceOf(Error);
    });

    it("should carry optional cause", () => {
      const cause = new Error("root cause");
      const err = new GmplError("TEST", "msg", {}, cause);
      expect(err.cause).toBe(cause);
    });
  });

  describe("PatternNotFoundError", () => {
    it("should list available patterns", () => {
      const err = new PatternNotFoundError("missing_pattern", ["a", "b", "c"]);
      expect(err.code).toBe("PATTERN_NOT_FOUND");
      expect(err.context.patternId).toBe("missing_pattern");
      expect(err.context.available).toEqual(["a", "b", "c"]);
      expect(err).toBeInstanceOf(GmplError);
      expect(err).toBeInstanceOf(PatternNotFoundError);
      expect(err.message).toContain("missing_pattern");
    });

    it("should handle empty registry", () => {
      const err = new PatternNotFoundError("missing", []);
      expect(err.message).toContain("Registry is empty");
    });
  });

  describe("RoleNotFoundError", () => {
    it("should include role ID and available list", () => {
      const err = new RoleNotFoundError("missing_role", ["analyst", "critic"]);
      expect(err.code).toBe("ROLE_NOT_FOUND");
      expect(err.context.roleId).toBe("missing_role");
      expect(err).toBeInstanceOf(GmplError);
    });
  });

  describe("DomainNotRegisteredError", () => {
    it("should include domain ID", () => {
      const err = new DomainNotRegisteredError("healthcare", ["trading"]);
      expect(err.code).toBe("DOMAIN_NOT_REGISTERED");
      expect(err.context.domainId).toBe("healthcare");
      expect(err.message).toContain("healthcare");
    });
  });

  describe("PatternValidationError", () => {
    it("should carry pattern ID and field name", () => {
      const err = new PatternValidationError("bad_pattern", "configSchema", "Must be a Zod schema");
      expect(err.code).toBe("PATTERN_VALIDATION");
      expect(err.context.patternId).toBe("bad_pattern");
      expect(err.context.field).toBe("configSchema");
    });

    it("should carry optional cause", () => {
      const cause = new Error("zod parse failed");
      const err = new PatternValidationError("p", "f", "d", cause);
      expect(err.cause).toBe(cause);
    });
  });

  describe("CompositionError", () => {
    it("should carry composition name", () => {
      const err = new CompositionError("my_pipeline", "Empty stages");
      expect(err.code).toBe("COMPOSITION_ERROR");
      expect(err.context.compositionName).toBe("my_pipeline");
    });
  });

  describe("OutcomeResolutionError", () => {
    it("should carry pending ID", () => {
      const err = new OutcomeResolutionError("pending-123", "KG query failed");
      expect(err.code).toBe("OUTCOME_RESOLUTION");
      expect(err.context.pendingId).toBe("pending-123");
    });
  });

  describe("ConvergenceError", () => {
    it("should carry pattern ID and round count", () => {
      const err = new ConvergenceError("delphi_panel", 10, "StdDev still above threshold");
      expect(err.code).toBe("CONVERGENCE_FAILURE");
      expect(err.context.patternId).toBe("delphi_panel");
      expect(err.context.rounds).toBe(10);
    });
  });

  describe("Registry integration", () => {
    it("PatternRegistry throws PatternValidationError on duplicate", () => {
      PatternRegistry.reset();
      const registry = PatternRegistry.getInstance();

      // Built-in "structured_debate" is auto-registered
      expect(() => {
        registry.register({
          id: "structured_debate",
          version: "1.0",
          description: "dup",
          workflowRef: "dup.json",
          configSchema: z.object({}),
          requiredRoles: [],
          inputContract: z.object({}),
          outputContract: z.object({}),
          observabilityEvents: [],
        });
      }).toThrow(PatternValidationError);
    });

    it("RoleRegistry throws RoleNotFoundError on bad extend", () => {
      RoleRegistry.reset();
      const registry = RoleRegistry.getInstance();

      expect(() => {
        registry.extend("new_role", "nonexistent_base", {});
      }).toThrow(RoleNotFoundError);
    });
  });
});
