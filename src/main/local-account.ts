import { EventEmitter } from "node:events";
import type { CentralAuthState, CentralAuthUser } from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { Effect } from "effect";

interface LocalAccountEvents {
  changed: [state: CentralAuthState];
}

/**
 * The one person of Tommy. There is no account service: the owner is signed in on the server, and
 * on a client while it is paired with the server.
 */
export class LocalAccount extends EventEmitter<LocalAccountEvents> {
  readonly #owner: CentralAuthUser;
  readonly #active: () => boolean;
  #state: CentralAuthState;

  constructor(options: { owner: CentralAuthUser; active: () => boolean }) {
    super();
    this.#owner = options.owner;
    this.#active = options.active;
    this.#state = this.#read();
  }

  #read(): CentralAuthState {
    return this.#active() ? { status: "signed_in", user: this.#owner } : { status: "signed_out" };
  }

  getState(): CentralAuthState {
    return structuredClone(this.#state);
  }

  getSignedInUser(): CentralAuthUser {
    if (this.#state.status !== "signed_in") throw new Error(sourceText("error.auth.signInFirst"));
    return structuredClone(this.#state.user);
  }

  /** Reads the pairing again and tells the listeners when it changed. */
  refresh(): CentralAuthState {
    const next = this.#read();
    if (next.status !== this.#state.status) {
      this.#state = next;
      this.emit("changed", this.getState());
    }
    return this.getState();
  }

  initialize(): Effect.Effect<CentralAuthState> {
    return Effect.sync(() => this.refresh());
  }
}
