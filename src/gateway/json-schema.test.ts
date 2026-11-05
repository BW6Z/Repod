import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  ExecutorOutput,
  PlanResponse,
  ReviewOutput,
  RunSummary,
  TriageDecision,
} from "../orchestrator/schemas.ts";
import { toStrictJsonSchema } from "./json-schema.ts";

test("every model output schema converts to the strict subset", () => {
  for (const schema of [PlanResponse, ExecutorOutput, TriageDecision, ReviewOutput, RunSummary]) {
    const json = toStrictJsonSchema(schema);
    assert.equal(json.type, "object");
    assert.equal(json.additionalProperties, false);
  }
});

test("optional properties are rejected", () => {
  assert.throws(() => toStrictJsonSchema(z.strictObject({ a: z.string(), b: z.string().optional() })), /must be required/);
});

test("open objects are rejected", () => {
  assert.throws(() => toStrictJsonSchema(z.looseObject({ a: z.string() })), /additionalProperties/);
});

test("a non-object root is rejected", () => {
  assert.throws(() => toStrictJsonSchema(z.array(z.string())), /root must be an object/);
});
