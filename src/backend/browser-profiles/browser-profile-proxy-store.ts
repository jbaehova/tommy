import {
  type BrowserProfileProxyConnection,
  type BrowserProfileProxySummary,
  browserProfileProxyAddress,
  parseBrowserProfileProxy,
} from "@tommy/contracts/browser-profile-proxy";
import { sourceText } from "@tommy/i18n/source";
import { registerSecretValues } from "@tommy/logging";
import { databaseRows, requiredStringColumn } from "../database/database-rows";
import type { TommyDatabase } from "../tommy-database";

interface ProxyCipher {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
/** One encrypted address per host profile. No client or member can provide an exit connection. */
export class BrowserProfileProxyStore {
  readonly #database: TommyDatabase;
  readonly #cipher: ProxyCipher;
  constructor(database: TommyDatabase, cipher: ProxyCipher) {
    this.#database = database;
    this.#cipher = cipher;
  }
  connection(profileId: string): BrowserProfileProxyConnection | null {
    const [row] = databaseRows(
      this.#database.connection
        .prepare("SELECT encrypted_connection FROM browser_profile_proxies WHERE profile_id = ?")
        .all(profileId),
    );
    if (!row) return null;
    const address = this.#cipher.decrypt(Buffer.from(requiredStringColumn(row, "encrypted_connection"), "base64"));
    const proxy = parseBrowserProfileProxy(address);
    if (!proxy) throw new Error(sourceText("error.backend.browserProxySavedUnreadable"));
    this.#register(address, proxy);
    return proxy;
  }
  summary(profileId: string): BrowserProfileProxySummary {
    const proxy = this.connection(profileId);
    return {
      profileId,
      address: proxy ? browserProfileProxyAddress(proxy) : null,
      hasPassword: Boolean(proxy?.password),
    };
  }
  save(profileId: string, address: string | null, keepPassword = false): void {
    if (address === null) {
      this.#database.connection.prepare("DELETE FROM browser_profile_proxies WHERE profile_id = ?").run(profileId);
      return;
    }
    const proxy = parseBrowserProfileProxy(address);
    if (!proxy) throw new Error(sourceText("error.backend.browserProxyAddressInvalid"));
    if (keepPassword) {
      const saved = this.connection(profileId);
      if (
        !saved ||
        saved.scheme !== proxy.scheme ||
        saved.host !== proxy.host ||
        saved.port !== proxy.port ||
        saved.username !== proxy.username
      )
        throw new Error(sourceText("error.backend.browserProxyPasswordChanged"));
      if (proxy.password !== null) throw new Error(sourceText("error.backend.browserProxyPasswordConflict"));
      proxy.password = saved.password;
      const credentials =
        proxy.username === null
          ? ""
          : `${encodeURIComponent(proxy.username)}${proxy.password === null ? "" : `:${encodeURIComponent(proxy.password)}`}@`;
      address = `${proxy.scheme}://${credentials}${proxy.host}:${proxy.port}`;
    }
    this.#register(address, proxy);
    const encrypted = this.#cipher.encrypt(address).toString("base64");
    this.#database.connection
      .prepare(`INSERT INTO browser_profile_proxies (profile_id, encrypted_connection, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET encrypted_connection = excluded.encrypted_connection,
      updated_at = excluded.updated_at`)
      .run(profileId, encrypted, new Date().toISOString());
  }
  #register(address: string, proxy: BrowserProfileProxyConnection): void {
    if (!proxy.password) return;
    registerSecretValues(
      [
        address,
        proxy.password,
        encodeURIComponent(proxy.password),
        Buffer.from(`${proxy.username ?? ""}:${proxy.password}`).toString("base64"),
      ],
      { allowShort: true },
    );
  }
}
