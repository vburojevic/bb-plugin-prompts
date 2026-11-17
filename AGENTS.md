# Prompts (bb plugin)

A bb plugin: prompt queue, snippets and quick replies. The README's layout section maps the code.

## vstack
- Landing: pr-squash (feature PRs squash-merge; `release:` commits go straight to main)
- Release authority: ask
- Platforms: bb-plugin (desktop and phone UI)
- Verify: `npm run typecheck`, `npm test`, `npm run build` (runs `bb plugin build`). Check UI on an isolated dev bb, never the bb you work in:
  - Start bb's bundled `bb-app.js` with its own `--data-dir`, `--server-port` and `--host-daemon-port`, and point the CLI at it (`BB_DATA_DIR`, `BB_SERVER_URL`, `BB_HOST_DAEMON_PORT`).
  - Install this checkout there with `bb plugin install <path> --yes`.
  - Drive it with Playwright run from this repo, at 1100 px and 390 px wide, light and dark. `npm run screenshots` captures the queue and snippet README images (its header has the setup).
- Release: bump `package.json` and `package-lock.json` (`npm version <x.y.z> --no-git-tag-version`), `npm run build`, commit `release: vX.Y.Z <name>` on main and push. Tag `vX.Y.Z`, push the tag, and `gh release create vX.Y.Z` with notes and no assets. The bb Community marketplace installs from tags `>=0.2.0`: on a fresh isolated bb, `bb plugin install prompts --yes` must report the new version. Then `bb plugin reload prompts` where this checkout is installed.
- Review bots: none
