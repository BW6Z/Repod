# Holdout tests

Human-written tests used only for final evaluation. They are never placed in a
model's context and run exactly once per run, after the candidate is frozen;
their failure details are not fed back into the same run.

They will be committed after the experiments so results can be reproduced.
