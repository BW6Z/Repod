# Holdout tests

Human-written tests used only for final evaluation. They are never placed in a
model's context and run exactly once per run, after the candidate is frozen;
their failure details are not fed back into the same run.

While the experiments are running, the tests are kept outside this public
repository and passed to a run with `--holdout <dir>`. They will be committed
here after the experiments so results can be reproduced. Until then,
`.gitignore` and the CI hygiene check refuse `*.ts` files in this folder.
