/**
 * Everything the Bitcoin chain adapter offers, in one namespace.
 *
 *   import * as bitcoin from "../chains/bitcoin/index.js";
 *   bitcoin.parseBitcoinAddress(...)
 *   bitcoin.deriveDepositKey(...)
 *
 * This file imports the leaves; the leaves must never import this file, or
 * the cycle fails at runtime in ways that are hard to trace.
 */
export * from "./address.js";
export * from "./blockbook.js";
export * from "./extended-key.js";
export * from "./platform-key.js";
