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

---

## Choose how to run it

npm-guard supports two setups. Pick based on how much of your machine you
want it touching:

| | Scope | Catches `npm i <new-pkg>` automatically? | Touches your shell config? |
|---|---|---|---|
| **A. Just this project** | Only the folder you set it up in | Only on a bare `npm install`/`npm ci`, not on an ad-hoc add — run `npm-guard check` for those | No |
| **B. Every project on this machine** | Every terminal, every project | Yes, always | Yes — adds an `alias npm=...` to your shell rc files |

**Start with A** if you're trying npm-guard out, or you only want it guarding
one specific project without changing how `npm` behaves anywhere else on
your machine. Move to **B** once you want it on by default, everywhere,
with no per-project setup.

### A. Just this project

Install it as a dev dependency of the project you want checked. Nothing
outside this folder is touched — no shell alias, no global state:

```bash
npm install --save-dev @sahilgupta28/npm-guard-cli
```

Check the project on demand, any time:

```bash
npx npm-guard check
```

This scans everything in `package.json` and `package-lock.json` and exits
with a non-zero code if anything fails the check — run it by hand, or wire
it into CI.

To run it automatically on a plain `npm install` or `npm ci`, add it as a
`preinstall` script in this project's own `package.json`:

```json
{
  "scripts": {
    "preinstall": "npm-guard check"
  }
}
```

> **Note:** npm only runs a project's own `preinstall`/`postinstall` scripts
> for a full install (`npm install` with no arguments, or `npm ci`) — not
> when you run `npm install <new-package>` to add something new. So this
> hook protects "install everything already in `package.json`," but on its
> own it won't catch a one-off `npm install some-new-package`. Run
> `npx npm-guard check` by hand before adding a new package if you want that
> covered too without touching setup B, or move to setup B if you want new
> adds caught automatically.

### B. Every project on this machine

Install it globally and turn it on:

```bash
npm install -g @sahilgupta28/npm-guard-cli
npm-guard enable
```

Restart your terminal (or run `source ~/.bashrc` / `source ~/.zshrc`). This
adds `alias npm="npm-guard"` to your shell config, so from now on — **in
every project, every terminal session on this machine** — `npm i`,
`npm install`, `npm update`, and `npm ci` are all checked automatically
before anything installs. Everything else (`npm run`, `npm test`,
`npm start`, ...) is left completely alone.

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

This section is about setup **B** (the global alias). If you're on setup
**A**, there's no alias to undo — just remove the `preinstall` script and/or
uninstall the dev dependency from that project's `package.json`.

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

This section is about *which rules apply* (thresholds, allowlist) — not
about *whether npm-guard runs at all*, which is the setup A/B choice above.
Both setup A and setup B read the same global/project config described
below; they only differ in what triggers the check in the first place.

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

This is convenient, but it also means a project you don't fully trust yet —
one you just cloned to try out, say — can ship its own
`npm-guard.config.json` that quietly turns rules off for itself
(`"blockMalware": false`, `"minMonthlyDownloads": 0`) with no prompt. If
you'd rather a project could only make the rules *stricter* for itself (and
still add to the allowlist, just never relax a threshold), turn on strict
mode:

```bash
export NPM_GUARD_STRICT=1
```

In strict mode, a project-level or `package.json`-level override is only
applied if it makes that specific rule stricter than your global setting —
anything that would loosen it is ignored. Allowlist entries are unaffected
either way; they're always additive. Project-level *ignore* entries, however,
are dropped in strict mode — see below.

Manage either level with the same commands by adding `--project`:

```bash
npm-guard config set minMonthlyDownloads 500              # global
npm-guard config set minMonthlyDownloads 500 --project    # this repo only

npm-guard config allow some-trusted-package                # global
npm-guard config allow some-trusted-package --project      # this repo only

npm-guard config ignore my-internal-package                # global
npm-guard config ignore my-internal-package --project      # this repo only
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

## Skipping the check entirely (ignore list)

An allowlisted package is still looked up and still reported — you just see
`[BYPASSED]` with what it *would* have failed, instead of a block. If you
don't want to see it at all, put it on the **ignore list** instead: those
packages are never looked up, so there's no network call, no per-package
line, and nothing to bypass.

```bash
npm-guard config ignore my-internal-package            # every project
npm-guard config ignore my-internal-package --project  # this repo only
npm-guard config unignore my-internal-package          # start checking it again
```

Or write it straight into `npm-guard.config.json` / the `npmGuard` field:

```json
{
  "npmGuard": {
    "ignore": ["my-internal-package", "@my-company/private-sdk"]
  }
}
```

All that shows up at install time is one summary line:

```
[npm-guard] Skipping 2 ignored package(s): my-internal-package, @my-company/private-sdk
```

Good for private or internal packages that will never have public download
counts, and for a first-party monorepo package. Bad as a way to quiet a
block you don't understand — an ignored package isn't checked against the
malware feed either. If you want a package to install but still be told what
it's failing, use the allowlist above.

`npm-guard status` shows the effective ignore list. Note that **strict mode
(`NPM_GUARD_STRICT=1`) drops project-level ignore entries** and honors only
your global ones, since a repo you just cloned could otherwise skip its own
malware check silently.

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
That's setup A above — install locally, run `npm-guard check` (by hand or
via a `preinstall` script). It never touches how `npm` behaves.

**Requirements:** Node.js 18 or newer.

## License

MIT