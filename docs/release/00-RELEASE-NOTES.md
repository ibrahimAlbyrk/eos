# Release notes — rules and template

Every release's notes live in `docs/release/notes/v<version>.md` and are written
from this file. `scripts/release.sh` publishes that file as the GitHub release:
its first line (`# …`) is the release title, the rest is the body.

## Rules

1. **Title:** `Eos <version> — <theme>`. The theme is the release's most important
   user-facing change, at most 6 words, no emoji. E.g. `Eos 0.2.0 — Faster agents on Windows`.
2. **Language:** English, written for the people who use Eos — no commit
   messages, file names or internal terms.
3. **Sections, always in this order; leave out the empty ones:** summary ·
   Downloads · Highlights · New · Improved · Fixed · Removed · Known issues ·
   Install & upgrade · Full changelog.
4. **Summary:** one or two sentences — what this release means for someone using Eos.
5. **Bullets:** one change per bullet, one line each. Say what changed first, then
   why it matters if that isn't obvious.
6. **Highlights:** at most 4. Each is a **bold lead** followed by one sentence.
7. **Platform tags:** a change that applies to one system ends with `(macOS)`,
   `(Windows)` or `(iPhone)`. A change everywhere has no tag.
8. **Where the content comes from:** the commits since the previous tag
   (`git log v<prev>..HEAD`).
   - `feat` → New.
   - `fix` → Fixed.
   - `refactor` / `perf` that a user notices → Improved.
   - A feature taken away → Removed.
   - `ci`, `test`, `docs`, `chore` — left out unless a user sees the change.
   - Several commits that make one change are one bullet.
9. **Known issues are honest:** unsigned builds, what isn't on a system yet,
   anything not verified.
10. **Downloads:** one row per platform with its file(s) and the one thing to know
    when installing it. File names match the release assets exactly.
11. **First release:** "What's in Eos" (what Eos does, briefly) takes the place of
    New / Improved / Fixed, and the changelog line says it's the first release.
12. **Versions:** semver. The desktop app and the iPhone app share the version.

## Template

```markdown
# Eos <version> — <theme>

<One or two sentences: what this release means for someone using Eos.>

### Downloads
| Platform | File | Note |
|---|---|---|
| macOS (Apple Silicon) | `Eos-darwin-arm64.zip` | Signed and notarized |
| Windows x64 | `Eos-Setup-x64.exe` · `Eos-win32-x64.zip` | Unsigned — on first run choose **More info → Run anyway** |
| Windows ARM64 | `Eos-Setup-arm64.exe` · `Eos-win32-arm64.zip` | Unsigned — same as above |
| iPhone (Eos Remote) | `Eos-Remote-iOS-source.zip` | Build it with your own Apple ID — see Install |

### Highlights
- **<Lead>.** <One sentence.>

### New
- <Change> (<platform, when only one>)

### Improved
- <Change>

### Fixed
- <Change>

### Removed
- <Change>

### Known issues
- <Issue> (<platform>)

### Install & upgrade
- **macOS:** unzip and move `Eos.app` to Applications.
- **Windows:** run `Eos-Setup-<arch>.exe` — it installs for your user, no admin rights needed.
- **iPhone:** unzip `Eos-Remote-iOS-source.zip` and follow `ios/BUILD.md` (Xcode + your own Apple ID).
- **Updating:** Eos 0.1.3 and later update themselves — only what changed is downloaded, and Eos asks before it restarts. (macOS)

**Full changelog:** https://github.com/ibrahimAlbyrk/eos/compare/v<prev>...v<version>
```
