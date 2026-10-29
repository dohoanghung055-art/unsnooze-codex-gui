// Invoked by the UIA helper immediately before Invoke; stdin only, no secrets
// or thread content on the command line. No mutation is performed here.
import { checkUiGoal } from '../src/goal-ui.js';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  await checkUiGoal(JSON.parse(input));
  process.stdout.write(JSON.stringify({ ok: true }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false }));
  process.exitCode = 1;
}
