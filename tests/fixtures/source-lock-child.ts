import { appendFile, mkdir } from "node:fs/promises";

import { GitSourceAccessAdapter, sourceIdForUrl } from "../../src/git-source.js";

// Refreshes one Source through the real lock and logs when its Git "run" starts and ends.
const [cachePath, logPath, label] = process.argv.slice(2);
if (cachePath === undefined || logPath === undefined || label === undefined) {
  throw new Error("usage: source-lock-child <cachePath> <logPath> <label>");
}
const url = "https://github.com/example/skills.git";

await new GitSourceAccessAdapter({
  cachePath,
  runner: {
    async run(_command: string, args: readonly string[]): Promise<void> {
      await appendFile(logPath, `${label} start\n`);
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      if (args[0] === "clone") {
        await mkdir(args[args.length - 1] ?? "", { recursive: true });
      }
      await appendFile(logPath, `${label} end\n`);
    },
  },
}).refresh({ id: sourceIdForUrl(url), kind: "git", url });
