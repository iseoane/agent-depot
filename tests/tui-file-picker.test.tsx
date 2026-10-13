import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { render } from "ink-testing-library";
import {
  DEFAULT_PROFILE_FILE_NAME, exportDestination, fileNameNotice, pickerEntries, pickerStartDirectory,
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
  assert.equal(fileNameNotice("notes.txt"), "Keeping the .txt extension; Agent Depot reads .json Profiles only.");
  assert.equal(fileNameNotice("profile.json"), undefined);
});

test("the picker start directory follows startDirectory, then projectRoot", () => {
  assert.equal(pickerStartDirectory({ startDirectory: "/picked", projectRoot: "/project" }), "/picked");
  assert.equal(pickerStartDirectory({ projectRoot: "/project" }), "/project");
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
