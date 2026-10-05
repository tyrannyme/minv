import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { git, pin, upstream, verifyPin } from './upstream-lib.mjs';

// No package managers or downloaded executable helpers are involved.
try {
  if (!existsSync(upstream)) {
    mkdirSync(dirname(upstream), { recursive: true });
    git(['init', upstream], dirname(upstream));
    git(['remote', 'add', 'origin', pin.repository]);
    git(['fetch', '--depth=1', 'origin', pin.commit]);
    git(['checkout', '--detach', pin.commit]);
  }
  verifyPin();
  console.log(`Verified Code-OSS ${pin.tag} at ${pin.commit}\n${upstream}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
