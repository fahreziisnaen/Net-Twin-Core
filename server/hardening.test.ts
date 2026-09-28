import { describe, test, expect, afterEach } from 'vitest';
import { runProfile } from './parsers';
import { ParserProfile } from './parsers/types';
import fs from 'fs';
import path from 'path';
import { isVendorSupported, commandsFor, isCollectIntent, COMMAND_WHITELIST } from './collector/whitelist';
import { isWeakSecret } from './secrets';

afterEach(() => {
  delete (Object.prototype as any).evil;
  delete (Object.prototype as any).polluted;
});

describe('parser engine treats profile data as untrusted', () => {
  test('a table named __proto__ cannot pollute Object.prototype', () => {
    const profile: ParserProfile = {
      id: 'evil', name: 'Evil', detect: [],
      rules: [{ match: '^set (\\S+) (\\S+)$', table: { name: '__proto__', keyGroup: 1, value: '$2' } }],
    };
    runProfile('set polluted yes\nset evil 1', profile);
    expect(({} as any).polluted).toBeUndefined();
    expect(({} as any).evil).toBeUndefined();
  });

  test('inherited names never resolve as table/static/transform entries', () => {
    const profile: ParserProfile = {
      id: 'p', name: 'P', detect: [],
      rules: [{
        match: '^host (\\S+)$',
        setHostname: { resolve: 'svc', arg: '$1', fallback: { lit: 'fallback' } },
      }],
      statics: { svc: {} },
    };
    expect(runProfile('host constructor', profile).hostname).toBe('fallback');
    expect(runProfile('host toString', profile).hostname).toBe('fallback');

    const withTransform: ParserProfile = {
      id: 't', name: 'T', detect: [],
      rules: [{ match: '^host (\\S+)$', setHostname: { transform: 'constructor' as any, arg: '$1' } }],
    };
    expect(runProfile('host abc', withTransform).hostname).toBe('abc');
  });
});

describe('SSH command whitelist', () => {
  test('inherited object members are not vendors or intents', () => {
    expect(isVendorSupported('cisco_ios')).toBe(true);
    expect(isVendorSupported('constructor')).toBe(false);
    expect(isVendorSupported('__proto__')).toBe(false);
    expect(isVendorSupported(42)).toBe(false);
    expect(isCollectIntent('toString')).toBe(false);
  });

  test('only whitelisted commands come out, whatever intents are asked for', () => {
    const cmds = commandsFor('cisco_ios', ['config', 'constructor', '__proto__', 'arp'] as any);
    expect(cmds).toEqual([
      { intent: 'config', command: 'show running-config' },
      { intent: 'arp', command: 'show ip arp' },
    ]);
    expect(commandsFor('constructor', ['config'])).toEqual([]);
  });

  test('every whitelisted command is also allowed by the Python sidecar', () => {
    // The sidecar rejects a whole collection if any command is unknown to it.
    const sidecar = fs.readFileSync(path.join(__dirname, '..', 'collector', 'main.py'), 'utf-8');
    for (const [vendor, commands] of Object.entries(COMMAND_WHITELIST)) {
      expect(sidecar).toContain(`"${vendor}"`);
      for (const command of Object.values(commands)) expect(sidecar).toContain(`"${command}"`);
    }
  });

  test('per-VRF routing tables use a fixed wildcard command, never a device-supplied name', () => {
    expect(commandsFor('cisco_ios', ['vrfRoutes'])).toEqual([{ intent: 'vrfRoutes', command: 'show ip route vrf *' }]);
    expect(commandsFor('fortinet', ['vrfRoutes'])).toEqual([]); // one command already covers every VRF
  });
});

describe('secret strength', () => {
  test('missing, short and placeholder secrets are weak', () => {
    expect(isWeakSecret(undefined)).toBe(true);
    expect(isWeakSecret('')).toBe(true);
    expect(isWeakSecret('short')).toBe(true);
    expect(isWeakSecret('change-me-in-production')).toBe(true);
    expect(isWeakSecret('change-me-collector-token')).toBe(true);
    expect(isWeakSecret('3f9c1a7be2d04c55a1e8b6d7c9f0a2b4')).toBe(false);
  });
});
