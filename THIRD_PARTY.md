# Third-party notices

AgentLeash itself is MIT-licensed (see `LICENSE`). It depends on the packages below, which keep their own licences.
Full per-package licences are in `node_modules/<package>/` after `npm ci`.

## WizardConnect — LGPL-3.0-or-later

`@wizardconnect/core`, `@wizardconnect/dapp` (runtime) and `@wizardconnect/wallet` (tests only), by Riften Labs,
<https://gitlab.com/riftenlabs/lib/wizardconnect>, licensed under the GNU Lesser General Public License v3.0 or later
(<https://www.gnu.org/licenses/lgpl-3.0.html>). Note: the npm package metadata of these packages has no `license`
field; the licence is stated in the upstream repository (`LICENSE.txt`, README "License").

* Used unmodified, as ordinary npm dependencies, in `src/wc.ts` and `web/src/owner.ts` (the WizardConnect owner path).
* The static web demo (`web/`, GitHub Pages) is a Vite bundle that includes the library code. Under LGPL-3.0 section 4
  you can replace the library with a modified version and rebuild: the complete application source is in this
  repository (MIT), the exact dependency versions are pinned in `package-lock.json`, and the bundle is produced by
  `npm ci && npm run web:build`.
* No WizardConnect source is copied into this repository.

## Build tooling (not distributed)

`lightningcss` (MPL-2.0, pulled in by Vite) is a build-time tool only; its code is not part of the published bundle.
