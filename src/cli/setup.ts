/**
 * `npm run setup` — first-run checks, in plain language.
 *
 * Creates the folders and the config file, then tells you exactly what is still
 * missing. It never writes secrets and never contacts LINE.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureRuntimeDirs,
  invalidRecipients,
  loadConfig,
  PATHS,
  readLineCredentials,
  watchConfigPath,
} from '../config.js';
import { LineNotifier } from '../notification/line.js';
import { userAgent } from '../checker/http.js';
import { isPathAllowed, loadRobots } from '../checker/robots.js';
import { buildSearchUrl, RESERVE_ORIGIN } from '../checker/url.js';
import { describeError } from '../redact.js';

const ok = (msg: string): void => {
  process.stdout.write(`  ✅ ${msg}\n`);
};
const warn = (msg: string): void => {
  process.stdout.write(`  ⚠️  ${msg}\n`);
};
const bad = (msg: string): void => {
  process.stdout.write(`  ❌ ${msg}\n`);
};

export async function runSetupCommand(): Promise<number> {
  const out = process.stdout;
  out.write('\nMiracosta Monitor — setup\n\n');

  // 1. Environment ----------------------------------------------------------
  out.write('1) Your machine\n');
  ok(`Node.js ${process.version} at ${process.execPath}`);
  ok(`Platform ${process.platform} / ${os.arch()}`);
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major < 20) {
    bad('Node.js 20 or newer is required. Install it with:  brew install node');
    return 1;
  }
  if (process.platform !== 'darwin') {
    warn('This is not macOS — the launchd service commands will not work here.');
  }

  // 2. Folders --------------------------------------------------------------
  out.write('\n2) Folders\n');
  ensureRuntimeDirs();
  ok(`data/ logs/ debug/ are ready under ${PATHS.root}`);

  // 3. Watch config ---------------------------------------------------------
  out.write('\n3) Monitoring conditions (config/watch.json)\n');
  const target = watchConfigPath();
  const example = path.join(PATHS.config, 'watch.example.json');
  if (!fs.existsSync(target)) {
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, target);
      ok(`Created ${path.relative(PATHS.root, target)} from the example file`);
    } else {
      bad(`Neither ${target} nor the example file exists.`);
      return 1;
    }
  } else {
    ok(`${path.relative(PATHS.root, target)} exists`);
  }

  let config;
  try {
    config = loadConfig();
    ok(
      `${config.watches.length} watch condition(s) loaded, interval ${config.settings.intervalMinutes} min`,
    );
    for (const w of config.watches) {
      const filter = w.roomKeywords.length > 0 ? w.roomKeywords.join(' AND ') : '(any room)';
      out.write(
        `     • ${w.id}: ${w.checkIn}, ${w.nights} night(s), ${w.adults} adult(s) — ${filter}\n`,
      );
    }
  } catch (err) {
    bad(
      `config/watch.json is not valid:\n     ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  // 4. LINE -----------------------------------------------------------------
  out.write('\n4) LINE notification settings (.env)\n');
  if (!fs.existsSync(PATHS.env)) {
    warn('.env does not exist yet. Create it with:');
    out.write('       cp .env.example .env\n');
    out.write('     Then open .env and paste your two LINE values (README steps 5-10).\n');
  } else if (readLineCredentials() === null) {
    warn('.env exists but the LINE settings are incomplete.');
    out.write('     Needed: LINE_CHANNEL_ACCESS_TOKEN, plus LINE_BROADCAST=1 or LINE_TO\n');
    out.write('     Fill them in following README steps 5-10, then run:  npm run test-line\n');
  } else {
    ok(`LINE is configured — notifications go to: ${LineNotifier.describeRecipients()}`);
    const bad = invalidRecipients(readLineCredentials()?.recipients ?? []);
    if (bad.length > 0) {
      warn(`${bad.length} recipient id(s) are malformed (expected U/C/R + 32 hex characters).`);
    }
    out.write('     Verify it actually works with:  npm run test-line\n');
  }

  // 5. Official site --------------------------------------------------------
  out.write('\n5) Official reservation site\n');
  const firstWatch = config.watches[0];
  if (!firstWatch) {
    bad('No watch conditions found.');
    return 1;
  }
  const sampleUrl = buildSearchUrl(firstWatch);
  out.write(`     Search URL that will be used:\n     ${sampleUrl}\n`);
  try {
    const robots = await loadRobots(RESERVE_ORIGIN, userAgent());
    const target2 = new URL(sampleUrl);
    const allowed = isPathAllowed(robots, target2.pathname + target2.search);
    if (robots.assumedAllowed) {
      warn('robots.txt could not be read right now (network?). It is re-checked automatically.');
    } else if (allowed) {
      ok(
        `robots.txt allows this path${robots.crawlDelaySeconds !== null ? ` (Crawl-delay ${robots.crawlDelaySeconds}s, which will be honoured)` : ''}`,
      );
    } else {
      bad('robots.txt DISALLOWS this path. The monitor will refuse to check it.');
      out.write('     Nothing to do here except respect it — do not work around this.\n');
    }
  } catch (err) {
    warn(`Could not check robots.txt: ${describeError(err)}`);
  }

  // 6. Next steps -----------------------------------------------------------
  out.write('\nNext steps\n');
  out.write('  1. npm run test-line      # confirm LINE works\n');
  out.write('  2. npm run check          # one real availability check\n');
  out.write('  3. npm run install-service # run it 24/7 in the background\n\n');
  return 0;
}
