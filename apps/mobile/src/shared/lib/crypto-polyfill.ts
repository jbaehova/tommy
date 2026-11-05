import { getRandomValues } from "expo-crypto";

// Hermes has no `crypto`. The Team client reads only `getRandomValues` from it.
if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: { getRandomValues } });
