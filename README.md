# @sahilgupta28/npm-guard-cli

Blocks `npm i`, `npm install <pkg>`, `npm update`, and `npm ci` from pulling in
packages with poor reputation (low downloads, stale, deprecated, no
repository listed) — unless you explicitly bypass them.

## Install

**From the npm registry:**
```bash
npm install -g @sahilgupta28/npm-guard-cli
```

**From a local tarball (no registry needed):**
```bash
npm install -g ./sahilgupta28-npm-guard-cli-1.0.1.tgz
```

**From source, for development:**
```bash
cd npm-guard-cli
npm link
```

Any of these gives you a global `npm-guard` command.

## Enable it

```bash
npm-guard enable
```

This does two things:
1. Adds an `npm` alias to whichever shell rc files it finds (`~/.bashrc`,
   `~/.zshrc`, `~/.bash_profile`, `~/.config/fish/config.fish`), wrapped in
   clearly marked comments so it's easy to find and remove.
2. Turns on the "enabled" flag in `~/.npm-guard/state.json`.

Restart your shell (or `source ~/.bashrc`) and you're set:

```bash
npm i left-pad          # checked first
npm install             # scans package.json + package-lock.json first
npm update               # scans and re-checks before updating
npm ci                   # scans package-lock.json first
npm run build             # untouched — passes straight through
```

## Toggle without editing your shell again

Once the alias is in place, you can flip checks on/off instantly:

```bash
npm-guard disable   # alias stays, but npm behaves normally again
npm-guard enable    # turns checks back on
npm-guard status    # see current state + config
```

Or override for a single command/session without touching any files:
```bash
NPM_GUARD_ENABLED=0 npm install some-pkg     # skip just this once
npm install some-pkg --guard-disable         # same thing, as a flag
```

## Fully remove it

```bash
npm-guard uninstall
```

Strips the alias block back out of every rc file it touched and restores
normal `npm` behavior after your next shell restart.

## Managing configuration

Global settings live in `~/.npm-guard/config.json` and apply across every
project. Manage them with the CLI instead of hand-editing the file:

```bash
npm-guard config get                          # view everything
npm-guard config get minMonthlyDownloads      # view one key
npm-guard config set minMonthlyDownloads 500
npm-guard config set maxMonthsSinceLastPublish 36
npm-guard config set requireRepository true
npm-guard config set blockDeprecated false
npm-guard config allow some-trusted-package
npm-guard config disallow some-trusted-package
```

Defaults:

| Key | Default |
|---|---|
| `minMonthlyDownloads` | 1000 |
| `maxMonthsSinceLastPublish` | 24 |
| `requireRepository` | false (warns only) |
| `blockDeprecated` | true |
| `allowlist` | `[]` |

### Per-project overrides

Global config applies everywhere, but a given project can override it —
useful for a repo that intentionally depends on something niche. Either add
`npm-guard.config.json` to the project root, or a field in its
`package.json`:

```json
{
  "npmGuard": {
    "allowlist": ["some-legacy-internal-package"]
  }
}
```

Precedence (later overrides earlier): global config → project config file →
`package.json` field → `NPM_GUARD_ALLOW` env var → `--guard-allow` CLI flag.

### One-off bypass, no config changes

```bash
NPM_GUARD_ALLOW="pkg-a,pkg-b" npm install pkg-a
npm install pkg-a --guard-allow=pkg-a
```

## Report-only mode (no install, e.g. for CI)

```bash
npm-guard check
```
Exits `1` if anything in `package.json`/`package-lock.json` fails, `0`
otherwise. Doesn't require the alias to be enabled.

## How the interception actually works

npm has no built-in hook that fires *before* it resolves/downloads a package
you just typed on the command line, so `npm-guard enable` aliases `npm`
itself to the `npm-guard` command. When you run something npm-guard doesn't
need to touch (`npm run`, `npm test`, etc.) it passes straight through
untouched. When you run an install-family command, it checks first, then
hands off to the real `npm` binary — found via `which npm`/`where npm`, which
resolves through your `PATH` and bypasses shell aliases entirely, so there's
no infinite loop.

## Limitations

- Bare `npm install`/`npm ci`/`npm update` with no package name checks
  *everything* currently declared; if anything fails, the whole install is
  blocked rather than silently dropping just the bad dependency, since
  npm-guard doesn't rewrite your `package.json`/lockfile for you. Bypass the
  specific package to proceed.
- Explicit `npm i pkgA pkgB` only drops the ones that fail; the rest still
  install.
- Requires Node 18+ (uses the built-in `fetch`).
- Windows: the alias step only edits POSIX/fish shell configs. On
  PowerShell/cmd, add `Set-Alias npm npm-guard` to your PowerShell profile
  manually.