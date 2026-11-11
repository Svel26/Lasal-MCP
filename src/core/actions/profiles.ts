import type { Domain } from "./types.js";

export type Profile = "class2" | "visu" | "screen" | "lars" | "solution";

export const PROFILE_DOMAINS: Record<Profile, Domain[]> = {
  class2: ["core", "class2"],
  visu: ["core", "visu"],
  screen: ["core", "screen"],
  lars: ["core", "lars"],
  solution: ["core", "class2", "visu", "screen", "lars", "deploy"],
};

export function isProfile(value: string): value is Profile {
  return Object.prototype.hasOwnProperty.call(PROFILE_DOMAINS, value);
}

export function domainsForProfile(profile: Profile): Domain[] {
  return [...PROFILE_DOMAINS[profile]];
}
