# Publishing a release

Releases are automatic: push a version tag, and GitHub builds the Windows installer and publishes it.

1. **Update the version and notes on `main`.** Set `"version"` in `package.json` and rewrite `docs/RELEASE_NOTES.md` for the new version. That file becomes the release page, so keep its *Install* section.
2. **Tag and push:**
   ```bash
   git checkout main && git pull
   git tag v1.2.0
   git push origin v1.2.0
   ```
3. **Wait about 5 minutes.** The **Windows installer** workflow (`.github/workflows/windows-installer.yml`) runs on Windows:
   1. lint;
   2. tests;
   3. `npm run build:exe`;
   4. it creates the *IHatePDF v1.2.0* release with `IHatePDF-Setup.exe` attached, marked as the latest.

The README's **Download for Windows** button links to `releases/latest/download/IHatePDF-Setup.exe`, so it always serves the newest release. Nothing needs editing.

## Building the installer by hand

```bash
npm ci
npm run build:exe        # → FinalApp/IHatePDF-Setup.exe
```

On Linux, electron-builder needs Wine to generate the uninstaller: `dpkg --add-architecture i386 && apt install wine64 wine32:i386`.

Pushes to `main` or `claude/**` branches also build the installer, without publishing it. You can download it from that workflow run's *Artifacts* section.

## Notes

- Never commit the installer or `FinalApp/`. `.gitignore` excludes them.
- The installer isn't code-signed, so SmartScreen shows *"Windows protected your PC"* on first run, and users click **More info → Run anyway**. To sign it, provide a certificate through `CSC_LINK` / `CSC_KEY_PASSWORD` secrets and remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` from the workflow.
- Screenshots in `docs/screenshots/` are regenerated with `node scripts/e2e/screenshots.mjs`.
