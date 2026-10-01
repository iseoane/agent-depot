# Illustrative recipe shape

This fictional App is a format example, not a recommended installation or shipped
App recipe. Replace commands with verified upstream evidence and the chosen
channel. Omitted platform means identical steps everywhere; optional fields may
be omitted rather than populated speculatively.

```json
{
  "name": "example-tool",
  "install": { "argv": ["npm", "install", "-g", "example-tool"] },
  "update": { "argv": ["npm", "install", "-g", "example-tool"] },
  "uninstall": { "argv": ["npm", "uninstall", "-g", "example-tool"] },
  "version": { "argv": ["example-tool", "--version"], "pattern": "(\\d+\\.\\d+\\.\\d+)" },
  "latest": { "npm": "example-tool" },
  "setup": { "claude": { "argv": ["example-tool", "setup", "claude", "--yes"] } },
  "teardown": { "claude": { "manual": "Follow the documented example-tool Claude teardown instructions." } },
  "skills": ["example-tool-*"]
}
```

Use `latest: { "github": "owner/repo" }` for public GitHub Releases, or
`latest: { "argv": ["example-tool", "latest"], "pattern": "(\\d+\\.\\d+\\.\\d+)" }`
for a documented read-only command. Choose one latest signal, not a combination.
A step with both `argv` and `manual` falls back only when spawning fails.
