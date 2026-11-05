import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { PipelineHooks } from "../orchestrator/orchestrator.ts";

/**
 * The conversation with Meta in a terminal: answer clarifying questions (an
 * empty answer takes the default) and approve the plan or send it back once
 * with feedback. These are the only points where the user takes part.
 */
export function terminalHooks(): PipelineHooks {
  const ask = async (question: string): Promise<string> => {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };

  return {
    async answerQuestions(questions, message) {
      console.log(`\nMeta: ${message}\n`);
      const answers: Record<string, string> = {};
      for (const q of questions) {
        const answer = await ask(`${q.question}\n  (${q.why})\n  [${q.default}] > `);
        answers[q.id] = answer || q.default;
      }
      return answers;
    },

    async reviewPlan(plan, decisions, warnings, canRevise) {
      console.log(`\nMeta: ${plan.message}\n`);
      plan.tasks.forEach((task, i) => {
        const decision = decisions[i];
        const model = decision?.raised ? `${decision.model} (raised from ${task.model}: ${decision.reason})` : task.model;
        console.log(`${task.id}  ${task.title}`);
        console.log(`    ${task.type}, ${task.complexity}, ${task.impact} impact -> ${model}`);
        console.log(`    why: ${task.reason}`);
        console.log(`    writes: ${task.write_files.join(", ")}`);
        if (task.check_groups.length) console.log(`    checked by: ${task.check_groups.join(", ")}`);
        if (task.depends_on.length) console.log(`    after: ${task.depends_on.join(", ")}`);
      });
      for (const warning of warnings) console.log(`warning: ${warning.message}`);
      const answer = await ask(
        canRevise
          ? "\nApprove this plan? Press Enter or type y to approve, or type feedback to send it back once: "
          : "\nApprove the revised plan? Press Enter or type y to approve; anything else stops the run: ",
      );
      return answer === "" || /^y(es)?$/i.test(answer) ? { approve: true } : { approve: false, feedback: answer };
    },
  };
}
