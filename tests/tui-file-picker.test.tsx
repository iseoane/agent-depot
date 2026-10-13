import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { render } from "ink-testing-library";
import {
  DEFAULT_PROFILE_FILE_NAME, exportDestination, fileNameNotice, pathExists, pickerEntries, pickerStartDirectory,
  resolveExportFileName, sortDirectoryEntries, type DirectoryListing, type PickerSelection,
} from "../src/tui/file-picker-model.js";
import { FilePicker } from "../src/tui/file-picker.js";
import { waitForFrame } from "./wait-for-frame.js";

test("export file names gain .json only when they have no extension, and unsafe names are refused", () => {
  assert.deepEqual(resolveExportFileName("agent-depot-profile"), { kind: "ok", fileName: "agent-depot-profile.json", appendedExtension: true });
  assert.deepEqual(resolveExportFileName("profile.JSON"), { kind: "ok", fileName: "profile.JSON", appendedExtension: false });
  assert.deepEqual(resolveExportFileName("notes.txt"), { kind: "ok", fileName: "notes.txt", appendedExtension: false });
  assert.deepEqual(resolveExportFileName(".hidden"), { kind: "ok", fileName: ".hidden.json", appendedExtension: true });
  assert.deepEqual(resolveExportFileName(""), { kind: "invalid", message: "Enter a file name." });
  assert.deepEqual(resolveExportFileName("."), { kind: "invalid", message: "A file name cannot be . or .." });
  assert.deepEqual(resolveExportFileName(".."), { kind: "invalid", message: "A file name cannot be . or .." });
  assert.equal(resolveExportFileName("sub/profile").kind, "invalid");
  assert.equal(resolveExportFileName("sub\\profile").kind, "invalid");
  assert.equal(exportDestination("/tmp/out", DEFAULT_PROFILE_FILE_NAME), path.join("/tmp/out", "agent-depot-profile.json"));
  assert.equal(fileNameNotice("notes.txt"), "Keeping the .txt extension; import lists .json files by default; press f to show all files.");
  assert.equal(fileNameNotice("profile.json"), undefined);
});

test("the picker start directory follows startDirectory, then projectRoot, and is always absolute", () => {
  assert.equal(pickerStartDirectory({ startDirectory: "/picked", projectRoot: "/project" }), "/picked");
  assert.equal(pickerStartDirectory({ projectRoot: "/project" }), "/project");
  assert.ok(path.isAbsolute(pickerStartDirectory({ startDirectory: "relative" })));
  assert.equal(pickerStartDirectory({ startDirectory: "relative" }), path.resolve("relative"));
});

test("directory entries sort folders before files and files by code point", () => {
  assert.deepEqual(sortDirectoryEntries([
    { name: "b.txt", kind: "file" }, { name: "a.json", kind: "file" }, { name: "z", kind: "directory" },
  ]), [
    { name: "z", kind: "directory" }, { name: "a.json", kind: "file" }, { name: "b.txt", kind: "file" },
  ]);
});

test("file purpose hides non-JSON files until showAllFiles", () => {
  const listing: DirectoryListing = { directory: "/x", parent: "/", entries: [
    { name: "sub", kind: "directory" }, { name: "a.json", kind: "file" }, { name: "b.txt", kind: "file" },
  ] };
  assert.deepEqual(pickerEntries(listing, "file", false).map(entry => entry.name), ["sub", "a.json"]);
  assert.deepEqual(pickerEntries(listing, "file", true).map(entry => entry.name), ["sub", "a.json", "b.txt"]);
  assert.deepEqual(pickerEntries(listing, "directory", true).map(entry => entry.name), ["sub"]);
});

test("the directory picker selects the current folder and descends into a subfolder", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "picker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sub = path.join(root, "sub");
  await mkdir(sub);
  await writeFile(path.join(root, "a.json"), "{}");
  const chosen: PickerSelection[] = [];
  const view = render(<FilePicker purpose="directory" startDirectory={root} onCancel={() => {}} onChoose={selection => chosen.push(selection)} />);
  t.after(() => view.unmount());
  const first = await waitForFrame(view.lastFrame, frame => frame.includes(`Use this folder: ${root}`));
  assert.match(first, /> Use this folder/);
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, () => chosen.length === 1);
  assert.deepEqual(chosen, [{ kind: "directory", directory: root }]);

  // `sub/` is the first row after "Use this folder" and the parent row when open.
  view.stdin.write("j");
  await waitForFrame(view.lastFrame, frame => frame.includes("> .. (parent folder)"));
  view.stdin.write("j");
  await waitForFrame(view.lastFrame, frame => frame.split("\n").some(line => line.includes("> ") && line.includes("sub/")));
  view.stdin.write("\r");
  const inside = await waitForFrame(view.lastFrame, frame => frame.includes(`Directory: ${sub}`));
  assert.match(inside, /\.\. \(parent folder\)/);
});

test("the file picker hides non-JSON files until f and toggles back", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "picker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.json"), "{}");
  await writeFile(path.join(root, "b.txt"), "text");
  const view = render(<FilePicker purpose="file" startDirectory={root} onCancel={() => {}} onChoose={() => {}} />);
  t.after(() => view.unmount());
  const filtered = await waitForFrame(view.lastFrame, frame => frame.includes("a.json"));
  assert.doesNotMatch(filtered, /b\.txt/);
  assert.match(filtered, /f all files/);
  view.stdin.write("f");
  const all = await waitForFrame(view.lastFrame, frame => frame.includes("b.txt"));
  assert.match(all, /f json only/);
  view.stdin.write("f");
  await waitForFrame(view.lastFrame, frame => !frame.includes("b.txt"));
});

test("the picker cancel key calls back while the notice stays inline", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "picker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let cancelled = 0;
  const view = render(<FilePicker purpose="file" startDirectory={root} notice="Error: invalid JSON" onCancel={() => { cancelled++; }} onChoose={() => {}} />);
  t.after(() => view.unmount());
  const frame = await waitForFrame(view.lastFrame, frame => frame.includes("Error: invalid JSON"));
  assert.match(frame, /Choose import file/);
  view.stdin.write("\u001b");
  await waitForFrame(view.lastFrame, () => cancelled === 1);
  assert.equal(cancelled, 1);
});

test("a slow earlier read never replaces a newer directory", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "picker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const slow = path.join(root, "slow");
  const fast = path.join(root, "fast");
  await mkdir(slow);
  await mkdir(fast);
  let slowStarted = false;
  const readDirectory = async (directory: string): Promise<DirectoryListing> => {
    if (directory === slow) { slowStarted = true; await new Promise(resolve => setTimeout(resolve, 120)); }
    return { directory, parent: root, entries: [{ name: path.basename(directory), kind: "directory" }] };
  };
  const view = render(<FilePicker purpose="directory" startDirectory={slow} readDirectory={readDirectory} onCancel={() => {}} onChoose={() => {}} />);
  t.after(() => view.unmount());
  view.rerender(<FilePicker purpose="directory" startDirectory={fast} readDirectory={readDirectory} onCancel={() => {}} onChoose={() => {}} />);
  await waitForFrame(view.lastFrame, frame => frame.includes(`Directory: ${fast}`));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(slowStarted, "the first read must have started");
  assert.ok(view.lastFrame()!.includes(`Directory: ${fast}`), "the slow read must not replace the newer directory");
});

test("a directory read error is shown in the picker and Esc leaves it", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "picker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = path.join(root, "missing");
  let cancelled = 0;
  const view = render(<FilePicker purpose="directory" startDirectory={missing} onCancel={() => { cancelled++; }} onChoose={() => {}} />);
  t.after(() => view.unmount());
  const frame = await waitForFrame(view.lastFrame, frame => /Error:.*ENOENT/.test(frame));
  assert.match(frame, /Choose export folder/);
  view.stdin.write("\u001b");
  await waitForFrame(view.lastFrame, () => cancelled === 1);
  assert.equal(cancelled, 1);
});

test("the picker stays inside a narrow terminal", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "picker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "a-very-long-directory-name-that-wraps-at-narrow-widths"));
  const view = render(<FilePicker purpose="directory" startDirectory={root} listHeight={6} onCancel={() => {}} onChoose={() => {}} />);
  t.after(() => view.unmount());
  Object.defineProperty(view.stdout, "rows", { configurable: true, value: 12 });
  Object.defineProperty(view.stdout, "columns", { configurable: true, value: 30 });
  view.stdout.emit("resize");
  const frame = await waitForFrame(view.lastFrame, frame => frame.includes("Choose export folder") && frame.includes("a-very-long"));
  assert.ok(frame.split("\n").length <= 12, frame);
});

test("pathExists reports ENOENT as absent, exists as present, and propagates permission errors", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "picker-exists-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "file.json");
  await writeFile(file, "{}");
  assert.equal(await pathExists(file), true);
  assert.equal(await pathExists(path.join(root, "missing.json")), false);
  if (process.getuid?.() === 0) return t.skip("permission errors cannot be triggered as root");
  const locked = path.join(root, "locked");
  await mkdir(locked);
  await writeFile(path.join(locked, "file.json"), "{}");
  await chmod(locked, 0o000);
  try {
    await assert.rejects(pathExists(path.join(locked, "file.json")), error => error instanceof Error && "code" in error && error.code === "EACCES");
  } finally {
    await chmod(locked, 0o700);
  }
});

test("a symlink to a directory is classified as a directory and navigated into", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "picker-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const real = path.join(root, "real");
  await mkdir(path.join(real, "inside"), { recursive: true });
  await writeFile(path.join(root, "file.json"), "{}");
  await symlink(real, path.join(root, "dir-link"));
  await symlink(path.join(root, "file.json"), path.join(root, "file-link.json"));
  const view = render(<FilePicker purpose="file" startDirectory={root} onCancel={() => {}} onChoose={() => {}} />);
  t.after(() => view.unmount());
  const frame = await waitForFrame(view.lastFrame, candidate => candidate.includes("dir-link/"));
  assert.match(frame, /dir-link\//);
  assert.match(frame, /file-link\.json(?!\.)/);
  assert.doesNotMatch(frame.replace(/dir-link\//g, ""), /file-link\.json\//);
  view.stdin.write("j");
  await waitForFrame(view.lastFrame, candidate => candidate.split("\n").some(line => line.includes("> ") && line.includes("dir-link/")));
  view.stdin.write("\r");
  const inside = await waitForFrame(view.lastFrame, candidate => candidate.includes(`Directory: ${path.join(root, "dir-link")}`));
  assert.match(inside, /inside\//);
});

test("a failed read recovers through parent navigation, and loading allows leaving a slow directory", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "picker-recover-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "sub"));
  const failing = path.join(root, "missing");
  const failingView = render(<FilePicker purpose="directory" startDirectory={failing} onCancel={() => {}} onChoose={() => {}} />);
  t.after(() => failingView.unmount());
  const error = await waitForFrame(failingView.lastFrame, candidate => /Error:.*ENOENT/.test(candidate));
  assert.match(error, /Loading|Error/);
  failingView.stdin.write("\u001b[D");
  const recovered = await waitForFrame(failingView.lastFrame, candidate => candidate.includes(`Use this folder: ${root}`));
  assert.match(recovered, /sub\//);

  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = path.join(root, "blocked");
  await mkdir(blocked);
  const readDirectory = async (directory: string): Promise<DirectoryListing> => {
    if (directory === blocked) await gate;
    const entries = directory === root ? [{ name: "sub", kind: "directory" as const }] : [];
    return { directory, parent: path.dirname(directory) === directory ? undefined : path.dirname(directory), entries };
  };
  const slowView = render(<FilePicker purpose="directory" startDirectory={blocked} readDirectory={readDirectory} onCancel={() => {}} onChoose={() => {}} />);
  t.after(() => slowView.unmount());
  await waitForFrame(slowView.lastFrame, candidate => candidate.includes("Loading"));
  slowView.stdin.write("\u001b[D");
  const left = await waitForFrame(slowView.lastFrame, candidate => candidate.includes(`Use this folder: ${root}`));
  assert.match(left, /sub\//);
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(slowView.lastFrame()!.includes(`Directory: ${root}`), "the released read must not replace the newer directory");
});

test("the picker fits a wrapped long directory, many entries and its footer without a list height override", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "picker-fit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deep = path.join(root, ...Array.from({ length: 6 }, (_, index) => `very-long-directory-name-${index}`));
  await mkdir(deep, { recursive: true });
  for (let index = 0; index < 30; index++) await writeFile(path.join(deep, `entry-${index}.json`), "{}");
  await writeFile(path.join(deep, "notes.txt"), "text");
  const view = render(<FilePicker purpose="file" startDirectory={deep} onCancel={() => {}} onChoose={() => {}} />);
  t.after(() => view.unmount());
  Object.defineProperty(view.stdout, "rows", { configurable: true, value: 16 });
  Object.defineProperty(view.stdout, "columns", { configurable: true, value: 30 });
  view.stdout.emit("resize");
  await waitForFrame(view.lastFrame, candidate => candidate.includes("1–") && candidate.includes("of 31"));
  view.stdin.write("j");
  const frame = await waitForFrame(view.lastFrame, candidate => candidate.includes("entry-0.json"));
  assert.ok(frame.split("\n").length <= 16, frame);
  assert.match(frame, /f all files/);
  assert.match(frame, /p full path/);
  assert.doesNotMatch(frame, new RegExp(deep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  view.stdin.write("p");
  const fullPath = await waitForFrame(view.lastFrame, /p hide path/);
  const visiblePath = fullPath.replace(/[│╭╮╰╯─\s]/gu, "");
  for (const segment of ["/tmp", path.basename(root), ...Array.from({ length: 6 }, (_, index) => `very-long-directory-name-${index}`)]) {
    assert.ok(visiblePath.includes(segment), `${segment} missing from ${fullPath}`);
  }
  assert.ok(fullPath.split("\n").length <= 16, fullPath);
  view.stdin.write("\u001b");
  const closed = await waitForFrame(view.lastFrame, candidate => candidate.includes("Choose import file"));
  assert.match(closed, /p hide path/);
});
