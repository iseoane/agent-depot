import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createPortableExecutableResolver } from "../src/executable-resolution.js";
import { runProcess, spawnInvocation } from "../src/process-runner.js";

async function withPath<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const previous = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT };
  process.env.PATH = directory;
  // Lowercase so fixtures resolve on case-sensitive filesystems; Windows matches case-insensitively.
  process.env.PATHEXT = ".com;.exe;.bat;.cmd";
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Windows resolution skips the extensionless npm sh shim and picks name.cmd", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-win-resolve-"));
  try {
    for (const name of ["pi", "pi.cmd", "pi.ps1"]) await writeFile(path.join(directory, name), "");
    const resolution = await withPath(directory, () => createPortableExecutableResolver({ platform: "win32", isWsl: false })("pi"));
    assert.deepEqual(resolution, { executable: path.join(directory, "pi.cmd"), blocked: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows resolution accepts a name that already carries a PATHEXT extension", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-win-resolve-"));
  try {
    await writeFile(path.join(directory, "tool.exe"), "");
    const resolution = await withPath(directory, () => createPortableExecutableResolver({ platform: "win32", isWsl: false })("tool.exe"));
    assert.equal(resolution.executable, path.join(directory, "tool.exe"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows resolution reports nothing when only the extensionless shim exists", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-win-resolve-"));
  try {
    await writeFile(path.join(directory, "pi"), "");
    const resolution = await withPath(directory, () => createPortableExecutableResolver({ platform: "win32", isWsl: false })("pi"));
    assert.deepEqual(resolution, { executable: undefined, blocked: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Windows batch file runs through cmd.exe with escaped verbatim arguments", () => {
  const invocation = spawnInvocation(
    "C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd",
    ["install", "git:github.com/iseoane/isSWF", "a b%c", "say \"hi\"", "trail\\"],
    "win32",
  );
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(
    invocation.args[3],
    "\"C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd ^\"install^\" ^\"git:github.com/iseoane/isSWF^\" "
      + "^\"a^ b^%c^\" ^\"say^ \\^\"hi\\^\"^\" ^\"trail\\\\^\"\"",
  );
});

test("a Windows batch file path with metacharacters is escaped for cmd.exe", () => {
  const invocation = spawnInvocation("C:\\Program Files (x86)\\tool.BAT", [], "win32");
  assert.equal(invocation.args[3], "\"C:\\Program^ Files^ ^(x86^)\\tool.BAT\"");
});

test("executables and non-Windows hosts spawn directly", () => {
  assert.deepEqual(spawnInvocation("C:\\tools\\claude.exe", ["--version"], "win32"),
    { command: "C:\\tools\\claude.exe", args: ["--version"], windowsVerbatimArguments: false });
  assert.deepEqual(spawnInvocation("/usr/bin/pi.cmd", ["install"], "linux"),
    { command: "/usr/bin/pi.cmd", args: ["install"], windowsVerbatimArguments: false });
});

function quotedLine(argument: string): string {
  return spawnInvocation("C:\\t.cmd", [argument], "win32").args[3]!;
}

test("batch-file arguments follow the MSVCRT backslash rule", () => {
  // Wrapper `"C:\t.cmd ^"..^""`: the escaped argument sits between the first `^"` and last `^"`.
  const cases: Array<[string, string]> = [
    ["a\\\\\"b", "a\\\\\\\\\\^\"b"], // a\\"b -> 2*2+1 backslashes before the (cmd-escaped) quote
    ["x\\\\", "x\\\\\\\\"],               // trailing run of 2 -> 4
    ["x\\", "x\\\\"],                      // trailing run of 1 -> 2
    ["x\\y", "x\\y"],                        // run followed by a plain character is unchanged
  ];
  for (const [argument, encoded] of cases) {
    assert.equal(quotedLine(argument), `"C:\\t.cmd ^"${encoded}^""`, JSON.stringify(argument));
  }
});

test("a long backslash run before a quote is encoded exactly", () => {
  const line = quotedLine(`${"\\".repeat(10000)}"`);
  assert.equal(line, `"C:\\t.cmd ^"${"\\".repeat(20001)}^"^""`);
});

test("batch-file arguments cmd.exe could misparse are rejected with EINVAL naming the index", () => {
  for (const unsafe of ["a\nb", "a\rb", "a&b", "a|b", "a<b", "a>b"]) {
    assert.throws(
      () => spawnInvocation("C:\\t.cmd", ["ok", unsafe], "win32"),
      (error: NodeJS.ErrnoException) => error.code === "EINVAL" && /Argument 1 /u.test(error.message) && !error.message.includes(unsafe),
    );
  }
  assert.deepEqual(spawnInvocation("C:\\t.exe", ["a&b"], "win32").args, ["a&b"]);
  assert.deepEqual(spawnInvocation("/usr/bin/t.cmd", ["a&b"], "linux").args, ["a&b"]);
});

test("the batch-file runner is ComSpec, falling back to cmd.exe when unset or empty", () => {
  const previous = process.env.ComSpec;
  try {
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    assert.equal(spawnInvocation("C:\\t.cmd", [], "win32").command, "C:\\Windows\\System32\\cmd.exe");
    process.env.ComSpec = "";
    assert.equal(spawnInvocation("C:\\t.cmd", [], "win32").command, "cmd.exe");
    delete process.env.ComSpec;
    assert.equal(spawnInvocation("C:\\t.cmd", [], "win32").command, "cmd.exe");
  } finally {
    if (previous === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = previous;
  }
});

test("Windows resolution falls back to the default PATHEXT when it is empty or blank", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-depot-win-resolve-"));
  const previous = process.env.PATHEXT;
  try {
    await writeFile(path.join(directory, "pi.CMD"), "");
    for (const pathext of ["", " ; ;"]) {
      const resolution = await withPath(directory, async () => {
        process.env.PATHEXT = pathext;
        return await createPortableExecutableResolver({ platform: "win32", isWsl: false })("pi");
      });
      assert.equal(resolution.executable, path.join(directory, "pi.CMD"), JSON.stringify(pathext));
    }
  } finally {
    if (previous === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("runProcess round-trips arguments byte-identically through a real .cmd in a path with a space and (x86)", {
  skip: process.platform !== "win32" && "needs cmd.exe to run a real batch file",
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-depot-win-cmd-"));
  try {
    const directory = path.join(root, "Program Files (x86)", "agent depot");
    await mkdir(directory, { recursive: true });
    const script = path.join(directory, "echo-args.cjs");
    const shim = path.join(directory, "echo-args.cmd");
    await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    // Same shape as an npm cmd-shim: the batch file forwards its arguments with `%*`.
    await writeFile(shim, `@"${process.execPath}" "${script}" %*\r\n`);

    const args = ["", "a b", "say \"hi\"", "x\\", "x\\\\", "a\\\\\"b", "%PATH%"];
    const result = await runProcess(shim, args, { captureStdout: true, timeoutMs: 30_000 });
    const output = Buffer.from(result.stdout).toString("utf8");
    const detail = `code=${result.code} signal=${result.signal} stdout=${output} stderr=${result.stderr}`;
    assert.equal(result.code, 0, detail);
    assert.deepEqual(JSON.parse(output), args, detail);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
