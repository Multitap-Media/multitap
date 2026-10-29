/**
 * The engine most tests run against: `home`, a QuickSync mini-PC that does
 * 1080p live with tone mapping. Multitap seeds no engine, so tests add it.
 */
import { PrivateHostGuard } from '@multitap/addon-protocol';
import type { EngineDescriptor } from '@multitap/api';
import type { Db } from '../src/db/index.ts';
import { putEngine } from '../src/engines/index.ts';

export const HOME_ENGINE: EngineDescriptor = {
  id: 'home',
  name: 'Home',
  transport: 'lan',
  address: null,
  capabilities: {
    hwaccel: 'qsv',
    liveMaxHeight: 1080,
    preparedMaxHeight: 2160,
    tonemap: true,
    sessionOverrides: true,
    liveConcurrency: 2,
    prepareConcurrency: 1,
  },
  localAddon: false,
};

/** Adds {@link HOME_ENGINE}, with no address. */
export async function addHomeEngine(db: Db): Promise<void> {
  const { id, ...input } = HOME_ENGINE;
  await putEngine(db, id, input);
}

/**
 * A private-host guard whose host names all resolve to one public address, so
 * engine-module tests never use DNS. IP literals are checked as usual.
 */
export const PUBLIC_DNS_GUARD = new PrivateHostGuard({
  lookup: (_host, _options, callback) => {
    callback(null, [{ address: '93.184.215.14', family: 4 }]);
  },
});
