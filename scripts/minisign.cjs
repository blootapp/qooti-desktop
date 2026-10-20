"use strict";

// Checks a `tauri signer` (minisign) signature exactly the way bloot apps does
// before it installs anything (bloot-apps/src-tauri/src/sigverify.rs). Copied from
// bloot-export/dev/minisign.js. fetch-bloot-apps.mjs runs it, so a bloot apps build
// signed with the wrong key never ships inside qooti.

const crypto = require("crypto");

/** The bloot release key. bloot apps, Lynk and qooti trust only this one. */
const RELEASE_KEY_ID = "EEA7FDAA90E695B3";
const RELEASE_PUBKEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEVFQTdGREFBOTBFNjk1QjMKUldTemxlYVFxdjJuN29FYUxhTlRTM2xUdmZRYVV4K3dubmxBT1pobFJXV2tNY3BRbjVDQmswODEK";

/** The release key is being replaced (2026-10): bloot apps trusts the old key above and
 *  the new one, bloot-release-2026 (34FC69E4F0DD5A41). New releases should use the new one. */
const NEW_RELEASE_KEY_ID = "34FC69E4F0DD5A41";
const TRUSTED_PUBKEYS = [
  RELEASE_PUBKEY,
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM0RkM2OUU0RjBERDVBNDEKUldSQld0M3c1R244TkhtbkJKcGxxZm1TNCtKa1p5RWpBODVIUEtHOHBjZkxtODh1cWVPNzJIMHIK",
];

// DER prefix that turns a raw 32-byte Ed25519 key into an SPKI public key.
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** A .pub / .sig file as tauri writes it: base64 of the minisign text. */
function textLines(b64) {
  return Buffer.from(String(b64 || "").trim(), "base64").toString("utf8").split(/\r?\n/);
}

/** minisign prints key ids as the little-endian number, in hex. */
function keyId(bytes) {
  return Buffer.from(bytes.subarray(2, 10)).reverse().toString("hex").toUpperCase();
}

function edVerify(message, key, signature) {
  try {
    return crypto.verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/**
 * Throws an Error with a readable reason unless `signature` (the base64 .sig
 * text) is a valid signature of `data` by `pubkey` (the base64 .pub text).
 * Returns the key id it was signed with.
 */
function verifySignature(data, signature, pubkey) {
  const lines = textLines(signature);
  if (lines.length < 4) throw new Error("unreadable signature");
  const sig = Buffer.from(lines[1].trim(), "base64"); // algorithm (2) + key id (8) + signature (64)
  if (sig.length !== 74) throw new Error("unreadable signature");

  // Without an explicit key: whichever trusted key the signature names (like bloot apps).
  const keys = (pubkey ? [pubkey] : TRUSTED_PUBKEYS)
    .map(k => Buffer.from((textLines(k)[1] || "").trim(), "base64")) // "Ed" + key id (8) + key (32)
    .filter(k => k.length === 42);
  if (!keys.length) throw new Error("unreadable public key");
  const pk = keys.find(k => sig.subarray(2, 10).equals(k.subarray(2, 10)));
  if (!pk) throw new Error(`signed with key ${keyId(sig)}, not ${keys.map(keyId).join(" or ")}`);
  const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, pk.subarray(10)]), format: "der", type: "spki" });

  // Prehashed ("ED") signatures sign BLAKE2b-512 of the file.
  const message = sig.subarray(0, 2).toString("latin1") === "ED"
    ? crypto.createHash("blake2b512").update(data).digest()
    : data;
  if (!edVerify(message, key, sig.subarray(10))) throw new Error("the file doesn't match its signature");

  const trusted = lines[2].startsWith("trusted comment: ") ? lines[2].slice("trusted comment: ".length) : "";
  const global = Buffer.from(lines[3].trim(), "base64");
  if (!edVerify(Buffer.concat([sig.subarray(10), Buffer.from(trusted, "utf8")]), key, global)) {
    throw new Error("the signature's comment was altered");
  }
  return keyId(pk);
}

module.exports = { RELEASE_KEY_ID, RELEASE_PUBKEY, NEW_RELEASE_KEY_ID, TRUSTED_PUBKEYS, verifySignature };
