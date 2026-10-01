// Loaded with `node --test --import` so every test process ignores the developer's own Agent Depot
// state location. Tests inject their home and state paths; an exported XDG_STATE_HOME (for example a
// manual-testing sandbox with App recipes) must not leak into the default App recipes directory.
delete process.env.XDG_STATE_HOME;
