// Loaded with `node --test --import` so every test process starts from a neutral environment.
// - XDG_STATE_HOME: tests inject their home and state paths; an exported value (for example a
//   manual-testing sandbox with App recipes) must not leak into the default App recipes directory.
// - FORCE_COLOR: `node --test` sets it for its child processes when run from a real terminal, which
//   makes Ink render ANSI colors into the frames the TUI tests match (so `npm publish` failed in a TTY).
delete process.env.XDG_STATE_HOME;
delete process.env.FORCE_COLOR;
