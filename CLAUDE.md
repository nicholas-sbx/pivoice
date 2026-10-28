# Pivoice

Voice rooms around a round table. Three parts, released separately:

- **The site** (`src/`, Vue + Vite): the UI, and in a browser the audio too.
- **The Worker** (`worker/`, Cloudflare): the rooms (a Durable Object each) and `/api/*`.
  Static files are served by Workers static assets, not the Worker; their
  headers come from `public/_headers`.
- **The app** (`native/`, Go): opens the site in the system webview and does the
  audio natively. See the README's "The app" section.

## Versions and releases

- The site's version is `package.json`'s; the app's is `native/VERSION`.
- **A version bump is always its own commit, pushed straight to `main`, never
  part of a PR.** PRs leave `package.json`'s version and `native/VERSION` alone.
  Merge the PRs first, then bump on `main` in a commit that changes only the
  version (`npm version X.Y.Z --no-git-tag-version` for the site, which also
  updates `package-lock.json`; edit `native/VERSION` for the app), with a
  message like `Release site 0.7.2` or `Release app 0.2.1`.
- That push is the release: CI tags the version (`vX.Y.Z` for the site,
  `native-vX.Y.Z` for the app) and publishes it (`.github/workflows/release-web.yml`,
  `release-native.yml`), so there's no need to tag by hand.
- Bump both in one commit only when they have to go out together (the site's
  deploy waits for the app release it points to).
- When the bridge between page and app changes incompatibly, bump
  `NATIVE_PROTOCOL` (`src/native/protocol.ts`) and `Protocol`
  (`native/internal/proto/proto.go`) together, in the PR that changes it.

## Checks

Site and Worker:

```sh
npm test                  # vitest
npm run typecheck         # the site
npm run typecheck:worker
npm run dev               # site + Worker, for the e2e runs
npm run e2e               # Chromium tabs in rooms, a phone included
npm run e2e:native        # the app headless with the site (build it first)
```

The app (`native/`):

```sh
./build.sh                # builds without noise suppression if RNNoise isn't found
build/deps.sh rnnoise     # RNNoise 0.2, patched (see build/rnnoise-lookahead.patch)
PKG_CONFIG_PATH=$PWD/build/deps/lib/pkgconfig:$PWD/build/pkgconfig go test -race ./...
```

CI checks the app on every branch that touches `native/`; the site is only
built and deployed from `main`, so run its checks yourself before merging.

## Conventions

- Match the Discord look, flat and sharp: no gradients, no blurred shadows,
  hard 1px edges (README, "Flat and sharp").
- Nothing on the audio thread allocates (tests hold the mixer and the
  processing chain to zero).
- Optional processing costs nothing while it's off.
- Phones: nothing may run past the screen's edge; the e2e run's phone measures it.
