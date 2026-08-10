# Interlock repository rules

Read `GOAL.md` before you change code.

Use Node.js and TypeScript.

Use the Node test runner or an established test tool already selected by the repository.

Keep Interlock modular:

- `core` owns lease state and work-contract rendering.
- `beads` owns Beads CLI integration.
- `cli` owns user input and output.
- `pi` owns Pi extension lifecycle integration.

Do not add Herdr code in V1.

Use exact repository-relative file paths for V1 leases.

Do not modify smoke-target application files.

Do not claim filesystem permissions provide security between same-user agents.

Test behavior through the CLI and public module interfaces.

Use a focused test before you change behavior.

Do not edit a file outside your assigned work contract.

Report changed paths and test output when you finish.
