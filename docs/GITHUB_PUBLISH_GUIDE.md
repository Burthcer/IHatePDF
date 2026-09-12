# Publishing IHatePDF to GitHub

Step-by-step instructions to push this project to your own GitHub repository and publish `IHatePDF-Setup.exe` as a downloadable release. Run these yourself in a terminal — nothing here is automated for you.

This project is not yet a git repository on this machine, so start from step 1.

---

## 1. Documentation & Repository Setup

The repository root is already fully prepared with synchronized documentation:
- `README.md` at project root is already synchronized with `FinalApp/GitHub/README.md`.
- `HANDOFF.md` at project root is already synchronized with `FinalApp/GitHub/HANDOFF.md`.
- `.gitignore` is already created at project root, properly ignoring `node_modules/`, `dist/`, `FinalApp/`, and `test-fixtures/`.

If you ever make manual edits inside `FinalApp/GitHub/`, you can re-sync them to the root with:
```bash
copy FinalApp\GitHub\README.md README.md
copy FinalApp\GitHub\HANDOFF.md HANDOFF.md
```

## 2. Initialize the repository and make your first commit

```bash
git init
git add .
git commit -m "Initial commit: IHatePDF v1.0.0"
```

## 3. Create the GitHub repository and add it as a remote

Create an empty repository on GitHub first (via the GitHub website — do **not** initialize it with a README, since you already have one), then:

```bash
git remote add origin https://github.com/<your-username>/<your-repo-name>.git
git branch -M main
git push -u origin main
```

## 4. Tag the release

```bash
git tag -a v1.0.0 -m "IHatePDF v1.0.0"
git push origin v1.0.0
```

## 5. Create the GitHub Release and attach the installer

1. On GitHub, go to your repository → **Releases** → **Draft a new release**.
2. Choose the `v1.0.0` tag you just pushed.
3. Title: `IHatePDF v1.0.0`.
4. Body: paste the contents of [`RELEASE_NOTES.md`](./RELEASE_NOTES.md).
5. Under **Attach binaries**, drag in `FinalApp/IHatePDF-Setup.exe` from your local build.
6. Publish the release.

Your users can now download `IHatePDF-Setup.exe` directly from the Releases page — that's the link to put in your README's Installation section (the one staged at `FinalApp/GitHub/README.md` already links to `../../releases`, which resolves correctly once this is pushed).

## 6. (Optional) Rebuilding before a future release

Each time you cut a new release:

```bash
npm run build:exe
```

This produces a fresh `FinalApp/IHatePDF-Setup.exe`. Recompute its checksum and update `RELEASE_NOTES.md` before publishing:

```powershell
Get-FileHash FinalApp\IHatePDF-Setup.exe -Algorithm SHA256
```

---

## Notes

- Never commit `FinalApp/IHatePDF-Setup.exe` itself to git — it's a large binary and belongs as a Release asset, not repo history. The `.gitignore` in step 1 already excludes `FinalApp/`.
- If you push to a private repo, remember Release assets are still only visible to people with repo access — that's expected and usually what you want during development.
