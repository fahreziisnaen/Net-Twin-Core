import { ParserProfile, ParsedConfig } from './types';
import { runProfile, detectVendor as detectVendorEngine } from './engine';
import { SEED_PROFILES } from './profiles';

export * from './types';
export { runProfile } from './engine';
export { SEED_PROFILES } from './profiles';

// Parse using a specific profile id (or an explicitly supplied profile).
// `profiles` lets the server pass DB-stored profiles; defaults to the seeds.
export function parseConfig(
  config: string,
  vendorId?: string | null,
  profiles: ParserProfile[] = SEED_PROFILES
): ParsedConfig {
  const id = vendorId || detectVendorEngine(config, profiles);
  const profile = profiles.find(p => p.id === id);
  if (!profile) {
    return {
      hostname: '', vrfs: [], interfaces: [], routes: [], firewallRules: [], natMappings: [],
      warnings: [`No parser profile for vendor "${id ?? 'unknown'}". Pick a vendor manually or create a new profile.`],
    };
  }
  return runProfile(config, profile);
}

export function detectVendor(config: string, profiles: ParserProfile[] = SEED_PROFILES): string | null {
  return detectVendorEngine(config, profiles);
}
