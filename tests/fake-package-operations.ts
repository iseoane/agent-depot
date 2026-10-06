import type { PackageOperations } from "../src/package-flow.js";

/** A PackageOperations whose reads are empty and whose writes throw until the test scripts them. */
export function fakePackageOperations(overrides: Partial<PackageOperations> = {}): PackageOperations {
  const unscripted = (method: string) => async (): Promise<never> => {
    throw new Error(`fake PackageOperations.${method} is not scripted`);
  };
  return {
    discover: async () => [],
    list: async () => [],
    inspect: unscripted("inspect"),
    approvalStatus: async () => "needs approval",
    approve: unscripted("approve"),
    planLifecycle: unscripted("planLifecycle"),
    executeLifecycle: unscripted("executeLifecycle"),
    forget: unscripted("forget"),
    checkUpdates: async () => [],
    ...overrides,
  };
}
