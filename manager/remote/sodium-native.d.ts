// sodium-native ships no type declarations. We use a narrow, explicitly-typed
// surface (crypto_kx / crypto_generichash / crypto_aead_xchacha20poly1305_ietf
// + their byte-length constants); declaring the module keeps a strict tsc build
// clean without pulling an unmaintained @types package.
declare module "sodium-native" {
  const sodium: {
    crypto_kx_PUBLICKEYBYTES: number;
    crypto_kx_SECRETKEYBYTES: number;
    crypto_kx_SESSIONKEYBYTES: number;
    crypto_generichash_BYTES: number;
    crypto_generichash_KEYBYTES: number;
    crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
    crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
    crypto_scalarmult_BYTES: number;
    crypto_scalarmult_SCALARBYTES: number;
    crypto_box_PUBLICKEYBYTES: number;
    crypto_box_SECRETKEYBYTES: number;
    crypto_kx_keypair(pk: Buffer, sk: Buffer): void;
    crypto_kx_client_session_keys(rx: Buffer, tx: Buffer, clientPk: Buffer, clientSk: Buffer, serverPk: Buffer): void;
    crypto_kx_server_session_keys(rx: Buffer, tx: Buffer, serverPk: Buffer, serverSk: Buffer, clientPk: Buffer): void;
    crypto_generichash(out: Buffer, input: Buffer, key?: Buffer): void;
    crypto_scalarmult(out: Buffer, n: Buffer, p: Buffer): void;
    crypto_scalarmult_base(out: Buffer, n: Buffer): void;
    crypto_box_keypair(pk: Buffer, sk: Buffer): void;
    crypto_aead_xchacha20poly1305_ietf_encrypt(c: Buffer, m: Buffer, ad: Buffer | null, nsec: null, npub: Buffer, k: Buffer): number;
    crypto_aead_xchacha20poly1305_ietf_decrypt(m: Buffer, nsec: null, c: Buffer, ad: Buffer | null, npub: Buffer, k: Buffer): number;
  };
  export default sodium;
}
