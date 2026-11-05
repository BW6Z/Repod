# task-planner-sample

A small TypeScript library for describing tasks that depend on each other.

The full rules are in [SPEC.md](SPEC.md).

## Parsing tasks

`parseTasks` turns untrusted input, such as parsed JSON, into tasks and
checks their format:

```ts
import { parseTasks } from "./src/index.ts";

const tasks = parseTasks([
  { id: "compile" },
  { id: "test", dependsOn: ["compile"], priority: 1 },
]);
console.log(tasks.length);
```

Missing `dependsOn` becomes `[]` and missing `priority` becomes `0`. Invalid
input throws `InvalidTaskError`, which carries the position of the first
invalid item in `index`. All library errors extend `TaskPlanError` and have a
`code`.

## Development

Requires Node.js 24 or later. TypeScript files run directly with Node.

```bash
node --test "test/**/*.test.ts"
```
