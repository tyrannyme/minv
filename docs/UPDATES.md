# Signed updates and offline rollback

Minv now has independently testable release-authentication and installation mechanisms in `src/core/update.ts`. They do not start a network request, extract an archive, execute code, change the running app, or restart anything. **No publisher signing key, trusted public key, update feed, or operational update service has been supplied.** Those remain external release inputs. Generated test keys are ephemeral fixtures and are never production trust anchors.

## Publisher contract

A detached Ed25519 signature covers the exact canonical JSON manifest, including:

- Product `minv`, manifest schema, exact semantic version, Linux x64 platform, and a strictly increasing release sequence.
- Exact archive filename, byte length, and SHA-256.
- The complete sorted file inventory: relative path, exact byte length, SHA-256, and executable flag.

The signature envelope contains only the canonical payload and its base64 signature. It does not supply a trusted public key. Verification requires an independently configured Ed25519 publisher key; missing keys, another algorithm/key, noncanonical JSON, duplicate metadata, wrong platforms, and unsigned input fail closed. Product identity inside the signed package must match the manifest version.

The separate signing command first runs the packaging audit. It requires an explicit private-key file and sequence, refuses to overwrite an output, and places metadata outside the immutable audited package tree:

```sh
node scripts/update-release.mjs sign \
  --directory build/release/minv-0.2.0-linux-x64 \
  --artifact build/release/minv-0.2.0-linux-x64.tar.gz \
  --private-key /publisher-controlled/ed25519-private.pem \
  --sequence 1 \
  --output build/release/minv-0.2.0-linux-x64.signed.json

node scripts/update-release.mjs verify \
  --manifest build/release/minv-0.2.0-linux-x64.signed.json \
  --public-key /independently-trusted/ed25519-public.pem
```

These paths illustrate required operator inputs; no key is generated, downloaded, or embedded by the commands. Compile project tooling first. Private keys must remain outside release artifacts, source control, logs, and application user data. Trust-anchor rotation is an out-of-band publisher decision; this mechanism deliberately rejects an installation ledger opened with a different key.

## Offline installation store

Construct `UpdateStore` with a dedicated private directory, the independently trusted public key, the real installed version, and `platform: 'linux-x64'`. Its methods are:

- `stage(envelope, artifactPath, extractedDirectory)` verifies the signature, complete archive bytes, exact extracted inventory, and embedded product version. It copies each file into a new private staging tree while checking its hash again, syncs files/directories, seals files and directories read-only, then records the verified release. Symlinks, special files, extra files, path traversal, changed input, and inconsistent executable bits fail closed. Existing releases are never overwritten.
- `list()` re-verifies every retained receipt and payload before returning version/sequence/current metadata.
- `activate(id, safety)` selects only the latest verified upgrade. A single atomic relative-symlink rename changes `current` after validation; it never rewrites the running application directory.
- `rollback(id, safety, true)` explicitly selects an older previously verified retained release, re-verifying its signature, hashes, and sealed file permissions. This works offline and requires confirmation.

The private, owner-only ledger retains the highest accepted sequence and version. A normal stage rejects replay, same-version republishing, lower sequences, and downgrades. Explicit rollback does **not** lower that floor, so a replayed old feed cannot become a normal update afterward. The ledger is tied to the publisher key fingerprint. Missing/corrupt state in a populated installation fails closed rather than silently resetting trust or replay protection.

Installation operations use an exclusive directory lock. A leftover lock after a crash is not deleted automatically; an operator must establish that no updater is active before removing it. Fully written but unregistered release directories can remain after an interrupted final ledger write; they are not eligible for activation. Retention is bounded to 32 verified releases and 4 GiB per expanded release; explicit retention management is a host/operator responsibility. No background cleanup deletes a rollback candidate.

## Explicit update and installer commands

Compile the project first. Only an explicit `stage` command fetches a feed. The HTTPS feed returns the detached signed JSON envelope. The archive must be at the same origin and adjacent URL path, with the exact signed filename. Redirects, HTTP, URL credentials, altered signatures, oversized metadata, partial/oversized archives, and mismatched archive hashes fail closed. The public key comes from an independent trusted file, never the feed. No production feed or key is included.

```sh
node scripts/update-install.mjs stage --feed https://publisher.example/minv/latest.json \
  --public-key /independently-trusted/ed25519-public.pem \
  --store /private/minv-install --current-version 0.1.0
node scripts/update-install.mjs list --public-key /independently-trusted/ed25519-public.pem \
  --store /private/minv-install --current-version 0.1.0
```

The built-in streaming tar.gz reader extracts into a new private temporary directory after download authentication. It accepts only regular files and directories under the signed release root, checks tar headers and each file against the signed inventory, and rejects links, devices, traversal, duplicate or extra files. `stage` repeats archive and file verification while copying into the retained store, then removes the temporary download. The CLI does not automatically check, install, or restart.

After Minv closes normally and all of its cleanup completes, the installer process acquires an exclusive gate shared with application launch. The gate prevents a new launch while it re-verifies and atomically selects the release. Use the `id` returned by `stage` or `list`:

```sh
node scripts/update-install.mjs activate --id RELEASE_ID \
  --public-key /independently-trusted/ed25519-public.pem \
  --store /private/minv-install --current-version 0.1.0 \
  --user-data /home/USER/.config/Minv
node scripts/update-install.mjs rollback --id OLDER_RELEASE_ID \
  --public-key /independently-trusted/ed25519-public.pem \
  --store /private/minv-install --current-version 0.1.0 \
  --user-data /home/USER/.config/Minv --confirm yes
```

`--user-data` must match the running application's actual data directory (`MINV_USER_DATA` when configured, otherwise its Minv user-data path). The main process holds an application lease through normal close and active-write cleanup; the launcher holds one across process handoff. A stale lease after a crash blocks installation because dirty recovery may need review. Inspect recovery drafts in Minv, confirm the old process is gone, then explicitly clear only dead Minv lease markers with `node scripts/update-install.mjs recover-gate --user-data DIR --clear yes`. This command reports whether recovery data exists and never deletes it. A crashed installer lock also fails closed and requires operator inspection. No command accepts a caller-supplied “closed” or “zero writes” assertion.

The portable launcher must resolve the stable `current` link to the selected release and use its real directory. Existing portable installations are not silently migrated. Unsigned older packages cannot be enrolled as verified rollback candidates. User settings and recovery data remain separate from all retained application releases.

## Verification and release status

Tests cover signature/key/metadata tampering, wrong platforms, canonicalization, semantic-version ordering, bounded HTTPS transfer, archive and extracted-file changes, tar link rejection, symlink/extra-file rejection, immutable staging, atomic pointer selection, replay/downgrade protection across restart and rollback, tampered rollback candidates, missing trust state, and application/dirty-buffer/write gates.

Passing these tests establishes the authentication, transfer, extraction, gate, and retained-store mechanisms. SEC-06's public distribution gate still requires a real publisher key and key-management policy, HTTPS publishing infrastructure, package signing in the actual release process, and end-to-end update/rollback verification of the real package on supported Linux x64 machines. The stable installed launcher must resolve the retained `current` pointer; existing portable installations are not silently migrated. There is no unsigned fallback.
