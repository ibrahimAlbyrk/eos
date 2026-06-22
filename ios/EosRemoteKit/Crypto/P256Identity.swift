import Foundation
import CryptoKit

// P-256 static-identity signatures (§1.2). Wire encodings are LOCKED: pubkey = 65-byte SEC1
// (x963Representation), signature = 64-byte raw r‖s (rawRepresentation), never DER.
public enum P256Identity {
    public enum IdentityError: Error { case badPublicKey, badSignature }

    // Verify a Mac (or any P-256) signature over the raw message bytes (ECDSA internally SHA-256s).
    public static func verify(message: Data, signature sig: Data, publicKeySEC1 pub: Data) throws -> Bool {
        let key = try P256.Signing.PublicKey(x963Representation: pub)
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: sig)
        return key.isValidSignature(signature, for: message)
    }
}
