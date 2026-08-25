# npm-guard-cli

**Stop bad packages before they land in your project.**

`npm-guard-cli` checks a package's reputation — how many people actually
download it, how recently it was updated, whether it's been deprecated, and
whether it even lists a repository — before letting `npm` install it. If a
package looks abandoned, sketchy, or deprecated, the install is blocked with
a clear explanation instead of silently going through.

It works transparently with the commands you already use:
```bash
npm i left-pad       # checked automatically
npm install          # checks everything in package.json first
npm update           # checks before updating
npm ci               # checks everything in package-lock.json first
npm run build        # left alone — not an install command
```

🔗 Source & issues: [github.com/sahilgupta28/npm-guard-cli](https://github.com/sahilgupta28/npm-guard-cli)

---

## Install

```bash
npm install -g @sahilgupta28/npm-guard-cli
```

This gives you a global `npm-guard` command.

## Quick start

Turn it on:

```bash
npm-guard enable
```

Restart your terminal (or run `source ~/.bashrc` / `source ~/.zshrc`), and
you're protected. From now on, `npm i`, `npm install`, `npm update`, and
`npm ci` are all checked automatically before anything gets installed —
everything else (`npm run`, `npm test`, `npm start`, ...) is left completely
alone.

Check it's active any time:

```bash
npm-guard status
```

### What you'll see

When a package looks fine:
```
[npm-guard] Checking reputation for 1 package(s)...

  [OK] express

[npm-guard] All packages passed.
```

When something looks risky:
```
[npm-guard] Checking reputation for 1 package(s)...

  [BLOCKED] some-sketchy-package
         - Only 4 monthly downloads (minimum: 1000)
         - Last published 41.2 months ago (maximum: 24)

[npm-guard] 1 package(s) failed: some-sketchy-package
[npm-guard] Bypass with: npm-guard config allow <pkg>, --guard-allow=<pkg>, or NPM_GUARD_ALLOW.
```

## Malware detection

Every package is also cross-checked against the [OSV malicious-packages
feed](https://osv.dev) — the same database OpenSSF uses to track packages
pulled from npm for containing actual malicious code, not just CVEs. A hit
blocks the install outright, no matter how popular or well-maintained the
package otherwise looks:

```
[BLOCKED] some-package
         - Flagged as known malware in the OSV database (MAL-2025-46966)
```

This matters because supply-chain attacks usually compromise a *legitimate*,
widely-used package's maintainer account and publish a malicious version
under the same name — download counts and history don't protect you.
Before bypassing a block like this, look up the id (e.g.
`https://osv.dev/vulnerability/MAL-2025-46966`) and pin to a version outside
the flagged range rather than allowlisting the package outright.

Separately, npm-guard also warns (without blocking) when a package runs a
`preinstall`, `install`, or `postinstall` script — the most common way
malicious code actually executes on install:

```
[OK] some-package
         ! warning: Runs postinstall script(s) on install — review before trusting
```

That warning alone doesn't mean a package is malicious — plenty of
legitimate tools use install scripts (native builds, telemetry, etc.) — it's
just a signal worth a quick look since it's the mechanism attackers rely on.

## Pausing or turning it off

You don't have to uninstall anything to pause it:

```bash
npm-guard disable   # checks paused, npm behaves normally
npm-guard enable    # checks back on
```

Or skip it for just one command, without changing any settings:

```bash
npm install some-pkg --guard-disable
```

To remove it completely and restore normal `npm` behavior:

```bash
npm-guard uninstall
```

## Global vs. project configuration

npm-guard reads settings from two places, and merges them every time it runs:

| Level | File | Scope |
|---|---|---|
| Global | `~/.npm-guard/config.json` | Every project on this machine |
| Project | `npm-guard.config.json` (repo root) or an `npmGuard` field in `package.json` | Just this repo |

**Project settings always win.** For rules like `minMonthlyDownloads` or
`blockDeprecated`, a value set at the project level overrides the global
value. Allowlists work differently: they're combined (union) from every
level, so a package allowed globally, in the project file, via
`--guard-allow`, or via `NPM_GUARD_ALLOW` is allowed everywhere — an ignore
list only needs to say "yes" once, from any level, to take effect.

Manage either level with the same commands by adding `--project`:

```bash
npm-guard config set minMonthlyDownloads 500              # global
npm-guard config set minMonthlyDownloads 500 --project    # this repo only

npm-guard config allow some-trusted-package                # global
npm-guard config allow some-trusted-package --project      # this repo only
```

`npm-guard status` shows both the global and project config file paths,
plus the effective (merged) settings actually in use for the current
directory.

## Letting a specific package through

If a package fails the check but you know it's fine, you can allow it — pick
whichever fits your workflow:

```bash
# Always allow it, in every project on this machine
npm-guard config allow some-trusted-package

# Just for this project, from the CLI
npm-guard config allow some-trusted-package --project

# Just for one command
npm install some-trusted-package --guard-allow=some-trusted-package
```

The `--project` flag above writes to `npm-guard.config.json` in the current
directory. You can also edit that file directly, or use the equivalent
`npmGuard` field in `package.json` — both are project-level and merge the
same way:

```json
{
  "npmGuard": {
    "allowlist": ["some-trusted-package"]
  }
}
```

## Adjusting the rules

Defaults are reasonable for most people, but you can tune them — globally,
or per project with `--project`:

```bash
npm-guard config get                            # see current global settings
npm-guard config get --project                  # see this project's overrides
npm-guard config set minMonthlyDownloads 500
npm-guard config set maxMonthsSinceLastPublish 36 --project
npm-guard config set requireRepository true
npm-guard config set blockDeprecated false
```

| Setting | Default | Meaning |
|---|---|---|
| `minMonthlyDownloads` | `1000` | Below this, a package is flagged as too obscure |
| `maxMonthsSinceLastPublish` | `24` | Older than this with no update looks abandoned |
| `requireRepository` | `false` | If `true`, packages with no repo link are blocked, not just warned |
| `blockDeprecated` | `true` | Blocks anything npm itself marks as deprecated |
| `blockMalware` | `true` | Blocks anything flagged in the OSV malicious-packages feed |

## Checking a project without installing anything

Useful for CI, or just to see where you stand:

```bash
npm-guard check
```

Exits with an error code if anything in `package.json` or
`package-lock.json` fails the check — handy as a CI step.

## FAQ

**Will this slow down my installs?**
It adds one quick lookup per package before the install starts. For a
handful of packages this is barely noticeable.

**Does it work on Windows?**
Yes, via PowerShell — though the automatic setup only edits bash/zsh/fish
configs. On PowerShell, add this line to your profile manually:
```powershell
Set-Alias npm npm-guard
```

**What if I don't want to alias `npm` at all?**
Use `npm-guard check` on its own — it scans your project without ever
touching how `npm` behaves.

**Requirements:** Node.js 18 or newer.

## License

MIT