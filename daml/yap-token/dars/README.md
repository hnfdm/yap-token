# Vendored Splice token-standard API DARs (v1.0.0)

Build-time dependencies of `yap-token`. They are the unmodified Apache-2.0 artifacts from
<https://github.com/hyperledger-labs/splice/tree/main/daml/dars> (copied 2026-10-09/10).
Verify with `sha256sum`:

```
e2607ca3a1d735a82d3066b78132aa8f94b1886c99a5f14148742d252c7220a2 *splice-api-token-allocation-instruction-v1-1.0.0.dar
c3f3b447142577ea4fa7d912ca11cd6821de7588e324e8877425932a02fccaa1 *splice-api-token-allocation-v1-1.0.0.dar
ef75f8eb41a65810221784fdb78bb9dfac7cb22245aba14fa7cb7f69c34e0175 *splice-api-token-holding-v1-1.0.0.dar
455eb160cb5abd4ae9918a6fbb9dad471f721adda39f0e5c76feef08d05637fc *splice-api-token-metadata-v1-1.0.0.dar
e4c73aa7ae73fb2fc330b938ffb99f568792321640ba4b9472902aa8d742c994 *splice-api-token-transfer-instruction-v1-1.0.0.dar
a18e85c4841a278bce000df8329c3f0e2fee3b30b55dd6a31492d10a72b4f9c1 *splice-api-token-burn-mint-v1-1.0.0.dar
f044b34d7a28c2b6c8a540af720297d55450a889b451dc4eed64a9914f1d6b00 *splice-api-token-holding-v2-1.0.0.dar   (Token Standard V2 / CIP-0112, added 2026-10-20)
720e766456b33abdd26bfc21e54d19413559f0a7ee52000e12d3b6c308199faa *splice-api-token-transfer-instruction-v2-1.0.0.dar   (added 2026-10-20, optional BurnMintFactory interface)
```

The VPS scripts download the allocation DARs from the same location instead of shipping them.
