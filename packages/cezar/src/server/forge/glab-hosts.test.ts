import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __clearGlabHostCacheForTests, glabHostConfigPaths, knownGlabHosts } from './glab-hosts.ts';

/**
 * The glab-hosts loader (GitLab spec D1, Phase 2 step 6): discover the self-hosted GitLab
 * instances this machine is authenticated against, from `glab`'s own config, and NEVER touch the
 * tokens that live in the same file.
 */

/** A realistic `glab` config: the hosts map is keyed by hostname and every value is a credential.
 *  Fixtures carry the token so the "never returns a value" assertions have something to catch. */
const TOKEN = 'glpat-000000000000000000000';
const config = (...hosts: string[]) =>
  ['hosts:', ...hosts.flatMap((host) => [`    ${host}:`, `        token: ${TOKEN}`, '        api_protocol: https'])].join(
    '\n',
  );

describe('glab hosts discovery', () => {
  let dir: string;

  const write = (path: string, contents: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-glab-'));
    __clearGlabHostCacheForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** An env with every glab-relevant variable pinned, so a developer's real `~/.config` can never
   *  reach a test and the default-path cases stay deterministic. */
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME: join(dir, 'home'),
    XDG_CONFIG_DIRS: join(dir, 'etc-xdg'),
    ...extra,
  });

  describe('precedence', () => {
    it('prefers $GLAB_CONFIG_DIR over the legacy ~/.config/glab-cli', () => {
      write(join(dir, 'home/.config/glab-cli/config.yml'), config('legacy.example.com'));
      write(join(dir, 'explicit/config.yml'), config('explicit.example.com'));
      expect(knownGlabHosts({ env: env({ GLAB_CONFIG_DIR: join(dir, 'explicit') }) })).toEqual([
        'explicit.example.com',
      ]);
    });

    it('reads the legacy ~/.config/glab-cli when nothing overrides it', () => {
      write(join(dir, 'home/.config/glab-cli/config.yml'), config('legacy.example.com'));
      expect(knownGlabHosts({ env: env() })).toEqual(['legacy.example.com']);
    });

    it('falls through the legacy path to $XDG_CONFIG_HOME', () => {
      write(join(dir, 'xdg/glab-cli/config.yml'), config('xdg.example.com'));
      expect(knownGlabHosts({ env: env({ XDG_CONFIG_HOME: join(dir, 'xdg') }) })).toEqual(['xdg.example.com']);
    });

    it('falls through to $XDG_CONFIG_DIRS last', () => {
      write(join(dir, 'etc-xdg/glab-cli/config.yml'), config('site.example.com'));
      expect(knownGlabHosts({ env: env() })).toEqual(['site.example.com']);
    });

    it('stops at the first file that EXISTS, even when it names no hosts', () => {
      write(join(dir, 'home/.config/glab-cli/config.yml'), 'git_protocol: ssh\n');
      write(join(dir, 'etc-xdg/glab-cli/config.yml'), config('site.example.com'));
      expect(knownGlabHosts({ env: env() })).toEqual([]);
    });

    it('unions the per-repo .git/glab-cli config rather than letting it terminate the walk', () => {
      write(join(dir, 'home/.config/glab-cli/config.yml'), config('global.example.com'));
      write(join(dir, 'repo/.git/glab-cli/config.yml'), config('repo.example.com'));
      expect(knownGlabHosts({ env: env(), repoRoot: join(dir, 'repo') }).sort()).toEqual([
        'global.example.com',
        'repo.example.com',
      ]);
    });

    it('lists ~/.config once when XDG_CONFIG_HOME points at it', () => {
      const paths = glabHostConfigPaths(env({ XDG_CONFIG_HOME: join(dir, 'home/.config') })).global;
      expect(new Set(paths).size).toBe(paths.length);
    });
  });

  describe('degradation', () => {
    it('is empty when glab was never configured', () => {
      expect(knownGlabHosts({ env: env() })).toEqual([]);
    });

    it('is empty for corrupt YAML, and warns once without echoing the file', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const path = join(dir, 'home/.config/glab-cli/config.yml');
      write(path, `hosts:\n  git.acme.internal:\n    token: ${TOKEN}\n   bad-indent: [unclosed\n`);

      expect(knownGlabHosts({ env: env() })).toEqual([]);
      expect(knownGlabHosts({ env: env() })).toEqual([]);

      expect(warn).toHaveBeenCalledTimes(1);
      // The parser quotes the offending source line, and on this file that line may be the token.
      expect(warn.mock.calls.flat().join(' ')).not.toContain(TOKEN);
      expect(warn.mock.calls.flat().join(' ')).toContain(path);
    });

    it('is empty for a config with no hosts map, and for one that is not a map at all', () => {
      write(join(dir, 'home/.config/glab-cli/config.yml'), 'git_protocol: ssh\n');
      expect(knownGlabHosts({ env: env() })).toEqual([]);

      __clearGlabHostCacheForTests();
      write(join(dir, 'home/.config/glab-cli/config.yml'), '- just\n- a list\n');
      expect(knownGlabHosts({ env: env() })).toEqual([]);
    });

    it('skips a malformed host row instead of dropping the whole file', () => {
      write(join(dir, 'home/.config/glab-cli/config.yml'), config('not a hostname', 'git.acme.internal'));
      expect(knownGlabHosts({ env: env() })).toEqual(['git.acme.internal']);
    });
  });

  describe('the security rule — keys only, never values', () => {
    it('returns hostnames and nothing else', () => {
      write(join(dir, 'home/.config/glab-cli/config.yml'), config('git.acme.internal', 'gitlab.example.com'));
      const hosts = knownGlabHosts({ env: env() });

      expect(hosts.sort()).toEqual(['git.acme.internal', 'gitlab.example.com']);
      // Not a redaction check — a shape check. Every element is a string that is a hostname, so
      // there is no field a token could ride in even if the loader grew one.
      expect(JSON.stringify(hosts)).not.toContain(TOKEN);
      expect(hosts.every((host) => typeof host === 'string')).toBe(true);
    });

    it('keeps no token in the cache either, across repeated reads', () => {
      write(join(dir, 'home/.config/glab-cli/config.yml'), config('git.acme.internal'));
      knownGlabHosts({ env: env() });
      expect(JSON.stringify(knownGlabHosts({ env: env() }))).not.toContain(TOKEN);
    });
  });

  describe('normalization and caching', () => {
    it('lowercases, and tolerates a scheme or path a hand-edited config might carry', () => {
      write(
        join(dir, 'home/.config/glab-cli/config.yml'),
        config('GitLab.Example.COM', 'https://git.acme.internal/', 'ports.example.com:8443'),
      );
      expect(knownGlabHosts({ env: env() }).sort()).toEqual([
        'git.acme.internal',
        'gitlab.example.com',
        'ports.example.com:8443',
      ]);
    });

    it('picks up a config rewritten after it was cached', () => {
      const path = join(dir, 'home/.config/glab-cli/config.yml');
      write(path, config('first.example.com'));
      expect(knownGlabHosts({ env: env() })).toEqual(['first.example.com']);

      write(path, config('second.example.com'));
      // A same-millisecond rewrite of the same size would otherwise read as unchanged; glab does
      // not write this file that fast, and the test should not depend on the scheduler.
      const later = new Date(Date.now() + 2_000);
      utimesSync(path, later, later);
      expect(knownGlabHosts({ env: env() })).toEqual(['second.example.com']);
    });
  });
});
