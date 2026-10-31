import { z, type ZodType } from "zod";

type JsonNode = Record<string, unknown>;

function isNode(value: unknown): value is JsonNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lists violations of the strict structured-output subset that Meta (and
 * other providers) enforce when `strict: true`: object root without
 * top-level combinators, closed objects, every property required, and no
 * oneOf/allOf anywhere. Checking locally turns a provider 400 at run time
 * into a failing unit test.
 */
function strictSubsetProblems(root: JsonNode): string[] {
  const problems: string[] = [];
  if (root.type !== "object") problems.push("$: root must be an object");
  for (const key of ["anyOf", "oneOf", "allOf", "enum", "not"]) {
    if (key in root) problems.push(`$: root must not use ${key}`);
  }

  const visit = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => visit(child, `${at}[${i}]`));
      return;
    }
    if (!isNode(node)) return;
    for (const key of ["oneOf", "allOf"]) {
      if (key in node) problems.push(`${at}: ${key} is not supported`);
    }
    if (node.type === "object") {
      if (node.additionalProperties !== false) problems.push(`${at}: additionalProperties must be false`);
      const properties = isNode(node.properties) ? Object.keys(node.properties) : [];
      const required = Array.isArray(node.required) ? new Set(node.required) : new Set();
      for (const name of properties) {
        if (!required.has(name)) problems.push(`${at}.${name}: every property must be required`);
      }
    }
    for (const [key, child] of Object.entries(node)) visit(child, `${at}.${key}`);
  };
  visit(root, "$");
  return problems;
}

/** Converts a Zod schema to JSON Schema and rejects anything outside the strict subset. */
export function toStrictJsonSchema(schema: ZodType): JsonNode {
  const json = z.toJSONSchema(schema) as JsonNode;
  delete json.$schema; // metadata only; keeps the request body minimal
  const problems = strictSubsetProblems(json);
  if (problems.length > 0) {
    throw new Error(`Schema is not strict-compatible:\n- ${problems.join("\n- ")}`);
  }
  return json;
}
