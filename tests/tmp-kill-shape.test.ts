import { spawn } from "node:child_process";
import { test } from "node:test";

test("TMPDIAG base child.kill() shape on win32", { skip: process.platform !== "win32" }, async () => {
  const shape = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: ["ignore", "ignore", "pipe"] });
    setTimeout(() => child.kill(), 500);
    child.on("close", (code, signal) => resolve(JSON.stringify({ code, signal, exitCode: child.exitCode, signalCode: child.signalCode })));
  });
  console.log(`TMPDIAG kill() ${shape}`);
  const tree = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: ["ignore", "ignore", "pipe"] });
    setTimeout(() => { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); }, 500);
    child.on("close", (code, signal) => resolve(JSON.stringify({ code, signal, exitCode: child.exitCode, signalCode: child.signalCode })));
  });
  console.log(`TMPDIAG taskkill ${tree}`);
});
