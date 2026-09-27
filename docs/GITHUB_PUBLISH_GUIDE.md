# Publishing a release of IHatePDF

The project already lives on GitHub. Development happens on feature branches that get merged into `main`. This guide covers cutting a release and attaching `IHatePDF-Setup.exe` to it.

## 1. Merge the work into `main`

Open a pull request from the feature branch (for example `claude/bold-cori-o7rx16`) into `main`, review it, and merge.

## 2. Bump the version

Set `"version"` in `package.json`. The installer and Windows' *Apps & features* entry show this number. Commit it to `main`.

## 3. Build the installer

You can build it in either of two ways.

**On GitHub (no local setup):** push a tag. The **Windows installer** workflow (`.github/workflows/windows-installer.yml`) runs on `windows-latest`. It lints, runs the tests and builds the installer, then uploads it as the `IHatePDF-Setup` artifact on the workflow run.

```bash
git checkout main && git pull
git tag -a v1.1.0 -m "IHatePDF v1.1.0"
git push origin v1.1.0
```

You can also start the workflow by hand: **Actions → Windows installer → Run workflow**.

**Locally:**

```bash
npm ci
npm run build:exe        # → FinalApp/IHatePDF-Setup.exe
```

On Windows this works as-is. On Linux, electron-builder needs Wine (64- and 32-bit) to generate the uninstaller, e.g. `apt install wine64 wine32:i386` after `dpkg --add-architecture i386`.

## 4. Create the GitHub Release

1. Go to **Releases → Draft a new release** and pick the tag.
2. Title it `IHatePDF v1.1.0`, and paste the matching section of [`RELEASE_NOTES.md`](./RELEASE_NOTES.md) as the body.
3. Attach `IHatePDF-Setup.exe`, either downloaded from the workflow artifact (it comes zipped) or from your local `FinalApp/`.
4. Publish.

Optionally, add a checksum to the release notes:

```powershell
Get-FileHash IHatePDF-Setup.exe -Algorithm SHA256
```

## Notes

- Never commit the installer or `FinalApp/` to git. They are large binaries that belong on the Releases page, and `.gitignore` excludes them.
- The installer isn't code-signed, so Windows SmartScreen shows *“Windows protected your PC”* the first time. Users click **More info → Run anyway**. Signing it requires a code-signing certificate (set `CSC_LINK` / `CSC_KEY_PASSWORD` for electron-builder).
- Installing a new version over an old one replaces the app in place. Saved files in `Downloads\IHatePDF` are never touched.
