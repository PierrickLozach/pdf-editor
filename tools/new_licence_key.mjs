// Makes a new key pair for signing Pro licences. Prints the private key (for `wrangler secret put LICENCE_KEY`)
// and the public key (to paste into web/pro.js, PUBLIC_KEY). Changing keys invalidates every licence in use.
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = await crypto.subtle.exportKey("jwk", kp.publicKey), priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
console.log("PRIVATE (secret, LICENCE_KEY):\n" + JSON.stringify(priv));
console.log("\nPUBLIC (web/pro.js PUBLIC_KEY):\n" + JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }));
