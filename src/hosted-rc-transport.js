import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomBytes } from "node:crypto";
import {
  HOSTED_RC_ENVELOPE_MAX_BYTES, hostedRcCanonicalJson, normalizeHostedRcObservation,
  rcFail, rcOrigin, verifyHostedRcProof,
} from "./hosted-rc-evidence.js";

/** Only RFC1918/ULA destinations can be explicitly authorized as private RCs.
 * Loopback, link-local, metadata, multicast and transition ranges never qualify. */
export function hostedAddressClass(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0)
      || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0)) rcFail("deployment_mismatch");
    return "public";
  }
  if (isIP(address) === 6) {
    const v = address.toLowerCase();
    if (/^f[cd]/.test(v)) return "private";
    const [first, second] = v.split(":");
    if (!/^[23][0-9a-f]{3}:/.test(v) || first === "2002" || first === "3fff"
      || (first === "2001" && (parseInt(second || "0", 16) <= 0x1ff || second === "db8"))) rcFail("deployment_mismatch");
    return "public";
  }
  rcFail("deployment_mismatch");
}

function bounded(promise, timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("observation_stale"), { code: "observation_stale" })), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

/** Actual TLS request, pinned to previously validated DNS. No fetch redirect,
 * proxy, caller executable, URL credentials, arbitrary path or TLS bypass. */
export async function observeHostedRc({ origin, policy, productionOrigins, observerKeys, certificateAuthorityPem = null }) {
  const normalizedOrigin = rcOrigin(origin);
  if (normalizedOrigin !== origin || !policy.allowedOrigins.includes(origin)
    || productionOrigins.includes(origin)) rcFail("deployment_mismatch");
  const url = new URL(origin);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const started = Date.now();
  let addresses;
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
      : await bounded(lookup(hostname, { all: true, verbatim: true }), 5000);
  } catch { rcFail("untrusted_observation"); }
  if (!addresses.length || addresses.length > 16) rcFail("deployment_mismatch");
  const classes = addresses.map(({ address }) => hostedAddressClass(address));
  if (classes.includes("private") && !policy.allowedPrivateOrigins.includes(origin)) rcFail("deployment_mismatch");
  const chosen = addresses[0];
  const addressClass = classes[0];
  const nonce = randomBytes(32).toString("hex");
  const timeoutMs = Math.max(1, 5000 - (Date.now() - started));
  const envelope = await new Promise((resolve, reject) => {
    let timer;
    const fail = () => reject(Object.assign(new Error("untrusted_observation"), { code: "untrusted_observation" }));
    const request = https.get({
      protocol: "https:", hostname, port: url.port || 443,
      path: `/.well-known/studioops/hosted-rc?nonce=${nonce}`,
      agent: false, rejectUnauthorized: true,
      ...(certificateAuthorityPem ? { ca: certificateAuthorityPem } : {}),
      lookup: (_name, options, callback) => callback(null, ...(options.all ? [[chosen]] : [chosen.address, chosen.family])),
      headers: { accept: "application/json", "cache-control": "no-store" },
    }, (response) => {
      if (response.statusCode !== 200 || response.headers.location
        || !/^application\/json(?:\s*;|$)/i.test(response.headers["content-type"] || "")
        || response.headers["content-encoding"] || Number(response.headers["content-length"] || 0) > HOSTED_RC_ENVELOPE_MAX_BYTES) {
        response.destroy(); request.destroy(); fail(); return;
      }
      let bytes = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > HOSTED_RC_ENVELOPE_MAX_BYTES) { response.destroy(); request.destroy(); fail(); }
        else chunks.push(chunk);
      });
      response.on("error", fail);
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { fail(); }
      });
    });
    timer = setTimeout(() => { request.destroy(); fail(); }, timeoutMs);
    request.on("error", fail);
    request.on("close", () => clearTimeout(timer));
  });
  hostedRcCanonicalJson(envelope);
  if (!envelope || Object.keys(envelope).sort().join() !== "nonce,payload,proof,transportProof"
    || envelope.nonce !== nonce) rcFail("untrusted_observation");
  const payload = normalizeHostedRcObservation(envelope.payload);
  if (payload.origin !== origin || payload.resolvedAddressClass !== addressClass) rcFail("deployment_mismatch");
  verifyHostedRcProof("observation", payload, envelope.proof, observerKeys);
  verifyHostedRcProof("observation-response", { nonce, payload, proof: envelope.proof }, envelope.transportProof, observerKeys);
  if (envelope.proof.keyId !== envelope.transportProof.keyId) rcFail("untrusted_observation");
  return { payload, proof: envelope.proof };
}
