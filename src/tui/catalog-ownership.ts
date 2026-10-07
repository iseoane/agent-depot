import type { BundleDescriptor } from "../package-model.js";

/** Compact badge for a Skill reserved by an active Package. */
export function packageOwnerBadge(owner: BundleDescriptor): string {
  return `${owner.host}:${owner.name}`;
}

/** Full reason shown outside the row so the row can stay one physical line. */
export function packageOwnedSkillNotice(owner: BundleDescriptor): string {
  return `Package-owned Skill: provided by the ${owner.host} Package ${owner.name}. Install or update the Package from its Package row.`;
}

/** Actionable refusal for attempts to install a Package-owned Skill as loose. */
export function packageOwnedSkillAction(owner: BundleDescriptor): string {
  return `Install or update the ${owner.host} Package ${owner.name} from its Package row.`;
}
