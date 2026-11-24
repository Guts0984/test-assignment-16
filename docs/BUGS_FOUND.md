# Bugs found by tests

Every row is a bug a test caught. The test stays in the suite.

| # | Attack / scenario | Impact | Root cause | Fix | Test |
| --- | --- | --- | --- | --- | --- |
| 1 | Reserve 4 of 10 units on an existing balance row (any negative or reserve-only delta) | Every reserve, pick and unreserve failed with a CHECK violation: no stock could ever leave a cell | The ledger trigger used `INSERT ... ON CONFLICT DO UPDATE`; Postgres checks CHECK constraints on the proposed insert row (`on_hand 0, reserved 4`) before resolving the conflict | Trigger does `UPDATE` first and only `INSERT`s a missing row, retrying on `unique_violation` | `packages/db/test/constraints.int.spec.ts` ("a movement creates and updates the balance", "100 parallel reservers") |
