# Credits

## Atticus

E.V's background Mac control borrows methods from **Atticus** by SaarthurR
(https://github.com/SaarthurR/atticus-mac), released under the MIT License. E.V's code is its own
(Rust and TypeScript); these ideas come from Atticus:

- Background clicks and drags: mouse events posted to one app's process with the target window
  stamped in, after a window-server focus record that lets the window take input without being
  raised (`src-tauri/src/mac_control/hands.rs`).
- Checking every action: reading the window before and after, and reporting what changed or that
  nothing changed (`hands.rs`, `src/providers/agent/macTools.ts`).
- Menus by name (`hands.rs`).
- Learned tasks that repeat confirmed steps with no AI call (`src/services/learned.ts`).

Atticus credits Plip (github.com/hussainn7/plip-oss, MIT) and Cua Driver (github.com/trycua/cua,
MIT) for parts of the same techniques.

MIT License — Copyright (c) SaarthurR
