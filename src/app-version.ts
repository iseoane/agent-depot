/** Strict SemVer ordering; unlike Skill's permissive comparator, opaque inputs stay distinguishable. */
export function compareAppVersions(left: string, right: string): number | undefined {
  const parse = (value: string) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/u.exec(value.replace(/^v/u, ""));
    if (!match) return undefined;
    const pre = match[4]?.split(".") ?? [];
    if (pre.some(part => /^\d+$/u.test(part) && /^0\d/u.test(part))) return undefined;
    return { core: match.slice(1, 4).map(part => BigInt(part!)), pre };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index]! < b.core[index]! ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length);
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numericX = /^\d+$/u.test(x);
    const numericY = /^\d+$/u.test(y);
    if (numericX && numericY) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
